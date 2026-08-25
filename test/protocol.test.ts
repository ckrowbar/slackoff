import assert from "node:assert/strict";
import test from "node:test";

import { ClientMessageSchema, PROTOCOL_VERSION, ServerMessageSchema } from "../src/protocol.js";
const modelState = {
  current: { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  available: [{ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
};


test("accepts the current register protocol", () => {
  const result = ClientMessageSchema.safeParse({
    type: "register",
    requestId: "request-1",
    protocolVersion: PROTOCOL_VERSION,
    session: { id: "session-1", title: "Fix parser", project: "project", modelState },
    status: "working",
    activity: "Thinking",
  });

  assert.equal(result.success, true);
  if (result.success && result.data.type === "register") {
    assert.equal(result.data.status, "working");
    assert.equal(result.data.activity, "Thinking");
  }
});

test("accepts legacy register protocols without model state", () => {
  const result = ClientMessageSchema.safeParse({
    type: "register",
    requestId: "request-legacy",
    protocolVersion: 1,
    session: { id: "session-1", title: "Fix parser", project: "project" },
  });

  assert.equal(result.success, true);
  if (result.success && result.data.type === "register") {
    assert.deepEqual(result.data.session.modelState, { available: [] });
    assert.equal(result.data.status, "idle");
  }
});

test("rejects a client newer than the daemon protocol", () => {
  const result = ClientMessageSchema.safeParse({
    type: "register",
    requestId: "request-newer",
    protocolVersion: PROTOCOL_VERSION + 1,
    session: { id: "session-1", title: "Fix parser", project: "project", modelState },
  });

  assert.equal(result.success, false);
});
test("accepts per-session model state and selection commands", () => {
  const stateResult = ClientMessageSchema.safeParse({
    type: "model_state",
    sessionId: "session-1",
    commandId: "command-1",
    modelState,
  });
  const selectionResult = ServerMessageSchema.safeParse({
    type: "set_model",
    sessionId: "session-1",
    commandId: "command-1",
    selector: "openai-codex/gpt-5.6-sol",
  });

  assert.equal(stateResult.success, true);
  assert.equal(selectionResult.success, true);
});

test("accepts model effort state and selection commands", () => {
  const stateResult = ClientMessageSchema.safeParse({
    type: "model_state",
    sessionId: "session-1",
    modelState: {
      ...modelState,
      effort: { current: "high", available: ["off", "low", "medium", "high"] },
    },
  });
  const selectionResult = ServerMessageSchema.safeParse({
    type: "set_effort",
    sessionId: "session-1",
    commandId: "command-effort-1",
    effort: "high",
  });

  assert.equal(stateResult.success, true);
  assert.equal(selectionResult.success, true);
});

test("accepts live session title updates", () => {
  assert.equal(
    ClientMessageSchema.safeParse({
      type: "session_title",
      sessionId: "session-1",
      title: "Investigate parser regression",
    }).success,
    true,
  );
});

test("accepts one-line OMP slash commands and rejects prompts", () => {
  const command = {
    type: "execute_slash_command",
    sessionId: "session-1",
    commandId: "command-1",
    command: "/compact keep the implementation details",
  };

  assert.equal(ServerMessageSchema.safeParse(command).success, true);
  assert.equal(ServerMessageSchema.safeParse({ ...command, command: "plain prompt" }).success, false);
  assert.equal(ServerMessageSchema.safeParse({ ...command, command: "/compact\nthen continue" }).success, false);
});


test("rejects an instruction without a command identifier", () => {
  const result = ServerMessageSchema.safeParse({
    type: "instruction",
    sessionId: "session-1",
    text: "continue",
  });

  assert.equal(result.success, false);
});
test("accepts image-only instructions and rejects empty instructions", () => {
  const imageInstruction = {
    type: "instruction",
    sessionId: "session-1",
    commandId: "command-1",
    text: "",
    images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
  };

  assert.equal(ServerMessageSchema.safeParse(imageInstruction).success, true);
  assert.equal(ServerMessageSchema.safeParse({ ...imageInstruction, images: [] }).success, false);
});

test("rejects instructions with more than ten images", () => {
  const result = ServerMessageSchema.safeParse({
    type: "instruction",
    sessionId: "session-1",
    commandId: "command-1",
    text: "",
    images: Array.from({ length: 11 }, () => ({ data: "iVBORw0KGgo=", mimeType: "image/png" })),
  });

  assert.equal(result.success, false);
});


test("accepts a closed-session replacement notice", () => {
  const result = ServerMessageSchema.safeParse({
    type: "replaced",
    sessionId: "session-1",
    reason: "closed",
  });

  assert.equal(result.success, true);
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

test("accepts the BTW lifecycle protocol and rejects incomplete identities", () => {
  const lifecycle = [
    {
      type: "btw_start",
      sessionId: "session-1",
      requestId: "btw-1",
      question: "What changed?",
    },
    {
      type: "btw_update",
      sessionId: "session-1",
      requestId: "btw-1",
      delta: "The parser ",
    },
    {
      type: "btw_end",
      sessionId: "session-1",
      requestId: "btw-1",
      question: "What changed?",
      outcome: "completed",
      answer: "The parser was fixed.",
    },
  ];

  for (const message of lifecycle) assert.equal(ClientMessageSchema.safeParse(message).success, true);
  assert.equal(ClientMessageSchema.safeParse({ ...lifecycle[0], requestId: "" }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ ...lifecycle[2], outcome: "cancelled" }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ ...lifecycle[2], answer: undefined }).success, false);
  assert.equal(
    ClientMessageSchema.safeParse({
      ...lifecycle[2],
      outcome: "aborted",
      answer: undefined,
    }).success,
    true,
  );
});
