import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.integration.test.ts"],
    clearMocks: true,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
