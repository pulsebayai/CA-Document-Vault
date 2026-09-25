import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "jsdom",
          include: ["tests/unit/**/*.test.{ts,tsx}"],
          setupFiles: ["tests/support/setup-dom.ts"],
        },
      },
      {
        extends: true,
        test: {
          // RLS + integration tests hit the hosted dev Supabase project.
          name: "db",
          environment: "node",
          include: ["tests/rls/**/*.test.ts", "tests/integration/**/*.test.ts"],
          setupFiles: ["tests/support/setup-env.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
