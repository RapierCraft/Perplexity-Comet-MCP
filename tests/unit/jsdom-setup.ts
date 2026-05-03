// jsdom setup: polyfills for APIs jsdom intentionally does not implement
// because they would require a layout engine.
//
// `innerText` is the main one — production code calls it on prose blocks
// and the document body. jsdom returns `undefined`, which crashes the
// page-side extractors. We back it with `textContent`, which is close
// enough for our text-pattern assertions.
//
// Loaded by `vitest.config.ts` via `setupFiles`.

if (typeof HTMLElement !== "undefined") {
  const proto = HTMLElement.prototype as HTMLElement & { innerText?: string };
  if (!Object.getOwnPropertyDescriptor(proto, "innerText")) {
    Object.defineProperty(proto, "innerText", {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent ?? "";
      },
      set(this: HTMLElement, value: string) {
        this.textContent = value;
      },
    });
  }
}
