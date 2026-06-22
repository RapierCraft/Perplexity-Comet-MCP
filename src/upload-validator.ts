/**
 * Shared upload path and tab-ID validation utilities.
 *
 * Extracted from index.ts so that cdp-client.ts and http-bridge.ts can
 * import them without introducing circular dependencies.
 */

import { realpathSync, statSync } from "fs";
import { homedir } from "os";
import { resolve as resolvePath, sep as PATH_SEP } from "path";

/**
 * Validate a user-supplied upload path against the optional allowlist root
 * (`COMET_UPLOAD_ROOT` env). When the env var is set we resolve symlinks
 * and require the real path to live under the configured root — defends
 * against an LLM-controlled `filePath` exfiltrating arbitrary local files
 * (e.g. `~/.ssh/id_rsa`, `~/.aws/credentials`).
 *
 * When the env var is unset we keep permissive behaviour (backward
 * compatibility) but block a denylist of paths that obviously have no
 * business being uploaded to a webpage.
 *
 * Security notes:
 * - The former `existsSync` pre-check has been removed to eliminate the
 *   TOCTOU window between existence check and `realpathSync`. A missing
 *   path now produces an ENOENT from `realpathSync` which is caught and
 *   re-thrown with a friendly message.
 * - `COMET_UPLOAD_ROOT="/"` and `COMET_UPLOAD_ROOT=homedir()` are
 *   explicitly rejected because they would pass every path through.
 *
 * Returns the canonical absolute path, or throws with a user-facing message.
 */
export function validateUploadPath(filePath: string): string {
  // Atomically resolve the path (follows symlinks) and fail on ENOENT —
  // no separate existsSync pre-check, which would introduce a TOCTOU race.
  let real: string;
  try {
    real = realpathSync(filePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`File not found: ${filePath}`);
    }
    throw err;
  }

  const stat = statSync(real);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }

  const home = homedir();
  const root = process.env.COMET_UPLOAD_ROOT;
  if (root) {
    // Reject dangerously broad root values before resolving.
    const resolvedRoot = resolvePath(root);
    if (resolvedRoot === "/" || resolvedRoot === home) {
      throw new Error(
        `COMET_UPLOAD_ROOT is set to an overly broad value ("${resolvedRoot}"). ` +
          `Use a specific subdirectory (e.g., ~/uploads) to restrict allowed paths.`,
      );
    }

    let realRoot: string;
    try {
      realRoot = realpathSync(resolvedRoot);
    } catch {
      throw new Error(`COMET_UPLOAD_ROOT path does not exist: ${resolvedRoot}`);
    }

    // Also reject after symlink resolution (in case root itself is a symlink to /).
    if (realRoot === "/" || realRoot === home) {
      throw new Error(
        `COMET_UPLOAD_ROOT resolves to an overly broad path ("${realRoot}"). ` +
          `Use a specific subdirectory to restrict allowed paths.`,
      );
    }

    const rootWithSep = realRoot.endsWith(PATH_SEP)
      ? realRoot
      : realRoot + PATH_SEP;
    if (real !== realRoot && !real.startsWith(rootWithSep)) {
      throw new Error(
        `Refusing upload: path is outside COMET_UPLOAD_ROOT (${realRoot}). ` +
          `Resolved path: ${real}`,
      );
    }
    return real;
  }

  // No allowlist configured. Block obviously-sensitive paths to make the
  // failure mode better than "anything goes".
  const blockedPrefixes = [
    resolvePath(home, ".ssh"),
    resolvePath(home, ".aws"),
    resolvePath(home, ".config", "gh"),
    resolvePath(home, ".config", "gcloud"),
    resolvePath(home, ".gnupg"),
    resolvePath(home, ".kube"),
    resolvePath(home, ".docker"),
    resolvePath(home, "Library", "Keychains"), // macOS
    // Credential and secret files
    resolvePath(home, ".netrc"),
    resolvePath(home, ".npmrc"),
    resolvePath(home, ".git-credentials"),
    resolvePath(home, ".pypirc"),
    // Shell history (may contain secrets passed as CLI args)
    resolvePath(home, ".bash_history"),
    resolvePath(home, ".zsh_history"),
    resolvePath(home, ".sh_history"),
    // .env files at home root
    resolvePath(home, ".env"),
    // System-level sensitive paths
    "/etc/shadow",
    "/etc/sudoers",
    "/etc/passwd",
    "/root",
    "/proc", // block entire /proc subtree (maps, fd/*, environ for any PID)
  ];

  for (const prefix of blockedPrefixes) {
    const withSep = prefix.endsWith(PATH_SEP) ? prefix : prefix + PATH_SEP;
    if (real === prefix || real.startsWith(withSep)) {
      throw new Error(
        `Refusing upload from sensitive path: ${real}. ` +
          `Set COMET_UPLOAD_ROOT to an explicit upload directory if this is intentional.`,
      );
    }
  }

  // Block .env files anywhere in the filesystem (not just home root).
  const basename = real.split(PATH_SEP).pop() ?? "";
  if (basename === ".env" || basename.startsWith(".env.")) {
    throw new Error(
      `Refusing upload of environment file: ${real}. ` +
        `Set COMET_UPLOAD_ROOT to an explicit upload directory if this is intentional.`,
    );
  }

  console.error(
    `[comet-mcp] WARN: comet_upload received '${real}' without COMET_UPLOAD_ROOT set. ` +
      `Consider setting the env var to restrict allowed paths.`,
  );
  return real;
}

/**
 * Validate a CDP tab ID.
 *
 * Chrome DevTools Protocol target IDs are UUID v4 strings. Reject
 * obviously-malformed values before passing them to CDP methods, which
 * otherwise produce cryptic errors and can be tricked into traversing the
 * local HTTP API surface (`/json/version`, etc.).
 *
 * The original loose regex `/^[A-Fa-f0-9-]{16,64}$/` allowed hyphens in
 * any position. This stricter version enforces canonical UUID v4 format.
 */
export function validateTabId(tabId: string): string {
  const UUID_V4 =
    /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
  if (!UUID_V4.test(tabId)) {
    throw new Error(`Invalid tabId format: ${tabId}`);
  }
  return tabId;
}

/**
 * Validate a domain parameter supplied to `comet_tabs` (switch/close actions).
 *
 * Enforces:
 *  - Maximum 253 characters (DNS hostname limit per RFC 1035)
 *  - Only hostname-safe characters: ASCII letters, digits, hyphens, dots
 *    (i.e. /^[A-Za-z0-9.\-]+$/)
 *
 * The error message intentionally does NOT echo back the supplied value —
 * user-controlled strings reflected in responses are a stored-XSS vector if
 * the MCP client ever renders them as HTML.
 *
 * Returns the (unchanged) domain string on success, throws on rejection.
 */
export function validateDomain(domain: string): string {
  if (domain.length === 0 || domain.length > 253) {
    throw new Error("Invalid domain: must be 1–253 characters long");
  }
  if (!/^[A-Za-z0-9.\-]+$/.test(domain)) {
    throw new Error(
      "Invalid domain: only letters, digits, hyphens, and dots are allowed",
    );
  }
  return domain;
}

/**
 * Validate a CSS selector parameter supplied to `comet_upload`.
 *
 * Enforces:
 *  - Maximum 500 characters — prevents a pathologically long selector from
 *    causing the Comet renderer to spend significant CPU time parsing (DoS).
 *  - Character allowlist covering the full CSS selector grammar: letters,
 *    digits, space and tab (the only whitespace valid in CSS selectors), and
 *    the punctuation characters used by class (`.`),
 *    ID (`#`), attribute (`[`, `]`, `=`, `~`, `^`, `$`, `*`, `|`),
 *    pseudo-class/element (`:`), combinators (`>`, `+`, `~`), grouping (`,`),
 *    quotes (`"`, `'`), parentheses, hyphens, underscores, and at-signs.
 *  - Rejects null bytes and characters outside that set (e.g. raw `<`, `>` as
 *    HTML-injection attempts, or control characters).
 *
 * The error message intentionally does NOT echo back the supplied value —
 * user-controlled strings reflected in responses are a stored-XSS vector if
 * the MCP client ever renders them as HTML.
 *
 * Returns the (unchanged) selector string on success, throws on rejection.
 */
export function validateSelector(selector: string): string {
  if (selector.length === 0 || selector.length > 500) {
    throw new Error("Invalid selector: must be 1–500 characters long");
  }
  // Allowlist: CSS selector grammar characters only.
  // Use explicit [ \t] instead of \s — \s also matches \n, \r, \f, \v which
  // are not valid in CSS selectors and can corrupt error messages that echo
  // the selector back to the caller.
  // Excludes: <, >, null bytes, and all other characters not used in CSS selectors.
  if (
    !/^[A-Za-z0-9 \t\.\#\[\]=~^$*|:>+,\"'\(\)\-_\\/@!;{}%&]+$/.test(selector)
  ) {
    throw new Error(
      "Invalid selector: contains characters not permitted in CSS selectors",
    );
  }
  return selector;
}
