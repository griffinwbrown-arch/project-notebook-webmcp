import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: [
      "tests/unit/workspace/history.test.ts",
      "tests/unit/workspace/controller.test.ts",
      "tests/unit/entries/desk/notebook-page-state.test.ts",
      "tests/unit/entries/desk/FocusedNotebook.test.tsx",
    ],
  },
});
