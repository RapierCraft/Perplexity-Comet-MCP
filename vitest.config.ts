import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environmentMatchGlobs: [
      ["tests/unit/page-scripts.test.ts", "jsdom"],
    ],
  },
});
