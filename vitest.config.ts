import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // dist/ holds compiled copies of these same tests; without this they run
    // twice and the duplicates hit the database concurrently.
    exclude: ["node_modules/**", "dist/**"],
    // Tool and orchestrator suites share one Postgres instance and assert on
    // row counts, so they must not interleave.
    fileParallelism: false,
  },
});
