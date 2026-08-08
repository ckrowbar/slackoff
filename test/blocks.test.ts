import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollapsedSessionBlocks,
  buildHomeView,
  buildLaunchModal,
  buildSessionBlocks,
  CLOSE_THREAD_ACTION,
  HOME_LAUNCH_VIEW,
  HOME_NEW_SESSION_ACTION,
  STOP_ACTION,
} from "../src/daemon/blocks.js";

const session = { id: "session-123456789", title: "Fix parser", project: "project" };

test("working session card offers separate turn and thread controls", () => {
  const blocks = buildSessionBlocks(session, "binding-1", "working", "Editing");
  const serialized = JSON.stringify(blocks);

  assert.match(serialized, new RegExp(STOP_ACTION));
  assert.match(serialized, new RegExp(CLOSE_THREAD_ACTION));
  assert.match(serialized, /Stop turn/);
  assert.match(serialized, /Close thread/);
  assert.match(serialized, /binding-1/);
  assert.match(serialized, /🔵 Editing/);
  assert.doesNotMatch(serialized, /Send instruction|Last activity|Slackoff ·/);
});

test("completed session card keeps Close thread without Stop turn", () => {
  const blocks = buildSessionBlocks(session, "binding-1", "done", undefined);
  const serialized = JSON.stringify(blocks);

  assert.match(serialized, /🟢 Done/);
  assert.match(serialized, new RegExp(CLOSE_THREAD_ACTION));
  assert.doesNotMatch(serialized, new RegExp(STOP_ACTION));
});

test("closed session card collapses to one context line", () => {
  const blocks = buildCollapsedSessionBlocks(session);
  const serialized = JSON.stringify(blocks);

  assert.equal(blocks.length, 1);
  assert.match(serialized, /Fix parser/);
  assert.match(serialized, /Closed/);
  assert.match(serialized, /project/);
  assert.doesNotMatch(serialized, new RegExp(`${STOP_ACTION}|${CLOSE_THREAD_ACTION}`));
});

test("offline session card does not expose controls", () => {
  const blocks = buildSessionBlocks(session, "binding-1", "offline", undefined);
  const serialized = JSON.stringify(blocks);

  assert.doesNotMatch(serialized, new RegExp(`${STOP_ACTION}|${CLOSE_THREAD_ACTION}`));
});

test("App Home exposes a launcher and connected sessions", () => {
  const view = buildHomeView([
    { title: "Fix parser", project: "parser-tmux", status: "working", activity: "Editing" },
  ]);
  const serialized = JSON.stringify(view);

  assert.equal(view.type, "home");
  assert.match(serialized, new RegExp(HOME_NEW_SESSION_ACTION));
  assert.match(serialized, /Fix parser/);
  assert.match(serialized, /parser-tmux/);
  assert.match(serialized, /Editing/);
});

test("Home launcher modal collects tmux name, directory, and optional prompt", () => {
  const modal = buildLaunchModal("/home/bits");
  const serialized = JSON.stringify(modal);

  assert.equal(modal.callback_id, HOME_LAUNCH_VIEW);
  assert.match(serialized, /tmux session name/);
  assert.match(serialized, /\/home\/bits/);
  assert.match(serialized, /Initial prompt/);
});
