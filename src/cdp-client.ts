// CDP Client wrapper for Comet browser control
// Modified for Windows/WSL support

import CDP from "chrome-remote-interface";
import { spawn, ChildProcess, execSync } from "child_process";
import { platform } from "os";
import { existsSync } from "fs";
import type {
  CDPTarget,
  CDPVersion,
  NavigateResult,
  ScreenshotResult,
  EvaluateResult,
  CometState,
  TabContext,
} from "./types.js";

// chrome-remote-interface@^0.34.0 exposes `ProtocolError` at runtime
// (`module.exports.ProtocolError = ...`), but @types/chrome-remote-interface
// doesn't declare it yet. Cast at import so `instanceof` typechecks; remove
// the cast once DefinitelyTyped/DefinitelyTyped#74992 lands and we pick up
// the updated @types.
interface CdpProtocolError extends Error {
  request: { method: string; params?: unknown };
  response: CDP.SendError;
}
const ProtocolError = (CDP as unknown as {
  ProtocolError: new (...args: unknown[]) => CdpProtocolError;
}).ProtocolError;

// Hidden targets (e.g. the Perplexity sidecar panel) can report a 0x0 layout
// viewport in some Comet window states (cold launch, no real browsing tabs in
// front). When that happens, Page.captureScreenshot waits for compositor
// frames that never arrive and stalls for ~2 minutes. Detecting that state
// via Page.getLayoutMetrics() and supplying an explicit clip +
// captureBeyondViewport=true makes the renderer produce a frame immediately.
//
// The predicate is intentionally tight: both dimensions must be zero. Live
// CDP testing confirmed that 0x0 is the only reproducible viewport state
// that triggers the stall — Chromium's Emulation.setDeviceMetricsOverride
// rejects single-zero dimensions and falls back to the natural viewport,
// and the natural 0x0 case is "no layout computed yet" (an all-or-nothing
// state). A 0xN or Nx0 viewport is not a state we can observe in practice.
const SCREENSHOT_FALLBACK_CLIP = {
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
  scale: 1,
} as const;

/**
 * The slice of the CDP Page domain that `captureScreenshotWithFallback` uses.
 * Lets unit tests substitute a hand-written fake without dragging in the full
 * `chrome-remote-interface` Page surface.
 */
export interface ScreenshotPageAPI {
  bringToFront(): Promise<unknown>;
  getLayoutMetrics(): Promise<{
    cssLayoutViewport?: { clientWidth: number; clientHeight: number };
    layoutViewport?: { clientWidth: number; clientHeight: number };
  }>;
  captureScreenshot(opts: {
    format: "png" | "jpeg";
    captureBeyondViewport?: boolean;
    clip?: typeof SCREENSHOT_FALLBACK_CLIP;
  }): Promise<ScreenshotResult>;
}

/**
 * Capture a screenshot, falling back to an explicit clip when the layout
 * viewport is degenerate. Extracted as a free function so it can be unit
 * tested against a fake Page without a live CDP connection.
 */
export async function captureScreenshotWithFallback(
  page: ScreenshotPageAPI,
  format: "png" | "jpeg" = "png",
): Promise<ScreenshotResult> {
  try { await page.bringToFront(); } catch { /* not all targets support it */ }

  let clip: typeof SCREENSHOT_FALLBACK_CLIP | undefined;
  try {
    const metrics = await page.getLayoutMetrics();
    const v = metrics.cssLayoutViewport ?? metrics.layoutViewport;
    if (!v?.clientWidth && !v?.clientHeight) {
      clip = SCREENSHOT_FALLBACK_CLIP;
    }
  } catch (err) {
    // Chrome-side rejection (e.g. method unsupported on a non-page target):
    // apply the fallback so captureScreenshot can still produce a frame.
    // Anything else (websocket dropped, unexpected throw): propagate — the
    // next CDP call would fail the same way, and masking with a synthetic
    // 1280x800 capture would hide a real transport-level failure.
    if (err instanceof ProtocolError) {
      clip = SCREENSHOT_FALLBACK_CLIP;
    } else {
      throw err;
    }
  }

  const result = await page.captureScreenshot({
    format,
    ...(clip ? { captureBeyondViewport: true, clip } : {}),
  });

  if (!result?.data) {
    throw new Error(
      "Screenshot returned empty data. Ensure you're connected to a visible tab with content.",
    );
  }

  return result;
}

/** Per-frame lifecycle accumulator: frameId -> { current loaderId, event names seen }. */
export type FrameLifecycleMap = Map<string, { loaderId: string; events: Set<string> }>;

/**
 * The slice of the CDP Page domain that `waitForLifecycle` uses. The return
 * type of `lifecycleEvent(handler)` is CRI's unsubscribe function — api.js:49
 * returns `() => chrome.removeListener(rawEventName, handler)`.
 */
export interface LifecyclePageAPI {
  lifecycleEvent(handler: (params: { name?: string }) => void): () => unknown;
}

/**
 * Wait until any frame in `frameLifecycle` has fired the named
 * Page.lifecycleEvent (e.g. 'firstContentfulPaint', 'networkAlmostIdle').
 * Resolves true if the event is in the cache or arrives before the timeout;
 * false otherwise. Cleans up its listener and timer on every exit path.
 *
 * Defensive ordering: the listener is registered *before* scanning the
 * cache, so even if the event arrived on an I/O turn between calls it's
 * caught by the live listener rather than missed. Single-threaded JS makes
 * the synchronous-only path safe today, but the order matters if anything
 * upstream (CRI internals, scheduler) ever inserts a microtask here.
 *
 * Extracted as a free function so it can be unit tested against a fake
 * Page + map without a live CDP connection.
 */
export function waitForLifecycle(
  page: LifecyclePageAPI,
  frameLifecycle: FrameLifecycleMap,
  eventName: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    let unsubscribe: (() => unknown) | null = null;
    let timer: NodeJS.Timeout | null = null;
    const finish = (val: boolean) => {
      if (done) return;
      done = true;
      if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } }
      if (timer) clearTimeout(timer);
      resolve(val);
    };
    const listener = (params: { name?: string }) => {
      if (params?.name === eventName) finish(true);
    };
    try {
      unsubscribe = page.lifecycleEvent(listener);
    } catch { finish(false); return; }
    for (const { events } of frameLifecycle.values()) {
      if (events.has(eventName)) { finish(true); return; }
    }
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// Detect if running in WSL (must be before windowsFetch)
function isWSL(): boolean {
  if (platform() !== 'linux') return false;
  try {
    const release = execSync('uname -r', { encoding: 'utf8' }).toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

const IS_WSL = isWSL();

// Check if WSL can directly connect to Windows localhost (mirrored networking)
async function canConnectToWindowsLocalhost(port: number): Promise<boolean> {
  if (!IS_WSL) return true;

  const net = await import('net');
  return new Promise((resolve) => {
    const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
      client.destroy();
      resolve(true);
    });
    client.on('error', () => {
      resolve(false);
    });
    client.setTimeout(2000, () => {
      client.destroy();
      resolve(false);
    });
  });
}

// For WSL: port to use for CDP connection
async function getWSLConnectPort(targetPort: number): Promise<number> {
  if (!IS_WSL) return targetPort;

  // Check if mirrored networking is enabled (direct localhost access works)
  const canConnect = await canConnectToWindowsLocalhost(targetPort);
  if (canConnect) {
    return targetPort;
  }

  // Cannot connect - throw helpful error
  throw new Error(
    `WSL cannot connect to Windows localhost:${targetPort}.\n\n` +
    `To fix this, enable WSL mirrored networking:\n` +
    `1. Create/edit %USERPROFILE%\\.wslconfig with:\n` +
    `   [wsl2]\n` +
    `   networkingMode=mirrored\n` +
    `2. Run: wsl --shutdown\n` +
    `3. Restart WSL and try again\n\n` +
    `Alternatively, run Claude Code from Windows PowerShell instead of WSL.`
  );
}

// Escape a string for safe interpolation inside a PowerShell single-quoted
// literal: only `'` is special — double it to `''`. Also reject embedded
// NUL or newline characters, which would terminate the command line.
function psSingleQuote(value: string): string {
  if (value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error('Refusing to pass control characters to PowerShell');
  }
  return value.replace(/'/g, "''");
}

// Windows/WSL-compatible fetch using PowerShell
// On WSL, native fetch connects to WSL's localhost, not Windows where Comet runs
async function windowsFetch(url: string, method: string = 'GET'): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  // Use native fetch only on non-Windows AND non-WSL
  if (platform() !== 'win32' && !IS_WSL) {
    const response = await fetch(url, { method });
    return response;
  }

  // Validate URL before passing through PowerShell: must be loopback http(s).
  // This is the trust boundary — caller-supplied tabIds and ports flow here.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`);
    }
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error(`Refusing non-loopback host: ${parsed.hostname}`);
    }
  } catch (e: any) {
    return { ok: false, status: 0, json: async () => { throw e; } };
  }

  // On Windows or WSL, use PowerShell to reach Windows localhost
  try {
    const safeUrl = psSingleQuote(url);
    const psCommand = method === 'PUT'
      ? `Invoke-WebRequest -Uri '${safeUrl}' -Method PUT -UseBasicParsing | Select-Object -ExpandProperty Content`
      : `Invoke-WebRequest -Uri '${safeUrl}' -UseBasicParsing | Select-Object -ExpandProperty Content`;

    const result = execSync(`powershell.exe -NoProfile -Command "${psCommand}"`, {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });

    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(result.trim())
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      json: async () => { throw error; }
    };
  }
}

// Detect platform and set appropriate Comet path
function getCometPath(): string {
  const os = platform();

  // Check for custom path via environment variable
  if (process.env.COMET_PATH) {
    return process.env.COMET_PATH;
  }

  if (os === "darwin") {
    return "/Applications/Comet.app/Contents/MacOS/Comet";
  } else if (os === "win32" || IS_WSL) {
    // Common Windows installation paths for Comet (Perplexity)
    // For WSL, these paths won't be directly usable but we track them for reference
    const possiblePaths = [
      `${process.env.LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
      `${process.env.APPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
      "C:\\Program Files\\Perplexity\\Comet\\Application\\comet.exe",
      "C:\\Program Files (x86)\\Perplexity\\Comet\\Application\\comet.exe",
    ];

    for (const p of possiblePaths) {
      if (existsSync(p)) {
        return p;
      }
    }

    // Default to LOCALAPPDATA path
    return `${process.env.LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`;
  }

  // Fallback for other platforms
  return "/Applications/Comet.app/Contents/MacOS/Comet";
}

const COMET_PATH = getCometPath();
const IS_WINDOWS = platform() === "win32" || IS_WSL;

// Honour the documented `COMET_PORT` env var (see README "Environment Variables").
// Previously the constant was hardcoded to 9223 and call sites passed the literal
// straight to `startComet(9223)`, so the env var was silently ignored.
function readPortFromEnv(): number {
  const raw = process.env.COMET_PORT;
  if (!raw) return 9223;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`Invalid COMET_PORT="${raw}", falling back to 9223`);
    return 9223;
  }
  return n;
}
export const DEFAULT_PORT = readPortFromEnv();

/**
 * Build the args list passed to the Comet binary. Always includes
 * `--remote-allow-origins=http://127.0.0.1` so other processes on the
 * host (which can resolve `localhost.<attacker>.com` -> 127.0.0.1 via
 * DNS rebinding from a browser they control) cannot attach to Comet's
 * unauthenticated CDP endpoint and steal cookies / read tabs.
 *
 * See https://crbug.com/1247276 for the underlying mitigation.
 */
function cometLaunchArgs(port: number): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1`,
  ];
}

export class CometCDPClient {
  private client: CDP.Client | null = null;
  private cometProcess: ChildProcess | null = null;
  private state: CometState = {
    connected: false,
    port: DEFAULT_PORT,
  };
  private lastTargetId: string | undefined;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  // In-flight reconnect promise. Multiple concurrent operations entering
  // `withAutoReconnect` after a transport drop must NOT each kick off
  // their own reconnect — they would race on `this.client` (one closes
  // while another is mid-handshake), corrupting state. We cache the
  // single promise and let all waiters await it.
  private reconnectPromise: Promise<void> | null = null;
  // Consecutive successful operations since the last connection error.
  // Used to reset the attempt counter only after the connection has
  // proven stable, so a flapping link doesn't silently bypass the
  // max-attempts breaker.
  private consecutiveSuccesses: number = 0;
  private lastHealthCheck: number = 0;
  private healthCheckCache: boolean = false;
  private readonly HEALTH_CHECK_CACHE_MS: number = 2000; // Cache health check for 2s

  // Tab context registry for multi-tab workflow awareness
  private tabRegistry: Map<string, TabContext> = new Map();

  // Page lifecycle tracking — events accumulated per frame for the current
  // document (loaderId). Used by waitForLifecycle() so screenshots and other
  // ops can confirm the renderer has actually painted before they run.
  private frameLifecycle: FrameLifecycleMap = new Map();
  private lifecycleListener: ((params: any) => void) | null = null;
  private lifecycleUnsubscribe: (() => unknown) | null = null;

  get isConnected(): boolean {
    return this.state.connected && this.client !== null;
  }

  get currentState(): CometState {
    return { ...this.state };
  }

  /**
   * Check if connection is healthy by testing a simple operation (cached)
   */
  async isConnectionHealthy(): Promise<boolean> {
    // Return cached result if recent
    const now = Date.now();
    if (now - this.lastHealthCheck < this.HEALTH_CHECK_CACHE_MS) {
      return this.healthCheckCache;
    }

    if (!this.client) {
      this.healthCheckCache = false;
      this.lastHealthCheck = now;
      return false;
    }

    try {
      await this.client.Runtime.evaluate({ expression: '1+1', timeout: 3000 });
      this.healthCheckCache = true;
      this.lastHealthCheck = now;
      return true;
    } catch {
      this.healthCheckCache = false;
      this.lastHealthCheck = now;
      return false;
    }
  }

  /**
   * Force invalidate health cache (call after known connection issues)
   */
  invalidateHealthCache(): void {
    this.lastHealthCheck = 0;
    this.healthCheckCache = false;
  }

  /**
   * Ensure connection is healthy, reconnect if not
   */
  async ensureConnection(): Promise<void> {
    if (!await this.isConnectionHealthy()) {
      this.invalidateHealthCache();
      await this.reconnect();
    }
  }

  /**
   * Pre-operation check - ensures connection is valid before any operation
   * Call this before critical operations
   */
  async preOperationCheck(): Promise<void> {
    // Quick check if client exists
    if (!this.client) {
      await this.reconnect();
      return;
    }

    // If we recently verified health, skip
    if (Date.now() - this.lastHealthCheck < this.HEALTH_CHECK_CACHE_MS && this.healthCheckCache) {
      return;
    }

    // Full health check
    if (!await this.isConnectionHealthy()) {
      this.invalidateHealthCache();
      await this.reconnect();
    }
  }

  /**
   * Auto-reconnect wrapper for operations with exponential backoff
   */
  /**
   * Coalesce concurrent reconnect attempts onto a single promise.
   * Any caller awaiting `ensureSingleReconnect()` either receives the
   * promise of an already-running reconnect or starts a fresh one.
   */
  private ensureSingleReconnect(): Promise<void> {
    if (!this.reconnectPromise) {
      const attempt = this.reconnectAttempts;
      const delay = Math.min(300 * Math.pow(1.3, Math.max(attempt - 1, 0)), 2000);
      this.reconnectPromise = (async () => {
        this.invalidateHealthCache();
        await new Promise(r => setTimeout(r, delay));
        await this.reconnect();
      })().finally(() => {
        this.reconnectPromise = null;
      });
    }
    return this.reconnectPromise;
  }

  /**
   * Auto-reconnect wrapper for operations with exponential backoff
   */
  async withAutoReconnect<T>(operation: () => Promise<T>): Promise<T> {
    // If a reconnect is already in-flight, wait for it instead of
    // launching a parallel one.
    if (this.reconnectPromise) {
      try { await this.reconnectPromise; } catch { /* fall through to retry */ }
    }

    // Pre-operation health check (uses cache for efficiency)
    try {
      await this.preOperationCheck();
    } catch {
      // If pre-check fails, try to proceed anyway
    }

    try {
      const result = await operation();
      // Reset attempt counter only after a window of consecutive
      // successes — a flapping connection that succeeds every Nth try
      // must not be able to silently bypass the breaker.
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= 3) {
        this.reconnectAttempts = 0;
      }
      return result;
    } catch (error: unknown) {
      this.consecutiveSuccesses = 0;
      const errorMessage = error instanceof Error ? error.message : String(error);

      const connectionErrors = [
        'WebSocket', 'CLOSED', 'not open', 'disconnected', 'readyState',
        'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'socket hang up',
        'Protocol error', 'Target closed', 'Session closed', 'Execution context',
        'detached', 'crashed', 'Inspected target navigated', 'aborted'
      ];

      const isConnectionError = connectionErrors.some(e =>
        errorMessage.toLowerCase().includes(e.toLowerCase())
      );

      if (isConnectionError && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;

        try {
          // Coalesce: shared promise across all concurrent callers
          await this.ensureSingleReconnect();
          return await operation();
        } catch (reconnectError) {
          // If reconnect fails, try fresh start
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            try {
              await this.startComet(this.state.port);
              await new Promise(r => setTimeout(r, 1500));
              const targets = await this.listTargets();
              // Pick main Perplexity tab, NOT the sidecar.
              const page =
                targets.find(t => t.type === 'page' && t.url.includes('perplexity') && !t.url.includes('sidecar')) ||
                targets.find(t => t.type === 'page' && t.url.includes('perplexity'));
              const anyPage = page || targets.find(t => t.type === 'page');
              if (anyPage) {
                await this.connect(anyPage.id);
                return await operation();
              }
            } catch {
              // Last resort failed
            }
          }
          throw reconnectError;
        }
      }

      throw error;
    }
  }

  /**
   * Reconnect to the last connected tab
   */
  async reconnect(): Promise<string> {
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
    }
    this.state.connected = false;
    this.client = null;

    // Verify Comet is running
    try {
      await this.getVersion();
    } catch {
      try {
        await this.startComet(this.state.port);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch {
        throw new Error('Cannot connect to Comet. Ensure Comet is running with --remote-debugging-port=9222');
      }
    }

    // Try to reconnect to last target
    if (this.lastTargetId) {
      try {
        const targets = await this.listTargets();
        if (targets.find(t => t.id === this.lastTargetId)) {
          return await this.connect(this.lastTargetId);
        }
      } catch { /* target gone */ }
    }

    // Find best target. Prefer the MAIN Perplexity tab — explicitly
    // exclude `sidecar` URLs, which Comet uses for its right-panel
    // chat helper. Connecting to the sidecar by mistake silently
    // routes `sendPrompt` / `stopAgent` to the wrong tab.
    const targets = await this.listTargets();
    const target =
      targets.find(t => t.type === 'page' && t.url.includes('perplexity.ai') && !t.url.includes('sidecar')) ||
      targets.find(t => t.type === 'page' && t.url.includes('perplexity.ai')) ||
      targets.find(t => t.type === 'page' && t.url !== 'about:blank');

    if (target) {
      return await this.connect(target.id);
    }

    throw new Error('No suitable tab found for reconnection');
  }

  /**
   * List tabs with categorization
   */
  async listTabsCategorized(): Promise<{
    main: CDPTarget | null;
    sidecar: CDPTarget | null;
    agentBrowsing: CDPTarget | null;
    overlay: CDPTarget | null;
    others: CDPTarget[];
  }> {
    const targets = await this.listTargets();

    return {
      main: targets.find(t =>
        t.type === 'page' && t.url.includes('perplexity.ai') && !t.url.includes('sidecar')
      ) || null,
      sidecar: targets.find(t =>
        t.type === 'page' && t.url.includes('sidecar')
      ) || null,
      agentBrowsing: targets.find(t =>
        t.type === 'page' &&
        !t.url.includes('perplexity.ai') &&
        !t.url.includes('chrome-extension') &&
        !t.url.includes('chrome://') &&
        t.url !== 'about:blank'
      ) || null,
      overlay: targets.find(t =>
        t.url.includes('chrome-extension') && t.url.includes('overlay')
      ) || null,
      others: targets.filter(t =>
        t.type === 'page' &&
        !t.url.includes('perplexity.ai') &&
        !t.url.includes('chrome-extension')
      ),
    };
  }

  /**
   * Ensure we're connected to the main Perplexity tab
   * Used during agentic browsing when Comet may open new tabs
   */
  async ensureOnPerplexityTab(): Promise<boolean> {
    try {
      // First check if current connection is valid and on Perplexity.
      // Reject the sidecar URL — same reason as in reconnect(): the
      // sidecar matches `perplexity.ai` but is a different tab.
      if (this.client) {
        try {
          const urlResult = await this.client.Runtime.evaluate({
            expression: 'window.location.href',
            timeout: 2000
          });
          const currentUrl = urlResult.result.value as string;
          if (currentUrl?.includes('perplexity.ai') && !currentUrl.includes('sidecar')) {
            return true; // Already on Perplexity main tab
          }
        } catch {
          // Current connection is stale, continue to reconnect
        }
      }

      // Find and connect to Perplexity main tab
      const tabs = await this.listTabsCategorized();
      if (tabs.main) {
        await this.connect(tabs.main.id);
        this.invalidateHealthCache();
        return true;
      }

      // Fallback: find any Perplexity tab that isn't the sidecar.
      const targets = await this.listTargets();
      const perplexityTab = targets.find(t =>
        t.type === 'page' && t.url.includes('perplexity.ai') && !t.url.includes('sidecar')
      );

      if (perplexityTab) {
        await this.connect(perplexityTab.id);
        this.invalidateHealthCache();
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if we're currently connected to the Perplexity tab
   */
  async isOnPerplexityTab(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const result = await this.client.Runtime.evaluate({
        expression: 'window.location.href',
        timeout: 2000
      });
      const url = result.result.value as string;
      // Sidecar URLs match `perplexity.ai` but are a different surface; treat
      // them as "not the main tab" so callers don't dispatch sendPrompt /
      // stopAgent there.
      return !!url && url.includes('perplexity.ai') && !url.includes('sidecar');
    } catch {
      return false;
    }
  }

  // ============ TAB REGISTRY METHODS ============

  /**
   * Extract domain from URL
   */
  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Check if URL is an internal Chrome/Comet page (not a real browsing tab)
   */
  private isInternalTab(url: string): boolean {
    // Chrome internal pages
    if (url.startsWith('chrome://') ||
        url.startsWith('chrome-extension://') ||
        url.startsWith('devtools://') ||
        url === 'about:blank' ||
        url === '') {
      return true;
    }

    // ALL Perplexity URLs are internal Comet UI, not real browsing tabs
    if (url.includes('perplexity.ai')) {
      return true;
    }

    return false;
  }

  /**
   * Infer tab purpose from URL and context
   */
  private inferPurpose(url: string, title: string): TabContext['purpose'] {
    if (this.isInternalTab(url)) return 'unknown';
    if (url.includes('perplexity.ai')) return 'main';
    // Default to agent-browsing for external sites
    return 'agent-browsing';
  }

  /**
   * Update tab registry with current browser state
   */
  async refreshTabRegistry(): Promise<TabContext[]> {
    const targets = await this.listTargets();
    const currentTime = Date.now();

    // Track which tabs still exist
    const existingIds = new Set<string>();

    for (const target of targets) {
      if (target.type !== 'page') continue;

      // Skip internal Chrome tabs entirely
      if (this.isInternalTab(target.url)) continue;

      existingIds.add(target.id);

      // Update or create tab context
      const existing = this.tabRegistry.get(target.id);
      const domain = this.extractDomain(target.url);

      if (existing) {
        // Update existing entry
        existing.url = target.url;
        existing.title = target.title;
        existing.domain = domain;
        existing.lastActivity = currentTime;
        // Re-infer purpose if URL changed significantly
        if (existing.domain !== domain) {
          existing.purpose = this.inferPurpose(target.url, target.title);
        }
      } else {
        // New tab - create entry
        const context: TabContext = {
          id: target.id,
          url: target.url,
          title: target.title,
          purpose: this.inferPurpose(target.url, target.title),
          domain,
          lastActivity: currentTime,
        };
        this.tabRegistry.set(target.id, context);
      }
    }

    // Remove closed tabs from registry
    for (const id of this.tabRegistry.keys()) {
      if (!existingIds.has(id)) {
        this.tabRegistry.delete(id);
      }
    }

    return Array.from(this.tabRegistry.values());
  }

  /**
   * Get all tracked tabs with context
   */
  async getTabContexts(): Promise<TabContext[]> {
    await this.refreshTabRegistry();
    return Array.from(this.tabRegistry.values());
  }

  /**
   * Find a tab by domain (for reuse).
   *
   * Match is "exact or subdomain": `findTabByDomain("github.com")` matches
   * both `github.com` and `gist.github.com`, but NOT `notgithub.com`. The
   * previous `includes`/reverse-`includes` heuristic produced surprising
   * matches — `domain: "ai"` matched `perplexity.ai`, `chat.openai.com`,
   * etc., and a search for `"mail.google.com"` would match a `google.com`
   * tab via the reverse direction.
   */
  async findTabByDomain(domain: string): Promise<TabContext | null> {
    await this.refreshTabRegistry();
    const target = domain.toLowerCase();
    for (const tab of this.tabRegistry.values()) {
      const tabDomain = tab.domain.toLowerCase();
      if (tabDomain === target || tabDomain.endsWith(`.${target}`)) {
        return tab;
      }
    }
    return null;
  }

  /**
   * Find a tab by URL pattern
   */
  async findTabByUrl(urlPattern: string): Promise<TabContext | null> {
    await this.refreshTabRegistry();
    for (const tab of this.tabRegistry.values()) {
      if (tab.url.includes(urlPattern)) {
        return tab;
      }
    }
    return null;
  }

  /**
   * Find tabs by purpose
   */
  async findTabsByPurpose(purpose: TabContext['purpose']): Promise<TabContext[]> {
    await this.refreshTabRegistry();
    return Array.from(this.tabRegistry.values()).filter(t => t.purpose === purpose);
  }

  /**
   * Update tab purpose (for workflow tracking)
   */
  setTabPurpose(tabId: string, purpose: TabContext['purpose'], taskId?: string): void {
    const tab = this.tabRegistry.get(tabId);
    if (tab) {
      tab.purpose = purpose;
      if (taskId) tab.taskId = taskId;
      tab.lastActivity = Date.now();
    }
  }

  /**
   * Set content summary for a tab
   */
  setTabContentSummary(tabId: string, summary: string): void {
    const tab = this.tabRegistry.get(tabId);
    if (tab) {
      tab.contentSummary = summary;
      tab.lastActivity = Date.now();
    }
  }

  /**
   * Navigate to URL, reusing existing tab if one exists for that domain
   */
  async navigateOrReuseTab(url: string, purpose: TabContext['purpose'] = 'agent-browsing'): Promise<{ tabId: string; reused: boolean }> {
    const domain = this.extractDomain(url);

    // Check if we already have a tab for this domain
    const existingTab = await this.findTabByDomain(domain);

    if (existingTab && existingTab.purpose !== 'main') {
      // Reuse existing tab
      await this.connect(existingTab.id);
      await this.navigate(url, true);
      this.setTabPurpose(existingTab.id, purpose);
      return { tabId: existingTab.id, reused: true };
    }

    // Create new tab
    const newTab = await this.newTab(url);
    await new Promise(r => setTimeout(r, 1500)); // Wait for load
    await this.connect(newTab.id);

    // Register the new tab
    const context: TabContext = {
      id: newTab.id,
      url: newTab.url,
      title: newTab.title,
      purpose,
      domain,
      lastActivity: Date.now(),
    };
    this.tabRegistry.set(newTab.id, context);

    return { tabId: newTab.id, reused: false };
  }

  /**
   * Get formatted tab summary for context display (filters out internal Chrome tabs)
   */
  async getTabSummary(): Promise<string> {
    const allTabs = await this.getTabContexts();

    // Filter out internal Chrome tabs - only show real browsing tabs
    const tabs = allTabs.filter(t => !this.isInternalTab(t.url));

    if (tabs.length === 0) {
      return "No browsing tabs open";
    }

    const lines: string[] = [`${tabs.length} browsing tab(s) open:`];

    for (const tab of tabs) {
      const active = tab.id === this.state.activeTabId ? " [ACTIVE]" : "";
      const task = tab.taskId ? ` (task: ${tab.taskId})` : "";
      const summary = tab.contentSummary ? ` - ${tab.contentSummary}` : "";
      lines.push(`  • ${tab.purpose.toUpperCase()}: ${tab.domain}${active}${task}${summary}`);
      lines.push(`    URL: ${tab.url.substring(0, 80)}${tab.url.length > 80 ? '...' : ''}`);
    }

    return lines.join('\n');
  }

  /**
   * Check if Comet process is running
   */
  private async isCometProcessRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      if (IS_WINDOWS) {
        // Windows: use tasklist to check for comet.exe
        const check = spawn('tasklist', ['/FI', 'IMAGENAME eq comet.exe', '/NH']);
        let output = '';
        check.stdout?.on('data', (data) => { output += data.toString(); });
        check.on('close', () => {
          // If comet.exe is running, output will contain "comet.exe"
          resolve(output.toLowerCase().includes('comet.exe'));
        });
        check.on('error', () => resolve(false));
      } else {
        // macOS/Linux: use pgrep
        const check = spawn('pgrep', ['-f', 'Comet.app']);
        check.on('close', (code) => resolve(code === 0));
        check.on('error', () => resolve(false));
      }
    });
  }

  /**
   * Kill any running Comet process
   */
  private async killComet(): Promise<void> {
    return new Promise((resolve) => {
      if (IS_WINDOWS) {
        // Windows: use taskkill to kill comet.exe
        const kill = spawn('taskkill', ['/F', '/IM', 'comet.exe']);
        kill.on('close', () => setTimeout(resolve, 1000));
        kill.on('error', () => setTimeout(resolve, 1000));
      } else {
        // macOS/Linux: use pkill
        const kill = spawn('pkill', ['-f', 'Comet.app']);
        kill.on('close', () => setTimeout(resolve, 1000));
        kill.on('error', () => setTimeout(resolve, 1000));
      }
    });
  }

  /**
   * Start Comet browser with remote debugging enabled
   */
  async startComet(port: number = DEFAULT_PORT): Promise<string> {
    this.state.port = port;

    // On WSL, use HTTP via PowerShell (WebSocket doesn't work across WSL/Windows boundary)
    if (IS_WSL) {
      // Check if Comet is already running with debug port via HTTP
      try {
        const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          const version = await response.json() as CDPVersion;
          return `Comet already running on Windows host, port: ${port} (${version.Browser})`;
        }
      } catch {
        // Comet not accessible, need to launch
      }

      // Try to launch Comet via PowerShell on Windows
      console.error('Comet not accessible, attempting to launch via PowerShell...');

      // Get Windows user's LOCALAPPDATA path
      let cometPath = '';
      try {
        const localAppData = execSync('cmd.exe /c echo %LOCALAPPDATA%', { encoding: 'utf8' }).trim().replace(/\r?\n/g, '');
        cometPath = `${localAppData}\\Perplexity\\Comet\\Application\\Comet.exe`;
      } catch {
        cometPath = 'C:\\Users\\' + (process.env.USER || 'user') + '\\AppData\\Local\\Perplexity\\Comet\\Application\\Comet.exe';
      }

      // Validate port + path before interpolating into PowerShell.
      // %LOCALAPPDATA% on Windows can legally contain `'` (rare but possible),
      // and `port` is a typed number in TypeScript but the runtime cannot
      // enforce that — explicit checks guard against shell injection.
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port for Comet launch: ${port}`);
      }
      const safeCometPath = psSingleQuote(cometPath);

      try {
        // Launch Comet via PowerShell.
        // Use Set-Location to avoid UNC path issues when running from WSL.
        // ArgumentList is comma-separated entries inside the single-quoted
        // string, then PowerShell turns that into separate argv elements
        // for Comet itself. Match the args produced by cometLaunchArgs().
        const launchArgs = cometLaunchArgs(port)
          .map(a => `'${a.replace(/'/g, "''")}'`)
          .join(',');
        const psCommand = `Set-Location C:\\; Start-Process -FilePath '${safeCometPath}' -ArgumentList ${launchArgs}`;
        spawn('powershell.exe', ['-NoProfile', '-Command', psCommand], {
          detached: true,
          stdio: 'ignore',
        }).unref();

        // Wait for Comet to start - use HTTP check via PowerShell
        return new Promise((resolve, reject) => {
          const maxAttempts = 40;
          let attempts = 0;

          const checkReady = async () => {
            attempts++;
            try {
              const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
              if (response.ok) {
                resolve(`Comet started via WSL->PowerShell on port ${port}`);
                return;
              }
            } catch { /* keep trying */ }

            if (attempts < maxAttempts) {
              setTimeout(checkReady, 500);
            } else {
              reject(new Error(
                `Timeout waiting for Comet. Tried to launch: ${cometPath}\n` +
                `Try manually: powershell.exe -Command "Start-Process '${cometPath}' -ArgumentList '--remote-debugging-port=${port}'"`
              ));
            }
          };

          setTimeout(checkReady, 2000);
        });
      } catch (launchError) {
        throw new Error(
          `Cannot connect to or launch Comet browser.\n` +
          `Tried path: ${cometPath}\n` +
          `Error: ${launchError instanceof Error ? launchError.message : String(launchError)}`
        );
      }
    }

    // On Windows (native), try direct WebSocket connection first (bypasses HTTP issues)
    if (IS_WINDOWS) {
      try {
        // Try to connect directly via CDP WebSocket
        const testClient = await CDP({ port, host: '127.0.0.1' });
        await testClient.close();
        return `Comet already running with debug port: ${port}`;
      } catch {
        // Comet not running or not accessible, check if process exists
        const isRunning = await this.isCometProcessRunning();
        if (!isRunning) {
          // Start Comet
          this.cometProcess = spawn(COMET_PATH, cometLaunchArgs(port), {
            detached: true,
            stdio: "ignore",
          });
          this.cometProcess.unref();

          // Wait for Comet to start and try WebSocket connection
          return new Promise((resolve, reject) => {
            const maxAttempts = 40;
            let attempts = 0;

            const checkReady = async () => {
              attempts++;
              try {
                const testClient = await CDP({ port, host: '127.0.0.1' });
                await testClient.close();
                resolve(`Comet started with debug port ${port}`);
                return;
              } catch { /* keep trying */ }

              if (attempts < maxAttempts) {
                setTimeout(checkReady, 500);
              } else {
                reject(new Error(`Timeout waiting for Comet. Try running: "${COMET_PATH}" --remote-debugging-port=${port}`));
              }
            };

            setTimeout(checkReady, 1500);
          });
        } else {
          // Process running but CDP not accessible - need restart with debug port
          await this.killComet();
          await new Promise(r => setTimeout(r, 1000));

          this.cometProcess = spawn(COMET_PATH, cometLaunchArgs(port), {
            detached: true,
            stdio: "ignore",
          });
          this.cometProcess.unref();

          return new Promise((resolve, reject) => {
            const maxAttempts = 40;
            let attempts = 0;

            const checkReady = async () => {
              attempts++;
              try {
                const testClient = await CDP({ port, host: '127.0.0.1' });
                await testClient.close();
                resolve(`Comet restarted with debug port ${port}`);
                return;
              } catch { /* keep trying */ }

              if (attempts < maxAttempts) {
                setTimeout(checkReady, 500);
              } else {
                reject(new Error(`Timeout waiting for Comet. Try running: "${COMET_PATH}" --remote-debugging-port=${port}`));
              }
            };

            setTimeout(checkReady, 1500);
          });
        }
      }
    }

    // Non-Windows: use original HTTP-based approach
    try {
      const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);

      if (response.ok) {
        const version = await response.json() as CDPVersion;
        return `Comet already running with debug port: ${version.Browser}`;
      }
    } catch {
      const isRunning = await this.isCometProcessRunning();
      if (isRunning) {
        await this.killComet();
      }
    }

    // Start Comet
    return new Promise((resolve, reject) => {
      this.cometProcess = spawn(COMET_PATH, cometLaunchArgs(port), {
        detached: true,
        stdio: "ignore",
      });
      this.cometProcess.unref();

      const maxAttempts = 40;
      let attempts = 0;

      const checkReady = async () => {
        attempts++;
        try {
          const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);

          if (response.ok) {
            const version = await response.json() as CDPVersion;
            resolve(`Comet started with debug port ${port}: ${version.Browser}`);
            return;
          }
        } catch { /* keep trying */ }

        if (attempts < maxAttempts) {
          setTimeout(checkReady, 500);
        } else {
          const hint = IS_WINDOWS
            ? `Try running: "${COMET_PATH}" --remote-debugging-port=${port}`
            : `Try: ${COMET_PATH} --remote-debugging-port=${port}`;
          reject(new Error(`Timeout waiting for Comet. ${hint}`));
        }
      };

      setTimeout(checkReady, 1500);
    });
  }

  /**
   * Get CDP version info
   */
  async getVersion(): Promise<CDPVersion> {
    const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/version`);
    if (!response.ok) throw new Error(`Failed to get version: ${response.status}`);
    return response.json() as Promise<CDPVersion>;
  }

  /**
   * List all available tabs/targets
   */
  async listTargets(): Promise<CDPTarget[]> {
    // On WSL, use HTTP via PowerShell (WebSocket doesn't work across WSL/Windows boundary)
    if (IS_WSL) {
      const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/list`);
      if (!response.ok) throw new Error(`Failed to list targets: ${response.status}`);
      return response.json() as Promise<CDPTarget[]>;
    }

    // On native Windows (not WSL), use CDP Target.getTargets() to avoid HTTP issues
    if (IS_WINDOWS) {
      try {
        const tempClient = await CDP({ port: this.state.port, host: '127.0.0.1' });
        try {
          const { targetInfos } = await (tempClient as any).Target.getTargets();
          return targetInfos.map((t: any) => ({
            id: t.targetId,
            type: t.type,
            title: t.title,
            url: t.url,
            webSocketDebuggerUrl: `ws://127.0.0.1:${this.state.port}/devtools/page/${t.targetId}`
          }));
        } finally {
          // Close in `finally` so a throw inside `Target.getTargets()` does
          // not leak the underlying WebSocket. Each retry in withAutoReconnect
          // calls listTargets() again — even a slow leak exhausts handles.
          await tempClient.close().catch(() => { /* already closed */ });
        }
      } catch (error) {
        throw new Error(`Failed to list targets: ${error}`);
      }
    }

    // Fallback for other platforms (macOS, Linux)
    const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/list`);
    if (!response.ok) throw new Error(`Failed to list targets: ${response.status}`);
    return response.json() as Promise<CDPTarget[]>;
  }

  /**
   * Connect to a specific tab
   */
  async connect(targetId?: string): Promise<string> {
    if (this.client) {
      await this.disconnect();
    }

    // On WSL, check if we can connect directly (mirrored networking required)
    const connectPort = await getWSLConnectPort(this.state.port);

    const options: CDP.Options = { port: connectPort, host: '127.0.0.1' };
    if (targetId) options.target = targetId;

    this.client = await CDP(options);

    await Promise.all([
      this.client.Page.enable(),
      this.client.Runtime.enable(),
      this.client.DOM.enable(),
      this.client.Network.enable(),
    ]);

    // Set window size for consistent UI
    try {
      const { windowId } = await (this.client as any).Browser.getWindowForTarget({ targetId });
      await (this.client as any).Browser.setWindowBounds({
        windowId,
        bounds: { width: 1440, height: 900, windowState: 'normal' },
      });
    } catch {
      try {
        await (this.client as any).Emulation.setDeviceMetricsOverride({
          width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
        });
      } catch { /* continue */ }
    }

    // Subscribe to Page.lifecycleEvent so we can wait for paint readiness
    // (firstContentfulPaint, networkAlmostIdle, etc.) the way Lighthouse and
    // Puppeteer do, instead of polling document.readyState.
    this.frameLifecycle.clear();
    if (this.lifecycleUnsubscribe) {
      try { this.lifecycleUnsubscribe(); } catch { /* ignore */ }
      this.lifecycleUnsubscribe = null;
    }
    this.lifecycleListener = null;
    try {
      await this.client.Page.setLifecycleEventsEnabled({ enabled: true });
      this.lifecycleListener = (params: any) => {
        const { frameId, loaderId, name } = params || {};
        if (!frameId || !loaderId || !name) return;
        const existing = this.frameLifecycle.get(frameId);
        if (!existing || existing.loaderId !== loaderId) {
          this.frameLifecycle.set(frameId, { loaderId, events: new Set([name]) });
        } else {
          existing.events.add(name);
        }
      };
      // chrome-remote-interface's domain event callbacks return an unsubscribe
      // function (api.js: `() => chrome.removeListener(rawEventName, handler)`).
      // Capture it so disconnect() can deregister cleanly.
      this.lifecycleUnsubscribe = this.client.Page.lifecycleEvent(this.lifecycleListener);
    } catch { /* lifecycle tracking is best-effort */ }

    this.state.connected = true;
    this.state.activeTabId = targetId;
    this.lastTargetId = targetId;
    this.reconnectAttempts = 0;

    const { result } = await this.client.Runtime.evaluate({ expression: "window.location.href" });
    this.state.currentUrl = result.value as string;

    return `Connected to tab: ${this.state.currentUrl}`;
  }

  /**
   * Disconnect from current tab
   */
  async disconnect(): Promise<void> {
    if (this.lifecycleUnsubscribe) {
      try { this.lifecycleUnsubscribe(); } catch { /* ignore */ }
      this.lifecycleUnsubscribe = null;
    }
    this.lifecycleListener = null;
    this.frameLifecycle.clear();
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.state.connected = false;
      this.state.activeTabId = undefined;
    }
  }

  /**
   * Validate a target URL before passing it to Page.navigate.
   *
   * Allow only `http:` and `https:`. Reject:
   *   - `javascript:` / `data:` / `vbscript:` — XSS-equivalent inside the
   *     active Comet tab
   *   - `file://` — local filesystem read
   *   - `chrome:`, `devtools:`, `view-source:`, `about:` — internal pages;
   *     `Page.navigate` to these often crashes the CDP session
   *   - empty / unparseable strings
   */
  private assertNavigableUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Refusing navigation to non-http(s) URL: ${parsed.protocol}`);
    }
  }

  /**
   * Navigate to a URL
   */
  async navigate(url: string, waitForLoad: boolean = true): Promise<NavigateResult> {
    this.ensureConnected();
    this.assertNavigableUrl(url);
    const result = await this.client!.Page.navigate({ url });
    if (waitForLoad) await this.client!.Page.loadEventFired();
    this.state.currentUrl = url;
    return result as NavigateResult;
  }

  /**
   * Navigate to a URL with automatic retry on failure
   * @param url - URL to navigate to
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   * @param retryDelay - Delay between retries in ms (default: 1000)
   */
  async navigateWithRetry(url: string, maxRetries: number = 3, retryDelay: number = 1000): Promise<{ success: boolean; url: string; attempts: number; error?: string }> {
    let lastError: string = '';

    try {
      this.assertNavigableUrl(url);
    } catch (e: any) {
      return { success: false, url, attempts: 0, error: e.message };
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.withAutoReconnect(async () => {
          this.ensureConnected();
          const result = await this.client!.Page.navigate({ url });

          // Check if navigation succeeded
          if (result.errorText) {
            throw new Error(result.errorText);
          }

          // Wait for load with timeout.
          // `client.Page.loadEventFired()` resolves on the next event but
          // leaves the underlying listener registered if the timeout
          // branch of Promise.race wins. After many timeouts in one
          // session the listener list grows unbounded. Subscribe via
          // `client.once` (which auto-unsubscribes after one event) and
          // explicitly remove the listener when the timeout wins.
          const client = this.client!;
          await new Promise<void>((resolve, reject) => {
            const onLoad = () => {
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              client.removeListener('Page.loadEventFired', onLoad);
              reject(new Error('Page load timeout'));
            }, 15000);
            client.once('Page.loadEventFired', onLoad);
          });

          this.state.currentUrl = url;
        });

        return { success: true, url, attempts: attempt };
      } catch (error: any) {
        lastError = error.message || String(error);

        // Don't retry for certain errors
        if (lastError.includes('net::ERR_NAME_NOT_RESOLVED') ||
            lastError.includes('net::ERR_INVALID_URL')) {
          return { success: false, url, attempts: attempt, error: lastError };
        }

        // Wait before retry
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        }
      }
    }

    return { success: false, url, attempts: maxRetries, error: lastError };
  }

  /**
   * Capture screenshot
   */
  async screenshot(format: "png" | "jpeg" = "png"): Promise<ScreenshotResult> {
    this.ensureConnected();

    // Wait for paint readiness via Page.lifecycleEvent (Lighthouse/Puppeteer
    // approach). If firstContentfulPaint already fired for this document the
    // call returns synchronously; otherwise we wait up to 2s for the next FCP.
    await waitForLifecycle(this.client!.Page, this.frameLifecycle, 'firstContentfulPaint', 2000);

    return captureScreenshotWithFallback(this.client!.Page, format);
  }

  /**
   * Execute JavaScript in the page context
   */
  async evaluate(expression: string): Promise<EvaluateResult> {
    this.ensureConnected();
    return this.client!.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as Promise<EvaluateResult>;
  }

  /**
   * Execute JavaScript with auto-reconnect on connection loss
   */
  async safeEvaluate(expression: string): Promise<EvaluateResult> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();
      return this.client!.Runtime.evaluate({
        expression,
        awaitPromise: true,
        returnByValue: true,
      }) as Promise<EvaluateResult>;
    });
  }

  /**
   * Press a key
   */
  async pressKey(key: string): Promise<void> {
    this.ensureConnected();
    await this.client!.Input.dispatchKeyEvent({ type: "keyDown", key });
    await this.client!.Input.dispatchKeyEvent({ type: "keyUp", key });
  }

  /**
   * Create a new tab
   */
  async newTab(url?: string): Promise<CDPTarget> {
    const response = await windowsFetch(
      `http://127.0.0.1:${this.state.port}/json/new${url ? `?${url}` : ""}`,
      'PUT'
    );
    if (!response.ok) throw new Error(`Failed to create new tab: ${response.status}`);
    return response.json() as Promise<CDPTarget>;
  }

  /**
   * Close a tab
   */
  async closeTab(targetId: string): Promise<boolean> {
    try {
      if (this.client) {
        const result = await this.client.Target.closeTarget({ targetId });
        return result.success;
      }
    } catch { /* fallback to HTTP */ }

    try {
      const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/close/${targetId}`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private ensureConnected(): void {
    if (!this.client) {
      throw new Error("Not connected to Comet. Call connect() first.");
    }
  }

  /**
   * Upload a file to a file input element on the page
   * Uses CDP DOM.setFileInputFiles to inject file into input
   *
   * @param filePath - Absolute path to the file to upload
   * @param selector - Optional CSS selector for the file input (auto-detects if not provided)
   * @returns Result with success status and details
   */
  async uploadFile(filePath: string, selector?: string): Promise<{ success: boolean; message: string; inputFound: boolean }> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();

      // Find the file input element
      let nodeId: number;

      if (selector) {
        // Use provided selector
        const doc = await this.client!.DOM.getDocument();
        const result = await this.client!.DOM.querySelector({
          nodeId: doc.root.nodeId,
          selector: selector
        });

        if (!result.nodeId) {
          return {
            success: false,
            message: `No element found matching selector: ${selector}`,
            inputFound: false
          };
        }
        nodeId = result.nodeId;
      } else {
        // Auto-detect file input - find first visible file input
        const doc = await this.client!.DOM.getDocument();

        // Try common file input selectors
        const selectors = [
          'input[type="file"]:not([disabled])',
          'input[type="file"]',
          '[data-testid*="file"] input',
          '[class*="upload"] input[type="file"]',
          '[class*="dropzone"] input[type="file"]'
        ];

        let found = false;
        for (const sel of selectors) {
          try {
            const result = await this.client!.DOM.querySelector({
              nodeId: doc.root.nodeId,
              selector: sel
            });
            if (result.nodeId) {
              nodeId = result.nodeId;
              found = true;
              break;
            }
          } catch {
            continue;
          }
        }

        if (!found) {
          return {
            success: false,
            message: 'No file input element found on the page. Try providing a specific selector.',
            inputFound: false
          };
        }
      }

      // Set the file on the input element
      try {
        await this.client!.DOM.setFileInputFiles({
          nodeId: nodeId!,
          files: [filePath]
        });

        // Trigger change event to notify the page
        const safeSelector = JSON.stringify(selector || 'input[type="file"]');
        await this.client!.Runtime.evaluate({
          expression: `
            (function() {
              const input = document.querySelector(${safeSelector});
              if (input) {
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('input', { bubbles: true }));
              }
            })();
          `
        });

        return {
          success: true,
          message: `File uploaded successfully: ${filePath}`,
          inputFound: true
        };
      } catch (error: any) {
        return {
          success: false,
          message: `Failed to set file: ${error.message}`,
          inputFound: true
        };
      }
    });
  }

  /**
   * Upload multiple files to a file input element
   *
   * @param filePaths - Array of absolute file paths
   * @param selector - Optional CSS selector for the file input
   */
  async uploadFiles(filePaths: string[], selector?: string): Promise<{ success: boolean; message: string }> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();

      const doc = await this.client!.DOM.getDocument();
      const sel = selector || 'input[type="file"]';

      const result = await this.client!.DOM.querySelector({
        nodeId: doc.root.nodeId,
        selector: sel
      });

      if (!result.nodeId) {
        return {
          success: false,
          message: `No file input found with selector: ${sel}`
        };
      }

      try {
        await this.client!.DOM.setFileInputFiles({
          nodeId: result.nodeId,
          files: filePaths
        });

        // Trigger change event
        const safeSel = JSON.stringify(sel);
        await this.client!.Runtime.evaluate({
          expression: `
            (function() {
              const input = document.querySelector(${safeSel});
              if (input) {
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('input', { bubbles: true }));
              }
            })();
          `
        });

        return {
          success: true,
          message: `${filePaths.length} file(s) uploaded successfully`
        };
      } catch (error: any) {
        return {
          success: false,
          message: `Failed to upload files: ${error.message}`
        };
      }
    });
  }

  /**
   * Check if the current page has any file inputs
   */
  async hasFileInput(): Promise<{ found: boolean; count: number; selectors: string[] }> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();

      const result = await this.client!.Runtime.evaluate({
        expression: `
          (function() {
            const inputs = document.querySelectorAll('input[type="file"]');
            const selectors = [];
            inputs.forEach((input, i) => {
              let sel = 'input[type="file"]';
              if (input.id) sel = '#' + input.id;
              else if (input.name) sel = 'input[name="' + input.name + '"]';
              else if (input.className) sel = 'input[type="file"].' + input.className.split(' ')[0];
              selectors.push(sel);
            });
            return { count: inputs.length, selectors };
          })();
        `,
        returnByValue: true
      });

      const data = result.result.value as { count: number; selectors: string[] };
      return {
        found: data.count > 0,
        count: data.count,
        selectors: data.selectors
      };
    });
  }

  /**
   * Click on a file input to potentially trigger a file picker dialog
   * Note: This won't actually open a native dialog in headless mode,
   * but can trigger custom file picker UIs
   */
  async clickFileInput(selector?: string): Promise<{ success: boolean; message: string }> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();

      const sel = selector || 'input[type="file"]';
      const safeSel = JSON.stringify(sel);

      const result = await this.client!.Runtime.evaluate({
        expression: `
          (function() {
            const input = document.querySelector(${safeSel});
            if (input) {
              input.click();
              return { clicked: true };
            }
            return { clicked: false };
          })();
        `,
        returnByValue: true
      });

      const data = result.result.value as { clicked: boolean };
      return {
        success: data.clicked,
        message: data.clicked ? 'File input clicked' : 'No file input found to click'
      };
    });
  }
}

export const cometClient = new CometCDPClient();
