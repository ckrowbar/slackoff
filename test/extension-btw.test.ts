import assert from "node:assert/strict";
import test from "node:test";

import { forwardBtwLifecycleEvent, type BtwLifecycleEvent } from "../src/extension.js";
import type { ClientMessage } from "../src/protocol.js";

test("forwards BTW lifecycle events with the registered session identity", () => {
  const sent: ClientMessage[] = [];
  const events: BtwLifecycleEvent[] = [
    { type: "btw_start", requestId: "btw-1", question: "What changed?" },
    { type: "btw_update", requestId: "btw-1", delta: "The parser " },
    {
      type: "btw_end",
      requestId: "btw-1",
      question: "What changed?",
      outcome: "completed",
      answer: "The parser was fixed.",
    },
  ];

  for (const event of events) {
    assert.equal(
      forwardBtwLifecycleEvent(event, { enabled: true, sessionId: "session-1" }, (message) => {
        sent.push(message);
        return true;
      }),
      true,
    );
  }

  assert.deepEqual(
    sent.map((message) => ({ type: message.type, sessionId: "sessionId" in message ? message.sessionId : undefined })),
    events.map((event) => ({ type: event.type, sessionId: "session-1" })),
  );
  assert.deepEqual(sent[2], { ...events[2]!, sessionId: "session-1" });
});

test("does not forward BTW events before registration or while disabled", () => {
  let sends = 0;
  const send = (): boolean => {
    sends += 1;
    return true;
  };
  const event: BtwLifecycleEvent = { type: "btw_start", requestId: "btw-1", question: "What changed?" };

  assert.equal(forwardBtwLifecycleEvent(event, { enabled: false, sessionId: "session-1" }, send), false);
  assert.equal(forwardBtwLifecycleEvent(event, { enabled: true }, send), false);
  assert.equal(sends, 0);
});
