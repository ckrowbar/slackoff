import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInstructionModal,
  buildSessionBlocks,
  INSTRUCTION_VIEW,
  SEND_INSTRUCTION_ACTION,
  STOP_ACTION,
} from "../src/daemon/blocks.js";

const session = { id: "session-123456789", title: "Fix parser", project: "project" };

test("active session card exposes binding-scoped controls", () => {
  const blocks = buildSessionBlocks(session, "binding-1", "working", "Editing", "just now");
  const serialized = JSON.stringify(blocks);

  assert.match(serialized, new RegExp(SEND_INSTRUCTION_ACTION));
  assert.match(serialized, new RegExp(STOP_ACTION));
  assert.match(serialized, /binding-1/);
  assert.match(serialized, /Editing/);
});

test("offline session card does not expose controls", () => {
  const blocks = buildSessionBlocks(session, "binding-1", "offline", undefined, "1m ago");
  const serialized = JSON.stringify(blocks);

  assert.doesNotMatch(serialized, new RegExp(SEND_INSTRUCTION_ACTION));
  assert.doesNotMatch(serialized, new RegExp(STOP_ACTION));
});

test("instruction modal routes submission by opaque binding ID", () => {
  const modal = buildInstructionModal("binding-1", session.title);

  assert.equal(modal.callback_id, INSTRUCTION_VIEW);
  assert.equal(modal.private_metadata, "binding-1");
});
