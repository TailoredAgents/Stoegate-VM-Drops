import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required. The integration suite never uses DATABASE_URL as a fallback.",
  );
}
if (testDatabaseUrl === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL.");
}

const parsed = new URL(testDatabaseUrl);
const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
if (
  !/test/i.test(databaseName) &&
  process.env.ALLOW_DISPOSABLE_TEST_DATABASE !== "true"
) {
  throw new Error(
    `Refusing database “${databaseName}”. Include “test” in its name or set ALLOW_DISPOSABLE_TEST_DATABASE=true for a disposable database.`,
  );
}

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: testDatabaseUrl,
  APP_BASE_URL: process.env.APP_BASE_URL ?? "http://localhost:3000",
  SESSION_SECRET:
    process.env.SESSION_SECRET ?? "integration-test-session-secret-32-chars",
  SMS_LIVE_SENDS_ENABLED: "false",
  SMS_PROVIDER: "dry-run",
};
function run(modulePath: string, args: string[]) {
  const result = spawnSync(process.execPath, [modulePath, ...args], {
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(
  fileURLToPath(
    new URL("../node_modules/prisma/build/index.js", import.meta.url),
  ),
  ["migrate", "deploy"],
);
run(
  fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
  ["run", "--config", "vitest.integration.config.mts"],
);
