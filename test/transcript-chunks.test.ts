import assert from "node:assert/strict";
import test from "node:test";

import { escapeMrkdwn } from "../src/daemon/blocks.js";
import { splitTranscriptText } from "../src/daemon/transcript.js";

function assertExactChunks(source: string, maximum: number): string[] {
  const chunks = splitTranscriptText(source, maximum);
  assert.equal(chunks.join(""), source.trim());
  for (const chunk of chunks) {
    assert.ok(escapeMrkdwn(chunk).length <= maximum, `escaped chunk exceeds ${maximum} characters`);
  }
  return chunks;
}

test("transcript chunks preserve paragraph separators exactly", () => {
  const source = `${"x".repeat(14)}\n\n${"y".repeat(20)}`;
  const chunks = assertExactChunks(source, 20);

  assert.equal(chunks[0], `${"x".repeat(14)}\n\n`);
  assert.equal(chunks[1], "y".repeat(20));
});

test("transcript chunk budgets apply after Slack mrkdwn escaping", () => {
  const chunks = assertExactChunks("<&><&>", 13);

  assert.deepEqual(chunks, ["<&>", "<&>"]);
  assert.deepEqual(chunks.map((chunk) => escapeMrkdwn(chunk).length), [13, 13]);
});

test("hard transcript boundaries never split a Unicode code point", () => {
  const source = `${"x".repeat(19)}🦥tail`;
  const chunks = assertExactChunks(source, 20);

  assert.equal(chunks[0], "x".repeat(19));
  assert.ok(chunks[1]?.startsWith("🦥"));
});
