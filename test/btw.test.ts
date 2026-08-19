import assert from "node:assert/strict";
import test from "node:test";

import { buildBtwBlocks, buildBtwText } from "../src/daemon/slack.js";
import {
  abortBtwRequests,
  appendBtwDelta,
  completeBtwRequest,
  finishBtwRequest,
  startBtwRequest,
  type ActiveSession,
} from "../src/daemon/registry.js";

function session(): ActiveSession {
  return {
    session: {
      id: "session-1",
      title: "Fix parser",
      project: "slackoff",
      modelState: { available: [] },
    },
    binding: { bindingId: "binding-1", channelId: "D01", threadTs: "1770000000.000100" },
    socket: undefined,
    status: "working",
    activity: "Thinking",
    collapsed: false,
    pendingQuestion: undefined,
    btwRequests: new Map(),
    finishedBtwRequestIds: new Set(),
  };
}

test("snapshots the complete Slack binding when a BTW request starts", () => {
  const record = session();
  const request = startBtwRequest(record, "btw-1", "What changed?");
  assert.ok(request);
  record.binding = { bindingId: "binding-2", channelId: "D02", threadTs: "1770000009.000900" };

  assert.deepEqual(
    { bindingId: request.bindingId, channelId: request.channelId, threadTs: request.threadTs },
    { bindingId: "binding-1", channelId: "D01", threadTs: "1770000000.000100" },
  );
});

test("tracks overlapping BTW requests solely by requestId and ignores late terminal traffic", () => {
  const record = session();
  const older = startBtwRequest(record, "btw-old", "Old question");
  const newer = startBtwRequest(record, "btw-new", "New question");
  assert.ok(older && newer);
  older.messageTs = "1770000001.000100";
  newer.messageTs = "1770000002.000100";

  appendBtwDelta(record, "btw-new", "new partial");
  appendBtwDelta(record, "btw-old", "old partial");
  finishBtwRequest(record, "btw-old", { question: "Old question", outcome: "aborted" });
  assert.equal(appendBtwDelta(record, "btw-old", " late"), undefined);
  assert.equal(
    finishBtwRequest(record, "btw-old", {
      question: "Old question",
      outcome: "completed",
      answer: "duplicate terminal answer",
    }),
    undefined,
  );
  finishBtwRequest(record, "btw-new", {
    question: "New question",
    outcome: "completed",
    answer: "new final answer",
  });

  assert.equal(record.btwRequests.get("btw-old")?.outcome, "aborted");
  assert.equal(record.btwRequests.get("btw-old")?.answer, "old partial");
  assert.equal(record.btwRequests.get("btw-new")?.outcome, "completed");
  assert.equal(record.btwRequests.get("btw-new")?.answer, "new final answer");
  completeBtwRequest(record, older);
  completeBtwRequest(record, newer);
  assert.equal(
    finishBtwRequest(record, "btw-old", {
      question: "Old question",
      outcome: "aborted",
    }),
    undefined,
  );
  assert.equal(record.btwRequests.size, 0);
  assert.equal(
    finishBtwRequest(record, "btw-ended-first", {
      question: "Already done?",
      outcome: "completed",
      answer: "Yes.",
    }),
    undefined,
  );
  assert.equal(record.btwRequests.has("btw-ended-first"), false);
  assert.ok(startBtwRequest(record, "btw-ended-first", "Late start"));
  assert.equal(startBtwRequest(record, "btw-old", "Late duplicate start"), undefined);
});

test("socket-loss cancellation aborts every active BTW request without changing session status", () => {
  const record = session();
  startBtwRequest(record, "btw-1", "First question");
  startBtwRequest(record, "btw-2", "Second question");
  const completed = finishBtwRequest(record, "btw-1", {
    question: "First question",
    outcome: "completed",
    answer: "done",
  });
  assert.ok(completed);
  completeBtwRequest(record, completed);

  const aborted = abortBtwRequests(record);
  assert.deepEqual(aborted.map((request) => request.requestId), ["btw-2"]);
  assert.equal(record.btwRequests.get("btw-2")?.outcome, "aborted");
  for (const request of aborted) completeBtwRequest(record, request);
  assert.equal(record.btwRequests.size, 0);
  assert.equal(record.status, "working");
  assert.equal(record.activity, "Thinking");
});

test("retains only bounded requestId tombstones after terminal cards settle", () => {
  const record = session();
  for (let index = 0; index < 129; index += 1) {
    const request = startBtwRequest(record, `btw-${index}`, `Question ${index}`);
    assert.ok(request);
    finishBtwRequest(record, request.requestId, {
      question: request.question,
      outcome: "completed",
      answer: `Answer ${index}`,
    });
    completeBtwRequest(record, request);
  }

  assert.equal(record.btwRequests.size, 0);
  assert.equal(record.finishedBtwRequestIds.size, 128);
  assert.equal(record.finishedBtwRequestIds.has("btw-0"), false);
  assert.equal(record.finishedBtwRequestIds.has("btw-128"), true);
});

test("renders a distinct final BTW card with a non-persistence notice", () => {
  const record = session();
  const request = startBtwRequest(record, "btw-1", "Did the parser pass?");
  assert.ok(request);
  finishBtwRequest(record, "btw-1", {
    question: "Did the parser pass?",
    outcome: "completed",
    answer: "Yes, all focused checks passed.",
  });

  const rendered = JSON.stringify(buildBtwBlocks(request));
  assert.match(rendered, /BTW · Completed/);
  assert.match(rendered, /Yes, all focused checks passed/);
  assert.match(rendered, /Not saved to the OMP transcript/);
  assert.match(buildBtwText(request), /^BTW Completed:/);
});
