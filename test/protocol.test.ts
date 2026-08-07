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
