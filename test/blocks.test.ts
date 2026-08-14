import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAttachSessionModal,
  buildCloseSessionModal,
  buildCollapsedSessionBlocks,
  buildThreadReplyPermalink,
  buildHomeView,
  buildLaunchModal,
  buildSessionBlocks,
  CLOSE_AND_DELETE_TMUX,
  CLOSE_SESSION_VIEW,
  CLOSE_THREAD_ACTION,
  HOME_ATTACH_ACTION,
  HOME_ATTACH_VIEW,
  HOME_LAUNCH_VIEW,
  HOME_NEW_SESSION_ACTION,
  MODEL_ACTION,
  STOP_ACTION,
} from "../src/daemon/blocks.js";

const session = {
  id: "session-123456789",
  title: "Fix parser",
  project: "project",
  modelState: {
    current: { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    available: [
      { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    ],
  },
};

test("working session card offers separate turn and thread controls", () => {
  const blocks = buildSessionBlocks(session, "binding-1", "working", "Editing");
  const serialized = JSON.stringify(blocks);

  assert.match(serialized, new RegExp(STOP_ACTION));
  assert.match(serialized, new RegExp(CLOSE_THREAD_ACTION));
  assert.match(serialized, /Stop turn/);
  assert.match(serialized, /Close thread/);
  assert.match(serialized, /binding-1/);
  assert.match(serialized, /🔵 Editing/);
  assert.match(serialized, new RegExp(MODEL_ACTION));
  assert.match(serialized, /GPT-5\.6 Sol/);
  assert.match(serialized, /openai-codex\/gpt-5\.6-sol/);
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

  assert.doesNotMatch(serialized, new RegExp(`${STOP_ACTION}|${CLOSE_THREAD_ACTION}|${MODEL_ACTION}`));
});

test("App Home exposes a launcher and connected sessions", () => {
  const view = buildHomeView([
    {
      title: "Fix parser",
      project: "parser-tmux",
      status: "working",
      activity: "Editing",
      permalink: "https://example.slack.com/archives/D123/p1234567891000001?thread_ts=1234567890.000000&cid=D123",
    },
    {
      title: "Review API",
      project: "api-tmux",
      status: "waiting",
      activity: "Waiting for your reply",
      permalink: "https://example.slack.com/archives/D123/p1234567892000002?thread_ts=1234567892.000002&cid=D123",
    },
  ]);
  const serialized = JSON.stringify(view);

  assert.equal(view.type, "home");
  assert.match(serialized, new RegExp(HOME_NEW_SESSION_ACTION));
  assert.match(serialized, new RegExp(HOME_ATTACH_ACTION));
  assert.match(serialized, /Fix parser/);
  assert.match(
    serialized,
    /https:\/\/example\.slack\.com\/archives\/D123\/p1234567891000001\?thread_ts=1234567890\.000000&amp;cid=D123/,
  );
  assert.match(serialized, /parser-tmux/);
  assert.match(serialized, /Editing/);
  assert.ok(serialized.indexOf("Review API") < serialized.indexOf("Fix parser"));
});

test("thread navigation promotes a root permalink to an actual reply permalink", () => {
  assert.equal(
    buildThreadReplyPermalink(
      "https://example.slack.com/archives/D123/p1234567890000000",
      "D123",
      "1234567890.000000",
      "1234567891.000001",
    ),
    "https://example.slack.com/archives/D123/p1234567891000001?thread_ts=1234567890.000000&cid=D123",
  );
});

test("Home launcher modal collects tmux name, directory, and optional prompt", () => {
  const modal = buildLaunchModal("/home/bits");
  const serialized = JSON.stringify(modal);

  assert.equal(modal.callback_id, HOME_LAUNCH_VIEW);
  assert.match(serialized, /tmux session name/);
  assert.match(serialized, /\/home\/bits/);
  assert.match(serialized, /Initial prompt/);
});

test("close modal offers thread-only and destructive tmux choices", () => {
  const modal = buildCloseSessionModal("binding-1", "parser-tmux");
  const serialized = JSON.stringify(modal);

  assert.equal(modal.callback_id, CLOSE_SESSION_VIEW);
  assert.equal(modal.private_metadata, "binding-1");
  assert.match(serialized, /Close Slack thread only/);
  assert.match(serialized, /delete parser-tmux/);
  assert.match(serialized, new RegExp(CLOSE_AND_DELETE_TMUX));
});

test("attach modal lists existing OMP panes by session name", () => {
  const modal = buildAttachSessionModal([{ name: "parser-tmux", paneId: "%42" }]);
  const serialized = JSON.stringify(modal);

  assert.equal(modal.callback_id, HOME_ATTACH_VIEW);
  assert.match(serialized, /parser-tmux/);
  assert.match(serialized, /%42/);
  assert.match(serialized, /\/slackoff on/);
});
