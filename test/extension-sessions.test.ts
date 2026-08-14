import assert from "node:assert/strict";
import test from "node:test";

import { buildQuestionMetadata, buildSessionMetadata, buildTranscriptMetadata } from "../src/metadata.js";
import {
  mergeSessions,
  parseSessionRoot,
  parseStatusText,
  parseThreadMessage,
  reduceThread,
  tsToMillis,
} from "../extension/src/slack/sessions.js";
import type { SessionStatus } from "../src/protocol.js";
import type { SessionView, ThreadEvent } from "../extension/src/types.js";

/**
 * Fixtures mirror what conversations.history actually returns for the Slackoff DM: Slack has
 * normalised the daemon's unicode status emoji into shortcodes, and every message posted before the
 * metadata change comes back with `metadata: null`.
 */

const CHANNEL = "D07SLACKOFF";
const BINDING = "b1d3f2c4-8a71-4f1e-9c2b-77a0d5e4c310";
const ROOT_TS = "1770000000.000100";
const LATEST_REPLY = "1770000300.000500";

const SOL = { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };
const OPUS = { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" };

const MODEL_SELECT = {
  type: "static_select",
  action_id: "slackoff_model",
  placeholder: { type: "plain_text", text: "Select model", emoji: false },
  options: [
    { text: { type: "plain_text", text: "GPT-5.6 Sol · openai-codex", emoji: false }, value: "openai-codex/gpt-5.6-sol" },
    {
      text: { type: "plain_text", text: "Claude Opus 4.6 · anthropic", emoji: false },
      value: "anthropic/claude-opus-4-6",
    },
  ],
  initial_option: {
    text: { type: "plain_text", text: "GPT-5.6 Sol · openai-codex", emoji: false },
    value: "openai-codex/gpt-5.6-sol",
  },
};

const STOP_BUTTON = {
  type: "button",
  action_id: "slackoff_stop",
  text: { type: "plain_text", text: "Stop turn", emoji: false },
  value: BINDING,
};

const CLOSE_BUTTON = {
  type: "button",
  action_id: "slackoff_close_thread",
  text: { type: "plain_text", text: "Close thread", emoji: false },
  value: BINDING,
  style: "danger",
};

interface CardOptions {
  title: string;
  status: string;
  project: string;
  model?: string;
  sessionId?: string;
  stoppable?: boolean;
}

function cardBlocks(options: CardOptions): unknown[] {
  const elements = options.stoppable === false ? [MODEL_SELECT, CLOSE_BUTTON] : [MODEL_SELECT, STOP_BUTTON, CLOSE_BUTTON];
  return [
    { type: "header", block_id: "XN6VR", text: { type: "plain_text", text: options.title, emoji: true } },
    {
      type: "section",
      block_id: "u2Lp",
      fields: [
        { type: "mrkdwn", text: `*Status*\n${options.status}` },
        { type: "mrkdwn", text: `*Project*\n${options.project}` },
        { type: "mrkdwn", text: `*Model*\n${options.model ?? "GPT-5.6 Sol\n`openai-codex/gpt-5.6-sol`"}` },
      ],
    },
    {
      type: "context",
      block_id: "q4V/2",
      elements: [{ type: "mrkdwn", text: `OMP session \`${options.sessionId ?? "019fec89ab12"}\`` }],
    },
    { type: "actions", block_id: BINDING, elements },
  ];
}

const metadataRoot = {
  type: "message",
  subtype: "bot_message",
  bot_id: "B07SLACKOFF",
  ts: ROOT_TS,
  thread_ts: ROOT_TS,
  latest_reply: LATEST_REPLY,
  reply_count: 4,
  text: "Review PR 1776 · Thinking",
  blocks: cardBlocks({
    title: "Review PR 1776",
    status: ":large_blue_circle: Thinking",
    project: "slack &amp; friends",
  }),
  metadata: buildSessionMetadata({
    sessionId: "019fec89ab12cd34ef",
    bindingId: BINDING,
    title: "Review PR 1776",
    project: "slack & friends",
    status: "working",
    activity: "Thinking",
    collapsed: false,
    model: SOL,
    models: [SOL, OPUS],
  }),
};

const labelRoot = {
  bot_id: "B07SLACKOFF",
  ts: ROOT_TS,
  thread_ts: ROOT_TS,
  latest_reply: LATEST_REPLY,
  text: "Review PR 1776 · waiting",
  blocks: cardBlocks({
    title: "Review PR 1776",
    status: ":large_yellow_circle: Waiting for you",
    project: "slack &amp; friends",
  }),
  metadata: null,
};

const unicodeLabelRoot = {
  bot_id: "B07SLACKOFF",
  ts: ROOT_TS,
  text: "Review PR 1776 · done",
  blocks: cardBlocks({
    title: "Review PR 1776",
    status: "🟢 Done",
    project: "slack",
    stoppable: false,
  }),
  metadata: null,
};

const activityRoot = {
  bot_id: "B07SLACKOFF",
  ts: ROOT_TS,
  text: "OMP 019fec89 · Reading src/api.ts",
  blocks: cardBlocks({
    title: "OMP 019fec89",
    status: ":large_blue_circle: Reading src/api.ts",
    project: "web &amp; api &lt;beta&gt;",
  }),
  metadata: null,
};

const unknownModelRoot = {
  bot_id: "B07SLACKOFF",
  ts: ROOT_TS,
  text: "OMP 019fec89 · offline",
  blocks: [
    { type: "header", block_id: "XN6VR", text: { type: "plain_text", text: "OMP 019fec89", emoji: true } },
    {
      type: "section",
      block_id: "u2Lp",
      fields: [
        { type: "mrkdwn", text: "*Status*\n:black_circle: Offline" },
        { type: "mrkdwn", text: "*Project*\nUnknown" },
        { type: "mrkdwn", text: "*Model*\nUnknown" },
      ],
    },
    { type: "context", block_id: "q4V", elements: [{ type: "mrkdwn", text: "OMP session `019fec89ab12`" }] },
  ],
  metadata: null,
};

/** A disabled session still shows a card with actions stripped, and shares the offline emoji. */
const disabledRoot = {
  bot_id: "B07SLACKOFF",
  ts: ROOT_TS,
  text: "OMP 019fec89 · disabled",
  blocks: [
    { type: "header", block_id: "XN6VR", text: { type: "plain_text", text: "OMP 019fec89", emoji: true } },
    {
      type: "section",
      block_id: "u2Lp",
      fields: [
        { type: "mrkdwn", text: "*Status*\n:black_circle: Disabled" },
        { type: "mrkdwn", text: "*Project*\nslackoff" },
        { type: "mrkdwn", text: "*Model*\nUnknown" },
      ],
    },
    { type: "context", block_id: "q4V", elements: [{ type: "mrkdwn", text: "OMP session `019fec89ab12`" }] },
  ],
  metadata: null,
};

const LONG_TITLE = `${"Refactor the transcript chunker ".repeat(6)}and`;
const TRUNCATED_TITLE = `${LONG_TITLE.slice(0, 149)}…`;

const truncatedRoot = {
  bot_id: "B07SLACKOFF",
  ts: ROOT_TS,
  text: `${TRUNCATED_TITLE} · idle`,
  blocks: cardBlocks({
    title: TRUNCATED_TITLE,
    status: ":white_circle: Ready",
    project: "slackoff",
    stoppable: false,
  }),
  metadata: null,
};

const collapsedRoot = {
  bot_id: "B07SLACKOFF",
  ts: ROOT_TS,
  thread_ts: ROOT_TS,
  latest_reply: LATEST_REPLY,
  text: "Review PR 1776 · Closed",
  blocks: [
    {
      type: "context",
      block_id: "Kw1",
      elements: [{ type: "mrkdwn", text: ":black_circle: *Review PR 1776* · Closed · slack &amp; friends" }],
    },
  ],
  metadata: null,
};

/** `unknown` values so a case can assert a field is absent, which Partial<> forbids under EOPT. */
interface RootCase {
  name: string;
  message: unknown;
  expected: { [K in keyof SessionView]?: unknown };
}

interface ThreadCase {
  name: string;
  message: unknown;
  expected: { [K in keyof ThreadEvent]?: unknown };
}

const rootCases: RootCase[] = [
  {
    name: "metadata card recovers the full session id and model list",
    message: metadataRoot,
    expected: {
      sessionId: "019fec89ab12cd34ef",
      bindingId: BINDING,
      channelId: CHANNEL,
      threadTs: ROOT_TS,
      title: "Review PR 1776",
      project: "slack & friends",
      status: "working",
      activity: "Thinking",
      model: { ...SOL, selector: "openai-codex/gpt-5.6-sol" },
      models: [
        { ...SOL, selector: "openai-codex/gpt-5.6-sol" },
        { ...OPUS, selector: "anthropic/claude-opus-4-6" },
      ],
      collapsed: false,
      startedAt: tsToMillis(ROOT_TS),
      updatedAt: tsToMillis(LATEST_REPLY),
      unread: 0,
      controllable: true,
    },
  },
  {
    name: "blocks fallback reads the shortcode label form",
    message: labelRoot,
    expected: {
      sessionId: "019fec89ab12",
      bindingId: BINDING,
      title: "Review PR 1776",
      project: "slack & friends",
      status: "waiting",
      activity: "",
      model: { ...SOL, selector: "openai-codex/gpt-5.6-sol" },
      models: [
        { ...SOL, selector: "openai-codex/gpt-5.6-sol" },
        { ...OPUS, selector: "anthropic/claude-opus-4-6" },
      ],
      collapsed: false,
      controllable: true,
    },
  },
  {
    name: "blocks fallback reads the unicode label form",
    message: unicodeLabelRoot,
    expected: { status: "done", activity: "", project: "slack", controllable: true },
  },
  {
    name: "blocks fallback reads the icon plus activity form and unescapes mrkdwn",
    message: activityRoot,
    expected: {
      title: "OMP 019fec89",
      status: "working",
      activity: "Reading src/api.ts",
      project: "web & api <beta>",
      controllable: true,
    },
  },
  {
    name: "unbound offline card is not controllable and has no model",
    message: unknownModelRoot,
    expected: {
      bindingId: "",
      status: "offline",
      activity: "",
      project: "Unknown",
      model: undefined,
      models: [],
      controllable: false,
    },
  },
  {
    name: "truncated title is preserved verbatim",
    message: truncatedRoot,
    expected: { title: TRUNCATED_TITLE, status: "idle", activity: "" },
  },
  {
    name: "collapsed card reports a closed, uncontrollable session",
    message: collapsedRoot,
    expected: {
      sessionId: `slack-${ROOT_TS}`,
      bindingId: "",
      title: "Review PR 1776",
      project: "slack & friends",
      status: "disabled",
      activity: "",
      collapsed: true,
      models: [],
      updatedAt: tsToMillis(LATEST_REPLY),
      controllable: false,
    },
  },
  {
    name: "expanded disabled card keeps the disabled status the black circle shares with offline",
    message: disabledRoot,
    expected: { status: "disabled", activity: "", project: "slackoff", controllable: false },
  },
];

for (const row of rootCases) {
  test(`parseSessionRoot: ${row.name}`, () => {
    const view = parseSessionRoot(row.message, CHANNEL);
    assert.ok(view, "expected a session view");
    for (const [key, value] of Object.entries(row.expected)) {
      assert.deepEqual(view[key as keyof SessionView], value, key);
    }
  });
}

test("truncated title fixture matches the daemon's 150 character limit", () => {
  assert.equal(TRUNCATED_TITLE.length, 150);
  assert.ok(TRUNCATED_TITLE.endsWith("…"));
});

const statusCases: Array<{ raw: string; status: SessionStatus; activity: string }> = [
  { raw: ":white_circle: Ready", status: "idle", activity: "" },
  { raw: "⚪ Ready", status: "idle", activity: "" },
  { raw: ":large_blue_circle: Working", status: "working", activity: "" },
  { raw: ":large_blue_circle: Reading src/api.ts", status: "working", activity: "Reading src/api.ts" },
  { raw: ":large_yellow_circle: Waiting for you", status: "waiting", activity: "" },
  { raw: "🟡 Waiting for your reply in Slack", status: "waiting", activity: "Waiting for your reply in Slack" },
  { raw: ":large_orange_circle: Stopping", status: "stopping", activity: "" },
  { raw: ":large_green_circle: Done", status: "done", activity: "" },
  { raw: "🔴 Error", status: "error", activity: "" },
  { raw: ":black_circle: Offline", status: "offline", activity: "" },
  { raw: ":black_circle: Disabled", status: "disabled", activity: "" },
  { raw: "⚫ Reconnecting", status: "offline", activity: "Reconnecting" },
  { raw: "nothing recognisable", status: "idle", activity: "nothing recognisable" },
];

for (const row of statusCases) {
  test(`parseStatusText: ${row.raw}`, () => {
    assert.deepEqual(parseStatusText(row.raw), { status: row.status, activity: row.activity });
  });
}

const nonCardCases: Array<{ name: string; message: unknown }> = [
  {
    name: "an unrelated DM the user typed",
    message: {
      ts: "1770000400.000000",
      user: "U07KR6M8L2J",
      text: "hey, is the bridge up?",
      blocks: [{ type: "rich_text", block_id: "Ab3", elements: [] }],
      metadata: null,
    },
  },
  {
    name: "a thread reply, not a root",
    message: { ts: "1770000100.000200", thread_ts: ROOT_TS, bot_id: "B07SLACKOFF", text: "Patched src/api.ts" },
  },
  {
    name: "a bot message with no blocks",
    message: { ts: "1770000100.000300", bot_id: "B07SLACKOFF", text: "Session offline; instruction was not delivered." },
  },
  { name: "a malformed message with no ts", message: { text: "nope" } },
];

for (const row of nonCardCases) {
  test(`parseSessionRoot ignores ${row.name}`, () => {
    assert.equal(parseSessionRoot(row.message, CHANNEL), undefined);
  });
}

/* ---------- thread messages ---------- */

function questionBlocks(state: "waiting" | "answered" | "cancelled", multi: boolean): unknown[] {
  const context = {
    waiting: multi ? "Reply in this thread with one or more choices." : "Reply in this thread with your choice.",
    answered: "Answered in this thread.",
    cancelled: "Question cancelled.",
  }[state];
  return [
    { type: "section", block_id: "Q1", text: { type: "mrkdwn", text: "*OMP needs your input*\nHow should I land PR &lt;1776&gt;?" } },
    {
      type: "section",
      block_id: "Q2",
      text: {
        type: "mrkdwn",
        text: "1. *Rebase &amp; merge* — Replay onto main\n2. *Squash*\n3. *Wait for review*",
      },
    },
    { type: "context", block_id: "Q3", elements: [{ type: "mrkdwn", text: context }] },
  ];
}

const daemonUserEcho = {
  bot_id: "B07SLACKOFF",
  ts: "1770000100.000200",
  thread_ts: ROOT_TS,
  text: "Local instruction: ship it &amp; run the tests",
  blocks: [
    {
      type: "section",
      block_id: "L1",
      text: { type: "mrkdwn", text: "*Local instruction*\nship it &amp; run the tests" },
    },
  ],
  metadata: buildTranscriptMetadata({ sessionId: "019fec89ab12cd34ef", bindingId: BINDING, role: "user", chunk: 0, chunks: 1 }),
};

const legacyUserEcho = {
  bot_id: "B07SLACKOFF",
  ts: "1770000101.000200",
  thread_ts: ROOT_TS,
  text: "Local instruction: rerun the suite",
  blocks: [{ type: "section", block_id: "L2", text: { type: "mrkdwn", text: "*Local instruction*\nrerun the suite" } }],
  metadata: null,
};

const typedByUser = {
  ts: "1770000102.000300",
  thread_ts: ROOT_TS,
  user: "U07KR6M8L2J",
  text: "./review <https://github.com/x/y/pull/1776/changes|github.com/x/y/pull…> cc <@U04TEAMMATE> <!here>",
  blocks: [{ type: "rich_text", block_id: "R1", elements: [] }],
  metadata: null,
};

const assistantReply = {
  bot_id: "B07SLACKOFF",
  ts: "1770000103.000400",
  thread_ts: ROOT_TS,
  text: "Patched src/api.ts & the tests",
  blocks: [{ type: "section", block_id: "A1", text: { type: "mrkdwn", text: "Patched src/api.ts &amp; the tests" } }],
  metadata: null,
};

const notice = {
  bot_id: "B07SLACKOFF",
  ts: "1770000104.000500",
  thread_ts: ROOT_TS,
  text: "Session offline; instruction was not delivered.",
  metadata: null,
};

const modelErrorNotice = {
  bot_id: "B07SLACKOFF",
  ts: "1770000105.000600",
  thread_ts: ROOT_TS,
  text: "Could not change model: unknown provider",
  metadata: null,
};

const waitingQuestion = {
  bot_id: "B07SLACKOFF",
  ts: "1770000106.000700",
  thread_ts: ROOT_TS,
  text: "Question: How should I land PR <1776>?",
  blocks: questionBlocks("waiting", false),
  metadata: buildQuestionMetadata({
    sessionId: "019fec89ab12cd34ef",
    bindingId: BINDING,
    questionId: "q-42",
    multi: false,
    state: "waiting",
    options: [{ label: "Rebase & merge", description: "Replay onto main" }, { label: "Squash" }, { label: "Wait for review" }],
  }),
};

const legacyMultiQuestion = {
  bot_id: "B07SLACKOFF",
  ts: "1770000107.000800",
  thread_ts: ROOT_TS,
  text: "Question: How should I land PR <1776>?",
  blocks: questionBlocks("waiting", true),
  metadata: null,
};

const answeredQuestion = {
  bot_id: "B07SLACKOFF",
  ts: "1770000108.000900",
  thread_ts: ROOT_TS,
  text: "Answered question: How should I land PR <1776>?",
  blocks: questionBlocks("answered", false),
  metadata: null,
};

const cancelledQuestion = {
  bot_id: "B07SLACKOFF",
  ts: "1770000109.001000",
  thread_ts: ROOT_TS,
  text: "Cancelled question: How should I land PR <1776>?",
  blocks: questionBlocks("cancelled", false),
  metadata: null,
};

const LEGACY_OPTIONS = [
  { label: "Rebase & merge", description: "Replay onto main" },
  { label: "Squash" },
  { label: "Wait for review" },
];

const threadCases: ThreadCase[] = [
  {
    name: "daemon user echo with transcript metadata",
    message: daemonUserEcho,
    expected: { kind: "user", text: "ship it & run the tests", ts: "1770000100.000200", at: tsToMillis("1770000100.000200") },
  },
  {
    name: "daemon user echo without metadata",
    message: legacyUserEcho,
    expected: { kind: "user", text: "rerun the suite" },
  },
  {
    name: "message the user typed in Slack, links flattened",
    message: typedByUser,
    expected: { kind: "user", text: "./review github.com/x/y/pull… cc @U04TEAMMATE @here" },
  },
  {
    name: "assistant transcript chunk",
    message: assistantReply,
    expected: { kind: "assistant", text: "Patched src/api.ts & the tests" },
  },
  {
    name: "plain-text daemon notice",
    message: notice,
    expected: { kind: "notice", text: "Session offline; instruction was not delivered." },
  },
  {
    name: "prefixed daemon notice",
    message: modelErrorNotice,
    expected: { kind: "notice", text: "Could not change model: unknown provider" },
  },
  {
    name: "waiting question with metadata",
    message: waitingQuestion,
    expected: {
      kind: "question",
      text: "How should I land PR <1776>?",
      question: {
        questionId: "q-42",
        ts: "1770000106.000700",
        prompt: "How should I land PR <1776>?",
        options: LEGACY_OPTIONS,
        multi: false,
        askedAt: tsToMillis("1770000106.000700"),
      },
    },
  },
  {
    name: "waiting multi question parsed from blocks only",
    message: legacyMultiQuestion,
    expected: {
      kind: "question",
      question: {
        questionId: "question-1770000107.000800",
        ts: "1770000107.000800",
        prompt: "How should I land PR <1776>?",
        options: LEGACY_OPTIONS,
        multi: true,
        askedAt: tsToMillis("1770000107.000800"),
      },
    },
  },
  {
    name: "answered question card",
    message: answeredQuestion,
    expected: { kind: "answered" },
  },
  {
    name: "cancelled question card",
    message: cancelledQuestion,
    expected: { kind: "cancelled" },
  },
];

for (const row of threadCases) {
  test(`parseThreadMessage: ${row.name}`, () => {
    const event = parseThreadMessage(row.message);
    for (const [key, value] of Object.entries(row.expected)) {
      assert.deepEqual(event[key as keyof ThreadEvent], value, key);
    }
  });
}

test("reduceThread orders replies, drops the root, and exposes the live question", () => {
  const { events, pendingQuestion } = reduceThread([
    waitingQuestion,
    metadataRoot,
    assistantReply,
    daemonUserEcho,
  ]);

  assert.deepEqual(
    events.map((event) => event.kind),
    ["user", "assistant", "question"],
  );
  assert.equal(pendingQuestion?.questionId, "q-42");
  assert.equal(pendingQuestion?.ts, "1770000106.000700");
});

test("reduceThread treats a superseded question as settled", () => {
  const { pendingQuestion } = reduceThread([metadataRoot, waitingQuestion, answeredQuestion]);
  assert.equal(pendingQuestion, undefined);
});

test("reduceThread keeps the newest question when an older one was cancelled", () => {
  const reasked = { ...legacyMultiQuestion, ts: "1770000110.001100" };
  const { pendingQuestion } = reduceThread([metadataRoot, cancelledQuestion, reasked]);
  assert.equal(pendingQuestion?.multi, true);
  assert.equal(pendingQuestion?.ts, "1770000110.001100");
});

/* ---------- merge ---------- */

function session(overrides: Partial<SessionView> & Pick<SessionView, "sessionId">): SessionView {
  return {
    bindingId: BINDING,
    channelId: CHANNEL,
    threadTs: ROOT_TS,
    title: overrides.sessionId,
    project: "slackoff",
    status: "idle",
    activity: "",
    models: [],
    collapsed: false,
    startedAt: 1_000,
    updatedAt: 1_000,
    unread: 0,
    controllable: true,
    ...overrides,
  };
}

test("mergeSessions carries unread forward and increments on new activity", () => {
  const previous = [session({ sessionId: "a", unread: 2, updatedAt: 1_000 })];
  const next = [session({ sessionId: "a", updatedAt: 2_000 })];

  const merged = mergeSessions(previous, next, { now: () => 9_999 });

  assert.equal(merged[0]?.unread, 3);
  assert.equal(merged[0]?.updatedAt, 2_000);
});

test("mergeSessions leaves unread alone when nothing advanced", () => {
  const previous = [session({ sessionId: "a", unread: 2, updatedAt: 2_000 })];
  const next = [session({ sessionId: "a", updatedAt: 2_000 })];

  const merged = mergeSessions(previous, next, { now: () => 9_999 });

  assert.equal(merged[0]?.unread, 2);
  assert.equal(merged[0]?.updatedAt, 2_000);
});

test("mergeSessions stamps the injected clock when only the status changed", () => {
  const previous = [session({ sessionId: "a", updatedAt: 2_000, status: "idle" })];
  const next = [session({ sessionId: "a", updatedAt: 2_000, status: "working", activity: "Thinking" })];

  const merged = mergeSessions(previous, next, { now: () => 9_999 });

  assert.equal(merged[0]?.updatedAt, 9_999);
});

test("mergeSessions clears unread for the selected session and never counts it", () => {
  const previous = [session({ sessionId: "a", unread: 5, updatedAt: 1_000 })];
  const next = [session({ sessionId: "a", updatedAt: 2_000 })];

  const merged = mergeSessions(previous, next, { now: () => 9_999, selectedSessionId: "a" });

  assert.equal(merged[0]?.unread, 0);
});

test("mergeSessions carries a pending question the root card cannot see", () => {
  const question = {
    questionId: "q-42",
    ts: "1770000106.000700",
    prompt: "Land it?",
    options: [{ label: "Yes" }],
    multi: false,
    askedAt: 5,
  };
  const previous = [session({ sessionId: "a", pendingQuestion: question })];
  const next = [session({ sessionId: "a" })];

  const merged = mergeSessions(previous, next, { now: () => 9_999 });

  assert.deepEqual(merged[0]?.pendingQuestion, question);
});

test("mergeSessions sorts attention, then working, then most recent", () => {
  const previous: SessionView[] = [];
  const next = [
    session({ sessionId: "stale", status: "done", updatedAt: 1_000 }),
    session({ sessionId: "fresh", status: "idle", updatedAt: 8_000 }),
    session({ sessionId: "busy", status: "working", updatedAt: 2_000 }),
    session({ sessionId: "asked", status: "idle", updatedAt: 500, pendingQuestion: {
      questionId: "q", ts: "1", prompt: "p", options: [], multi: false, askedAt: 1,
    } }),
    session({ sessionId: "waits", status: "waiting", updatedAt: 400 }),
  ];

  const merged = mergeSessions(previous, next, { now: () => 9_999 });

  assert.deepEqual(
    merged.map((entry) => entry.sessionId),
    ["asked", "waits", "busy", "fresh", "stale"],
  );
});
