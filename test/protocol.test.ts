import assert from "node:assert/strict";
import test from "node:test";

import { ClientMessageSchema, PROTOCOL_VERSION, ServerMessageSchema } from "../src/protocol.js";

test("accepts the current register protocol", () => {
  const result = ClientMessageSchema.safeParse({
    type: "register",
    requestId: "request-1",
    protocolVersion: PROTOCOL_VERSION,
    session: { id: "session-1", title: "Fix parser", project: "project" },
  });

  assert.equal(result.success, true);
});

test("rejects a client with an incompatible protocol version", () => {
  const result = ClientMessageSchema.safeParse({
    type: "register",
    requestId: "request-1",
    protocolVersion: 2,
    session: { id: "session-1", title: "Fix parser", project: "project" },
  });

  assert.equal(result.success, false);
});

test("rejects an instruction without a command identifier", () => {
  const result = ServerMessageSchema.safeParse({
    type: "instruction",
    sessionId: "session-1",
    text: "continue",
  });

  assert.equal(result.success, false);
});

test("accepts a bounded Slack question request", () => {
  const result = ClientMessageSchema.safeParse({
    type: "question",
    requestId: "request-2",
    sessionId: "session-1",
    questionId: "question-1",
    prompt: "Which direction should I take?",
    options: [{ label: "Minimal fix" }, { label: "Broader refactor", description: "Clean up adjacent code." }],
    multi: false,
  });

  assert.equal(result.success, true);
});

test("rejects a Slack question with too many options", () => {
  const result = ClientMessageSchema.safeParse({
    type: "question",
    requestId: "request-2",
    sessionId: "session-1",
    questionId: "question-1",
    prompt: "Choose one",
    options: Array.from({ length: 6 }, (_, index) => ({ label: `Option ${index + 1}` })),
    multi: false,
  });

  assert.equal(result.success, false);
});

test("accepts a native thread reply as a question answer", () => {
  const result = ServerMessageSchema.safeParse({
    type: "question_answer",
    sessionId: "session-1",
    questionId: "question-1",
    answer: "Minimal fix",
  });

  assert.equal(result.success, true);
});
