import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("vitest toolchain is wired up", () => {
    expect(1 + 1).toBe(2);
  });
});
