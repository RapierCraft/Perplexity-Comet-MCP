// Minimal fake of the CDP `Page` slice that `waitForLifecycle` uses.
// Implements just `lifecycleEvent` — enough to satisfy `LifecyclePageAPI` —
// and exposes hooks so tests can fire events or assert on unsubscribe.

import type { LifecyclePageAPI } from "../../../src/cdp-client.js";

type Handler = (params: { name?: string }) => void;

export class FakeLifecyclePage implements LifecyclePageAPI {
  /** Handlers currently registered via `lifecycleEvent`. */
  private readonly handlers: Set<Handler> = new Set();

  /** Number of times `lifecycleEvent` has been called (handler registrations). */
  public registrations = 0;

  /** Number of unsubscribe-function invocations. */
  public unsubscribes = 0;

  /** When true, `lifecycleEvent` throws on next call (simulates CRI rejection). */
  private throwOnRegister = false;

  setLifecycleEventToThrow(): void {
    this.throwOnRegister = true;
  }

  /** Emit a lifecycle event to every currently-registered handler. */
  emit(name: string): void {
    for (const handler of this.handlers) {
      handler({ name });
    }
  }

  /** Number of currently-live handlers (registered minus unsubscribed). */
  liveHandlerCount(): number {
    return this.handlers.size;
  }

  lifecycleEvent(handler: Handler): () => unknown {
    if (this.throwOnRegister) {
      throw new Error("lifecycleEvent registration failed");
    }
    this.registrations++;
    this.handlers.add(handler);
    return () => {
      this.unsubscribes++;
      this.handlers.delete(handler);
    };
  }
}
