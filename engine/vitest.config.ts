import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    env: { M0_MARKET_PUBKEY: "Mkt111" },
  },
});
