import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadDaemonConfig } from "../src/config.js";

const ENV_KEYS = [
  "SLACKOFF_APP_TOKEN",
  "SLACKOFF_BOT_TOKEN",
  "SLACKOFF_APP_TOKEN_FILE",
  "SLACKOFF_BOT_TOKEN_FILE",
  "SLACKOFF_USER_ID",
  "SLACKOFF_SOCKET_PATH",
  "SLACKOFF_OMP_PATH",
] as const;

test("loads Slack credentials from protected files", () => {
  const directory = mkdtempSync(join(tmpdir(), "slackoff-config-"));
  const appTokenFile = join(directory, "app-token");
  const botTokenFile = join(directory, "bot-token");
  writeFileSync(appTokenFile, "xapp-test\n", { mode: 0o600 });
  writeFileSync(botTokenFile, "xoxb-test\n", { mode: 0o600 });

  withEnvironment(
    {
      SLACKOFF_APP_TOKEN_FILE: appTokenFile,
      SLACKOFF_BOT_TOKEN_FILE: botTokenFile,
      SLACKOFF_USER_ID: "U123",
      SLACKOFF_SOCKET_PATH: join(directory, "slackoff.sock"),
      SLACKOFF_OMP_PATH: "/opt/omp/bin/omp",
    },
    () => {
      const config = loadDaemonConfig();
      assert.equal(config.appToken, "xapp-test");
      assert.equal(config.botToken, "xoxb-test");
      assert.equal(config.userId, "U123");
      assert.equal(config.ompPath, "/opt/omp/bin/omp");
    },
  );
  rmSync(directory, { recursive: true });
});

test("rejects a token in the wrong credential slot", () => {
  withEnvironment(
    {
      SLACKOFF_APP_TOKEN: "xoxb-wrong-kind",
      SLACKOFF_BOT_TOKEN: "xoxb-test",
      SLACKOFF_USER_ID: "U123",
    },
    () => assert.throws(() => loadDaemonConfig(), /not an app token/),
  );
});

function withEnvironment(values: Record<string, string>, run: () => void): void {
  const original: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, values);
  try {
    run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
