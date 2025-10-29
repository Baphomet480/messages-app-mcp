import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      reporter: ["text", "json-summary", "html"],
      include: [
        "src/utils/contacts.ts",
        "src/utils/send-result.ts",
        "src/utils/text-utils.ts",
      ],
      thresholds: {
        statements: 80,
        branches: 60,
        functions: 80,
        lines: 80,
      },
    },
  },
});
