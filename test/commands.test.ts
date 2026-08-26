import assert from "node:assert/strict";
import test from "node:test";

import { parseThreadCommand, type ThreadCommand } from "../src/daemon/commands.js";

const accepted: Array<{ input: string; expected: ThreadCommand }> = [
  { input: "!stop", expected: { kind: "stop" } },
  { input: "!STOP", expected: { kind: "stop" } },
  { input: "  !stop  ", expected: { kind: "stop" } },
  { input: "!Stop", expected: { kind: "stop" } },
  { input: "!close", expected: { kind: "close", closeTmux: false } },
  { input: "!CLOSE", expected: { kind: "close", closeTmux: false } },
  { input: " !close TMUX ", expected: { kind: "close", closeTmux: true } },
  {
    input: "!model openai-codex/gpt-5.6-sol",
    expected: { kind: "model", selector: "openai-codex/gpt-5.6-sol" },
  },
  {
    input: "  !MODEL   anthropic/claude-opus-4-6  ",
    expected: { kind: "model", selector: "anthropic/claude-opus-4-6" },
  },
  {
    input: "!model bedrock/anthropic.claude-3:1",
    expected: { kind: "model", selector: "bedrock/anthropic.claude-3:1" },
  },
  { input: "!effort HIGH", expected: { kind: "effort", effort: "high" } },
  { input: "  !EFFORT   xhigh  ", expected: { kind: "effort", effort: "xhigh" } },
  { input: "!omp compact", expected: { kind: "omp", command: "/compact" } },
  {
    input: "  !OMP   skill:review   1234  ",
    expected: { kind: "omp", command: "/skill:review 1234" },
  },
  {
    input: "!omp model openai-codex/gpt-5.6-sol",
    expected: { kind: "omp", command: "/model openai-codex/gpt-5.6-sol" },
  },
  {
    input: "!omp btw what files changed?",
    expected: { kind: "omp", command: "/btw what files changed?" },
  },
];

const rejected = [
  "",
  "   ",
  "!",
  "!!stop",
  "!stop now",
  "!closed",
  "!clos",
  "!close process",
  "!close tmux now",
  "!model",
  "!model a b",
  "!model bad selector",
  "!model openai-codex",
  "!model /gpt-5.6-sol",
  "!effort",
  "!effort default",
  "!effort high extra",
  "!effort enormous",
  "!model -openai/gpt",
  "!model openai codex/gpt",
  "!stop\nplease revert the parser change",
  "!stop\ttail",
  "!model openai-codex/gpt-5.6-sol\n!stop",
  "!omp",
  "!omp /compact",
  "!omp compact\nthen continue",
  "stop",
  "Please stop the current turn",
  "Run `!stop` when the build breaks",
];

test("thread commands parse case-insensitively with surrounding whitespace", () => {
  for (const { input, expected } of accepted) {
    assert.deepEqual(parseThreadCommand(input), expected, `expected a command for ${JSON.stringify(input)}`);
  }
});

test("anything that is not an exact single-line command stays an instruction", () => {
  for (const input of rejected) {
    assert.equal(parseThreadCommand(input), undefined, `expected no command for ${JSON.stringify(input)}`);
  }
});
