import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildTmuxArguments, normalizeLaunchRequest } from "../src/daemon/launcher.js";

test("normalizes a safe Home session launch", () => {
  const home = mkdtempSync(join(tmpdir(), "slackoff-launch-"));
  try {
    const request = normalizeLaunchRequest({ name: "parser-fix", cwd: "~", prompt: " Fix the parser " }, home);

    assert.deepEqual(request, { name: "parser-fix", cwd: home, prompt: "Fix the parser" });
  } finally {
    rmSync(home, { recursive: true });
  }
});

test("rejects unsafe tmux names and missing directories", () => {
  assert.throws(() => normalizeLaunchRequest({ name: "bad;name", cwd: "/tmp" }), /Session name/);
  assert.throws(
    () => normalizeLaunchRequest({ name: "safe-name", cwd: "/definitely/missing/slackoff-directory" }),
    /does not exist/,
  );
});

test("passes launch values through tmux environment instead of the shell command", () => {
  const args = buildTmuxArguments(
    { name: "parser-fix", cwd: "/workspace", prompt: "Review 'quoted' input; do not interpolate" },
    "/opt/omp/bin/omp",
  );

  assert.deepEqual(args.slice(0, 6), ["new-session", "-d", "-s", "parser-fix", "-c", "/workspace"]);
  assert.ok(args.includes("SLACKOFF_AUTO_ENABLE=1"));
  assert.ok(args.includes("SLACKOFF_OMP_PATH=/opt/omp/bin/omp"));
  assert.ok(args.includes("SLACKOFF_CWD=/workspace"));
  assert.ok(args.includes("SLACKOFF_INITIAL_PROMPT=Review 'quoted' input; do not interpolate"));
  assert.equal(
    args.at(-1),
    'exec "$SLACKOFF_OMP_PATH" --allow-home --cwd "$SLACKOFF_CWD" "$SLACKOFF_INITIAL_PROMPT"',
  );
});
