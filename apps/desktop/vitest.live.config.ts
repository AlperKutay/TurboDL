import { defineConfig } from "vitest/config";

// Network checks against real sites; not part of `pnpm test`. Run: pnpm --filter @turbodl/desktop test:live
export default defineConfig({
  test: { include: ["live/**/*.test.ts"], environment: "node", testTimeout: 600_000, hookTimeout: 60_000 },
});
