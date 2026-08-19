import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQuestionMetadata,
  buildSessionMetadata,
  buildTranscriptMetadata,
  METADATA_VERSION,
  parseMessageMetadata,
  QUESTION_METADATA_EVENT,
  SESSION_METADATA_EVENT,
  TRANSCRIPT_METADATA_EVENT,
  type MessageMetadata,
} from "../src/metadata.js";

const models = [
  { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
];

const sessionMetadata = buildSessionMetadata({
  sessionId: "session-123456789",
  bindingId: "binding-1",
  title: "Fix parser",
  project: "slackoff",
  status: "working",
  activity: "Editing src/parser.ts",
  collapsed: false,
  connected: true,
  model: models[0],
  models,
  effort: "high",
  efforts: ["off", "low", "medium", "high"],
});

const transcriptMetadata = buildTranscriptMetadata({
  sessionId: "session-123456789",
  bindingId: "binding-1",
  role: "assistant",
  chunk: 2,
  chunks: 3,
});

const questionOptions = [{ label: "Keep going" }, { label: "Revert", description: "Undo the parser change" }];

const questionMetadata = buildQuestionMetadata({
  sessionId: "session-123456789",
  bindingId: "binding-1",
  questionId: "question-1",
  multi: true,
  state: "waiting",
  options: questionOptions,
});

function assertFlatPrimitives(metadata: MessageMetadata): void {
  assert.match(metadata.event_type, /^[a-z0-9_]+$/);
  for (const [key, value] of Object.entries(metadata.event_payload)) {
    assert.ok(
      typeof value === "string" || typeof value === "number" || typeof value === "boolean",
      `${metadata.event_type}.${key} must be a primitive, got ${typeof value}`,
    );
    assert.notEqual(value, null);
  }
}

test("every builder emits a flat primitive payload Slack will accept", () => {
  for (const metadata of [sessionMetadata, transcriptMetadata, questionMetadata]) {
    assertFlatPrimitives(metadata);
  }
  assert.equal(sessionMetadata.event_type, SESSION_METADATA_EVENT);
  assert.equal(transcriptMetadata.event_type, TRANSCRIPT_METADATA_EVENT);
  assert.equal(questionMetadata.event_type, QUESTION_METADATA_EVENT);
});

test("session metadata round-trips with the model list decoded", () => {
  const parsed = parseMessageMetadata(sessionMetadata);
  assert.ok(parsed && parsed.kind === "session");
  assert.deepEqual(parsed.payload, {
    v: METADATA_VERSION,
    sessionId: "session-123456789",
    bindingId: "binding-1",
    title: "Fix parser",
    project: "slackoff",
    status: "working",
    activity: "Editing src/parser.ts",
    collapsed: false,
    connected: true,
    model: "openai-codex/gpt-5.6-sol",
    effort: "high",
    efforts: ["off", "low", "medium", "high"],
    models,
  });
});

test("session metadata remains compatible with cards written before connected state", () => {
  const { connected: _connected, ...event_payload } = sessionMetadata.event_payload;
  const parsed = parseMessageMetadata({ event_type: SESSION_METADATA_EVENT, event_payload });
  assert.ok(parsed && parsed.kind === "session");
  assert.equal(parsed.payload.connected, undefined);
});

test("session metadata keeps an absent model and empty activity distinguishable", () => {
  const parsed = parseMessageMetadata(
    buildSessionMetadata({
      sessionId: "session-1",
      bindingId: "binding-1",
      title: "Closed work",
      project: "",
      status: "disabled",
      activity: undefined,
      collapsed: true,
      connected: false,
      model: undefined,
      models: [],
    }),
  );
  assert.ok(parsed && parsed.kind === "session");
  assert.equal(parsed.payload.model, "");
  assert.equal(parsed.payload.activity, "");
  assert.equal(parsed.payload.collapsed, true);
  assert.equal(parsed.payload.connected, false);
  assert.deepEqual(parsed.payload.models, []);
});

test("transcript metadata round-trips chunk indices", () => {
  const parsed = parseMessageMetadata(transcriptMetadata);
  assert.ok(parsed && parsed.kind === "transcript");
  assert.deepEqual(parsed.payload, {
    v: METADATA_VERSION,
    sessionId: "session-123456789",
    bindingId: "binding-1",
    role: "assistant",
    chunk: 2,
    chunks: 3,
  });
});

test("question metadata round-trips options with optional descriptions", () => {
  const parsed = parseMessageMetadata(questionMetadata);
  assert.ok(parsed && parsed.kind === "question");
  assert.deepEqual(parsed.payload, {
    v: METADATA_VERSION,
    sessionId: "session-123456789",
    bindingId: "binding-1",
    questionId: "question-1",
    multi: true,
    state: "waiting",
    options: questionOptions,
  });
});

test("unreadable metadata falls back to undefined instead of throwing", () => {
  const cases: Array<{ name: string; raw: unknown }> = [
    { name: "absent metadata", raw: undefined },
    { name: "empty envelope", raw: {} },
    { name: "payload without an event type", raw: { event_payload: sessionMetadata.event_payload } },
    {
      name: "another app's event type",
      raw: { event_type: "other_app_thing", event_payload: sessionMetadata.event_payload },
    },
    {
      name: "missing required field",
      raw: {
        event_type: SESSION_METADATA_EVENT,
        event_payload: { ...sessionMetadata.event_payload, bindingId: undefined },
      },
    },
    {
      name: "future version",
      raw: {
        event_type: SESSION_METADATA_EVENT,
        event_payload: { ...sessionMetadata.event_payload, v: METADATA_VERSION + 1 },
      },
    },
    {
      name: "malformed models JSON",
      raw: {
        event_type: SESSION_METADATA_EVENT,
        event_payload: { ...sessionMetadata.event_payload, models: "[{provider:" },
      },
    },
    {
      name: "malformed efforts JSON",
      raw: {
        event_type: SESSION_METADATA_EVENT,
        event_payload: { ...sessionMetadata.event_payload, efforts: "[high" },
      },
    },
    {
      name: "models JSON of the wrong shape",
      raw: {
        event_type: SESSION_METADATA_EVENT,
        event_payload: { ...sessionMetadata.event_payload, models: JSON.stringify([{ provider: "openai" }]) },
      },
    },
    {
      name: "unknown question state",
      raw: {
        event_type: QUESTION_METADATA_EVENT,
        event_payload: { ...questionMetadata.event_payload, state: "pending" },
      },
    },
  ];

  for (const { name, raw } of cases) {
    assert.equal(parseMessageMetadata(raw), undefined, `expected undefined for ${name}`);
  }
});
