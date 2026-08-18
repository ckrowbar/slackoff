import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTmuxArguments,
  normalizeLaunchRequest,
  parseOmpTmuxSessions,
  TmuxAttachmentTracker,
  TmuxLauncher,
  type CommandRunner,
} from "../src/daemon/launcher.js";

test("normalizes a safe Home session launch", () => {
  const home = mkdtempSync(join(tmpdir(), "slackoff-launch-"));
  try {
    const request = normalizeLaunchRequest({ name: "parser-fix", cwd: "~", prompt: " Fix the parser " }, home);

    assert.deepEqual(request, { name: "parser-fix", cwd: realpathSync(home), prompt: "Fix the parser" });
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
    "/opt/slackoff/extension.js",
  );

  assert.deepEqual(args.slice(0, 6), ["new-session", "-d", "-s", "parser-fix", "-c", "/workspace"]);
  assert.ok(args.includes("SLACKOFF_AUTO_ENABLE=1"));
  assert.ok(args.includes("SLACKOFF_OMP_PATH=/opt/omp/bin/omp"));
  assert.ok(args.includes("SLACKOFF_EXTENSION_PATH=/opt/slackoff/extension.js"));
  assert.ok(args.includes("SLACKOFF_CWD=/workspace"));
  assert.ok(args.includes("SLACKOFF_INITIAL_PROMPT=Review 'quoted' input; do not interpolate"));
  assert.equal(
    args.at(-1),
    'exec "$SLACKOFF_OMP_PATH" --allow-home --cwd "$SLACKOFF_CWD" --extension "$SLACKOFF_EXTENSION_PATH" "$SLACKOFF_INITIAL_PROMPT"',
  );
});

test("discovers OMP panes and ignores other tmux commands", () => {
  assert.deepEqual(
    parseOmpTmuxSessions("%2\tzeta\tomp\n%1\talpha\tomp\n%3\tshell\tzsh\n%4\talpha\tomp\n"),
    [
      { name: "alpha", paneId: "%1" },
      { name: "zeta", paneId: "%2" },
    ],
  );
});

test("attaches and deletes only revalidated OMP tmux targets", async () => {
  const calls: string[][] = [];
  const run: CommandRunner = async (_program, args) => {
    calls.push(args);
    if (args[0] === "list-panes") {
      return { code: 0, stdout: "%1\talpha\tomp\n%2\tzeta\tomp\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const launcher = new TmuxLauncher("/opt/omp/bin/omp", run);

  assert.deepEqual(await launcher.enableSlackoff("%2"), { name: "zeta", paneId: "%2" });
  await launcher.killOmpSession("alpha");

  assert.deepEqual(calls[1], ["send-keys", "-t", "%2", "-l", "/slackoff on"]);
  assert.deepEqual(calls[2], ["send-keys", "-t", "%2", "Enter"]);
  assert.deepEqual(calls[4], ["kill-session", "-t", "=alpha"]);
});

test("tmux attachment resolves only after the matching OMP registration completes", async () => {
  const tracker = new TmuxAttachmentTracker(1_000);
  const first = tracker.begin("alpha");
  const second = tracker.begin("zeta");

  assert.equal(tracker.claim("session-zeta", "zeta"), "zeta");
  tracker.complete("session-zeta");
  await second.promise;

  let firstSettled = false;
  void first.promise.finally(() => {
    firstSettled = true;
  });
  await Promise.resolve();
  assert.equal(firstSettled, false);

  tracker.claim("session-alpha", "alpha");
  tracker.complete("session-alpha");
  await first.promise;
});

test("tmux attachment rejects when OMP never registers", async () => {
  const tracker = new TmuxAttachmentTracker(5);
  await assert.rejects(tracker.begin("broken").promise, /did not connect to Slackoff/);
});
