import assert from "node:assert/strict";
import test from "node:test";

import { buildCollapsedSessionBlocks, buildSessionBlocks, STOP_ACTION } from "../src/daemon/blocks.js";

const session = { id: "session-123456789", title: "Fix parser", project: "project" };

test("working session card shows the current activity and Stop control", () => {
  const blocks = buildSessionBlocks(session, "binding-1", "working", "Editing");
  const serialized = JSON.stringify(blocks);

  assert.match(serialized, new RegExp(STOP_ACTION));
  assert.match(serialized, /binding-1/);
  assert.match(serialized, /🔵 Editing/);
  assert.doesNotMatch(serialized, /Send instruction|Last activity|Slackoff ·/);
});

test("completed session card shows Done without controls", () => {
  const blocks = buildSessionBlocks(session, "binding-1", "done", undefined);
  const serialized = JSON.stringify(blocks);

  assert.match(serialized, /🟢 Done/);
  assert.doesNotMatch(serialized, new RegExp(STOP_ACTION));
});

test("stopped session card collapses to one context line", () => {
  const blocks = buildCollapsedSessionBlocks(session);
  const serialized = JSON.stringify(blocks);

  assert.equal(blocks.length, 1);
  assert.match(serialized, /Fix parser/);
  assert.match(serialized, /Stopped/);
  assert.match(serialized, /project/);
  assert.doesNotMatch(serialized, new RegExp(STOP_ACTION));
});

test("offline session card does not expose controls", () => {
  const blocks = buildSessionBlocks(session, "binding-1", "offline", undefined);
  const serialized = JSON.stringify(blocks);

  assert.doesNotMatch(serialized, new RegExp(STOP_ACTION));
});
