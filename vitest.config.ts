import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: [
        "src/**/*.{ts,tsx}",
      ],
      exclude: ["src/types/**"],
      thresholds: {
        branches: 66,
        functions: 77,
        lines: 78,
        statements: 75,
      },
    },
  },
});
