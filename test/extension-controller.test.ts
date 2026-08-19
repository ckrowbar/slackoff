import assert from "node:assert/strict";
import test from "node:test";

import { buildQuestionMetadata, buildSessionMetadata, buildTranscriptMetadata } from "../src/metadata.js";
import type { SessionStatus } from "../src/protocol.js";
import {
  parseSessionLaunchRequest,
  SESSION_LAUNCH_SUCCESS_PREFIX,
} from "../src/session-launch.js";
import { createSlackController, type ControllerDeps } from "../extension/src/app/controller.js";
import type { Controller, SessionView } from "../extension/src/types.js";

const CHANNEL = "D07SLACKOFF";
const BINDING = "b1d3f2c4-8a71-4f1e-9c2b-77a0d5e4c310";
const SESSION_ID = "019fec89ab12cd34ef";
const ROOT_TS = "1770000000.000100";
const SOL = { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };

interface CardInput {
  sessionId?: string;
  ts?: string;
  status?: SessionStatus;
  activity?: string;
  title?: string;
  collapsed?: boolean;
  connected?: boolean;
  latestReply?: string;
}

function rootCard(input: CardInput = {}): unknown {
  const sessionId = input.sessionId ?? SESSION_ID;
  const ts = input.ts ?? ROOT_TS;
  const status = input.status ?? "working";
  const title = input.title ?? "Review PR 1776";
  return {
    bot_id: "B07SLACKOFF",
    ts,
    thread_ts: ts,
    ...(input.latestReply ? { latest_reply: input.latestReply } : {}),
    text: `${title} · ${input.activity ?? status}`,
    blocks: [
      { type: "header", block_id: "XN6VR", text: { type: "plain_text", text: title, emoji: true } },
      {
        type: "section",
        block_id: "u2Lp",
        fields: [
          { type: "mrkdwn", text: `*Status*\n:large_blue_circle: ${input.activity ?? "Working"}` },
          { type: "mrkdwn", text: "*Project*\nslackoff" },
          { type: "mrkdwn", text: "*Model*\nGPT-5.6 Sol\n`openai-codex/gpt-5.6-sol`" },
        ],
      },
      { type: "actions", block_id: `${sessionId}-binding`, elements: [] },
    ],
    metadata: buildSessionMetadata({
      sessionId,
      bindingId: BINDING,
      title,
      project: "slackoff",
      status,
      activity: input.activity ?? "",
      collapsed: input.collapsed ?? false,
      connected: input.connected ?? true,
      model: SOL,
      models: [SOL],
      effort: "high",
      efforts: ["off", "low", "medium", "high"],
    }),
  };
}

function reply(ts: string, text: string, role: "user" | "assistant"): unknown {
  return {
    bot_id: "B07SLACKOFF",
    ts,
    thread_ts: ROOT_TS,
    text: role === "user" ? `Local instruction: ${text}` : text,
    blocks: [
      {
        type: "section",
        block_id: `s-${ts}`,
        text: { type: "mrkdwn", text: role === "user" ? `*Local instruction*\n${text}` : text },
      },
    ],
    metadata: buildTranscriptMetadata({ sessionId: SESSION_ID, bindingId: BINDING, role, chunk: 0, chunks: 1 }),
  };
}

function questionReply(ts: string, multi: boolean): unknown {
  return {
    bot_id: "B07SLACKOFF",
    ts,
    thread_ts: ROOT_TS,
    text: "Question: How should I land it?",
    blocks: [
      { type: "section", block_id: "Q1", text: { type: "mrkdwn", text: "*OMP needs your input*\nHow should I land it?" } },
      { type: "section", block_id: "Q2", text: { type: "mrkdwn", text: "1. *Rebase*\n2. *Squash*" } },
      {
        type: "context",
        block_id: "Q3",
        elements: [
          {
            type: "mrkdwn",
            text: multi ? "Reply in this thread with one or more choices." : "Reply in this thread with your choice.",
          },
        ],
      },
    ],
    metadata: buildQuestionMetadata({
      sessionId: SESSION_ID,
      bindingId: BINDING,
      questionId: "q-42",
      multi,
      state: "waiting",
      options: [{ label: "Rebase" }, { label: "Squash" }],
    }),
  };
}

/* ---------- harness ---------- */

interface Harness {
  deps: ControllerDeps;
  calls: Array<{ method: string; params: Record<string, string | number | boolean> }>;
  delays: number[];
  notified: SessionView[];
  respond(method: string, ...values: unknown[]): void;
  setVisible(visible: boolean): void;
  fire(ms: number): Promise<void>;
  pending(): number[];
  settle(): Promise<void>;
}

function harness(): Harness {
  const calls: Array<{ method: string; params: Record<string, string | number | boolean> }> = [];
  const delays: number[] = [];
  const notified: SessionView[] = [];
  const queues = new Map<string, unknown[]>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  let clock = 1_770_000_000_000;
  let visible = true;

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 8; round += 1) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      await promise;
    }
  };

  const deps: ControllerDeps = {
    channelId: CHANNEL,
    team: "Datadog",
    call: async <T,>(method: string, params: Record<string, string | number | boolean>): Promise<T> => {
      calls.push({ method, params });
      const queue = queues.get(method);
      const value = queue && queue.length > 1 ? queue.shift() : queue?.[0];
      if (value === undefined) throw new Error(`no fixture queued for ${method}`);
      if (value instanceof Error) throw value;
      return value as T;
    },
    uploadImages: async () => undefined,
    now: () => {
      clock += 1;
      return clock;
    },
    setTimer: (fn, ms) => {
      delays.push(ms);
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    isVisible: () => visible,
    onNotify: (session) => {
      notified.push(session);
    },
  };

  return {
    deps,
    calls,
    delays,
    notified,
    respond: (method, ...values) => {
      queues.set(method, values);
    },
    setVisible: (next) => {
      visible = next;
    },
    pending: () => [...timers.values()].map((timer) => timer.ms),
    fire: async (ms) => {
      const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `no timer scheduled for ${ms}ms, have ${[...timers.values()].map((t) => t.ms).join()}`);
      timers.delete(entry[0]);
      entry[1].fn();
      await settle();
    },
    settle,
  };
}

const HISTORY = "conversations.history";
const REPLIES = "conversations.replies";
const POST = "chat.postMessage";
const MARK = "conversations.mark";

test("initial poll populates sessions and reports a ready connection", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard({ activity: "Thinking" })] });
  h.respond(REPLIES, { ok: true, messages: [] });
  const controller = createSlackController(h.deps);

  controller.start();
  await h.settle();

  assert.deepEqual(h.calls[0], {
    method: HISTORY,
    params: { channel: CHANNEL, limit: 50, include_all_metadata: true },
  });
  const state = controller.getState();
  assert.equal(state.connection.phase, "ready");
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0]?.sessionId, SESSION_ID);
  assert.equal(state.sessions[0]?.activity, "Thinking");
  controller.stop();
  assert.deepEqual(h.pending(), []);
});

test("visible console advances Slack's read cursor to the newest thread reply", async () => {
  const h = harness();
  h.respond(HISTORY, {
    ok: true,
    messages: [
      rootCard({ latestReply: "1770000300.000500" }),
      { ts: "1770000250.000400", text: "ordinary DM message" },
    ],
  });
  h.respond(REPLIES, { ok: true, messages: [] });
  h.respond(MARK, { ok: true });
  const controller = createSlackController(h.deps);

  controller.start();
  await h.settle();
  assert.equal(h.calls.some((entry) => entry.method === MARK), false);

  await h.fire(3_000);

  assert.deepEqual(h.calls.find((entry) => entry.method === MARK)?.params, {
    channel: CHANNEL,
    ts: "1770000300.000500",
  });
  controller.stop();
});

test("selecting a session loads its thread", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(REPLIES, {
    ok: true,
    messages: [rootCard(), reply("1770000100.000200", "ship it", "user"), reply("1770000101.000300", "Patched src/api.ts", "assistant")],
  });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();

  controller.select(SESSION_ID);
  assert.equal(controller.getState().thread?.loading, true);
  await h.settle();

  const replies = h.calls.filter((entry) => entry.method === REPLIES);
  assert.deepEqual(replies[0]?.params, {
    channel: CHANNEL,
    ts: ROOT_TS,
    limit: 200,
    include_all_metadata: true,
  });
  const thread = controller.getState().thread;
  assert.equal(thread?.loading, false);
  assert.deepEqual(thread?.events.map((event) => event.text), ["ship it", "Patched src/api.ts"]);
  controller.stop();
});

test("sendInstruction posts to the thread, echoes optimistically, then reconciles", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(
    REPLIES,
    { ok: true, messages: [rootCard()] },
    { ok: true, messages: [rootCard(), reply("1770000102.000400", "rerun the suite", "user")] },
  );
  h.respond(POST, { ok: true, ts: "1770000102.000400" });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();
  controller.select(SESSION_ID);
  await h.settle();

  const sending = controller.sendInstruction(SESSION_ID, "  rerun the suite  ");
  const optimistic = controller.getState().thread?.events.at(-1);
  assert.equal(optimistic?.text, "rerun the suite");
  assert.equal(optimistic?.pending, true);
  assert.equal(controller.getState().busy, true);

  await sending;
  await h.settle();

  const post = h.calls.find((entry) => entry.method === POST);
  assert.deepEqual(post?.params, { channel: CHANNEL, thread_ts: ROOT_TS, text: "rerun the suite" });
  const events = controller.getState().thread?.events ?? [];
  assert.equal(events.length, 1, "the optimistic echo is replaced, not duplicated");
  assert.equal(events[0]?.pending, undefined);
  assert.equal(events[0]?.text, "rerun the suite");
  assert.equal(controller.getState().busy, false);
  controller.stop();
});

test("createSession posts a launch request and waits for daemon success", async () => {
  const h = harness();
  h.respond(
    HISTORY,
    { ok: true, messages: [rootCard()] },
    {
      ok: true,
      messages: [
        rootCard(),
        rootCard({ sessionId: "new-session", ts: "1770000200.000100", title: "ui-smoke" }),
      ],
    },
  );
  h.respond(POST, { ok: true, ts: "1770000199.000100" });
  h.respond(REPLIES, {
    ok: true,
    messages: [
      { ts: "1770000199.000100", text: "launch request" },
      { ts: "1770000199.000200", bot_id: "B07SLACKOFF", text: `${SESSION_LAUNCH_SUCCESS_PREFIX}ui-smoke` },
    ],
  });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();

  const creating = controller.createSession({
    name: "ui-smoke",
    cwd: "~/src/slackoff",
    prompt: "Check the UI",
  });
  await h.settle();
  await h.fire(2_000);
  await h.fire(2_000);
  await creating;

  const post = h.calls.find((entry) => entry.method === POST);
  assert.ok(post);
  assert.equal(post.params.thread_ts, undefined);
  assert.equal(post.params.parse, "none");
  assert.equal(post.params.mrkdwn, false);
  assert.deepEqual(parseSessionLaunchRequest(String(post.params.text)), {
    name: "ui-smoke",
    cwd: "~/src/slackoff",
    prompt: "Check the UI",
  });
  assert.equal(controller.getState().sessions.some((session) => session.title === "ui-smoke"), true);
  controller.stop();
});

test("stopping the controller cancels pending session launch polling", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(REPLIES, { ok: true, messages: [rootCard()] });
  h.respond(POST, { ok: true, ts: "1770000199.000100" });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();

  const creating = controller.createSession({ name: "ui-smoke", cwd: "~/src/slackoff" });
  await h.settle();
  controller.stop();

  await assert.rejects(creating, /Session creation cancelled/);
  assert.deepEqual(h.pending(), []);
});

test("a rejected post marks the optimistic event failed and keeps it for retry", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(REPLIES, { ok: true, messages: [rootCard()] });
  h.respond(POST, new Error("ratelimited"));
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();
  controller.select(SESSION_ID);
  await h.settle();

  await controller.sendInstruction(SESSION_ID, "ship it");

  const last = controller.getState().thread?.events.at(-1);
  assert.equal(last?.failed, "ratelimited");
  assert.equal(last?.pending, undefined);
  assert.equal(controller.getState().notice, "ratelimited");
  controller.stop();
});

interface CommandCase {
  name: string;
  run(controller: Controller): Promise<void>;
  text: string;
}

const commandCases: CommandCase[] = [
  { name: "stopTurn", run: (controller) => controller.stopTurn(SESSION_ID), text: "!stop" },
  {
    name: "setModel",
    run: (controller) => controller.setModel(SESSION_ID, "anthropic/claude-opus-4-6"),
    text: "!model anthropic/claude-opus-4-6",
  },
  {
    name: "setEffort",
    run: (controller) => controller.setEffort(SESSION_ID, "high"),
    text: "!effort high",
  },
  { name: "closeThread", run: (controller) => controller.closeThread(SESSION_ID), text: "!close" },
];

for (const row of commandCases) {
  test(`${row.name} posts the exact thread command`, async () => {
    const h = harness();
    h.respond(HISTORY, { ok: true, messages: [rootCard()] });
    h.respond(REPLIES, { ok: true, messages: [rootCard()] });
    h.respond(POST, { ok: true, ts: "1770000103.000500" });
    const controller = createSlackController(h.deps);
    controller.start();
    await h.settle();

    await row.run(controller);

    const post = h.calls.find((entry) => entry.method === POST);
    assert.deepEqual(post?.params, { channel: CHANNEL, thread_ts: ROOT_TS, text: row.text });
    controller.stop();
  });
}

test("closeThread removes the accepted thread immediately", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(REPLIES, { ok: true, messages: [rootCard()] });
  h.respond(POST, { ok: true, ts: "1770000103.000500" });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();
  controller.select(SESSION_ID);
  await h.settle();

  await controller.closeThread(SESSION_ID);

  assert.equal(controller.getState().sessions.length, 0);
  assert.equal(controller.getState().selectedSessionId, undefined);
  assert.equal(controller.getState().thread, undefined);
  controller.stop();
});

test("closeThread keeps the thread when Slack rejects the command", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(REPLIES, { ok: true, messages: [rootCard()] });
  h.respond(POST, new Error("ratelimited"));
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();

  await assert.rejects(controller.closeThread(SESSION_ID), /ratelimited/);

  assert.equal(controller.getState().sessions.length, 1);
  assert.equal(controller.getState().notice, "ratelimited");
  controller.stop();
});

test("setModel refuses a selector that is not provider/id", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(REPLIES, { ok: true, messages: [rootCard()] });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();

  await assert.rejects(controller.setModel(SESSION_ID, "gpt-5.6-sol"), /provider\/id/);
  assert.equal(h.calls.some((entry) => entry.method === POST), false);
  controller.stop();
});

test("answering a multi question joins the chosen labels", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard({ status: "waiting" })] });
  h.respond(REPLIES, { ok: true, messages: [rootCard({ status: "waiting" }), questionReply("1770000104.000600", true)] });
  h.respond(POST, { ok: true, ts: "1770000105.000700" });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();
  controller.select(SESSION_ID);
  await h.settle();

  assert.equal(controller.getState().sessions[0]?.pendingQuestion?.questionId, "q-42");
  await controller.answerQuestion(SESSION_ID, ["Rebase", " Squash "]);

  const post = h.calls.find((entry) => entry.method === POST);
  assert.equal(post?.params.text, "Rebase, Squash");
  controller.stop();
});

test("answering a single-choice question sends only the first label", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard({ status: "waiting" })] });
  h.respond(REPLIES, { ok: true, messages: [rootCard({ status: "waiting" }), questionReply("1770000104.000600", false)] });
  h.respond(POST, { ok: true, ts: "1770000105.000700" });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();
  controller.select(SESSION_ID);
  await h.settle();

  await controller.answerQuestion(SESSION_ID, ["Squash"]);

  assert.equal(h.calls.find((entry) => entry.method === POST)?.params.text, "Squash");
  controller.stop();
});

test("answerQuestion refuses when nothing is waiting", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(REPLIES, { ok: true, messages: [rootCard()] });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();

  await assert.rejects(controller.answerQuestion(SESSION_ID, ["Rebase"]), /No question is waiting/);
  controller.stop();
});

test("closed sessions are omitted and refuse input as unknown", async () => {
  const h = harness();
  h.respond(HISTORY, {
    ok: true,
    messages: [rootCard({ status: "disabled", collapsed: true, title: "Old work" })],
  });
  h.respond(REPLIES, { ok: true, messages: [] });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();

  assert.equal(controller.getState().sessions.length, 0);
  await assert.rejects(controller.sendInstruction(SESSION_ID, "ship it"), /Unknown session/);
  await assert.rejects(controller.stopTurn(SESSION_ID), /Unknown session/);
  assert.equal(h.calls.some((entry) => entry.method === POST), false);
  controller.stop();
});

test("sidebar removes a session when the daemon reports it disconnected", async () => {
  const h = harness();
  h.respond(
    HISTORY,
    { ok: true, messages: [rootCard()] },
    { ok: true, messages: [rootCard({ status: "offline", connected: false })] },
  );
  h.respond(REPLIES, { ok: true, messages: [rootCard()] });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();
  controller.select(SESSION_ID);
  await h.settle();
  assert.equal(controller.getState().sessions.length, 1);

  await h.fire(5_000);

  assert.equal(controller.getState().sessions.length, 0);
  assert.equal(controller.getState().selectedSessionId, undefined);
  assert.equal(controller.getState().thread, undefined);
  controller.stop();
});

test("sendInstruction refuses an unknown session and an empty body", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(REPLIES, { ok: true, messages: [rootCard()] });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();

  await assert.rejects(controller.sendInstruction("nope", "hi"), /Unknown session nope/);
  await assert.rejects(controller.sendInstruction(SESSION_ID, "   "), /empty instruction/);
  controller.stop();
});

test("poll errors back off by doubling, keep the last good data, and reset on success", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(REPLIES, { ok: true, messages: [] });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();
  assert.equal(controller.getState().sessions.length, 1);

  h.respond(HISTORY, new Error("service_unavailable"));
  await h.fire(5_000);
  assert.equal(h.delays.at(-1), 10_000);
  const connection = controller.getState().connection;
  assert.equal(connection.phase, "error");
  assert.equal(connection.phase === "error" ? connection.recoverable : undefined, true);
  assert.equal(controller.getState().sessions.length, 1, "last good data survives");

  await h.fire(10_000);
  assert.equal(h.delays.at(-1), 20_000);
  await h.fire(20_000);
  assert.equal(h.delays.at(-1), 30_000);
  await h.fire(30_000);
  assert.equal(h.delays.at(-1), 30_000, "backoff is capped");

  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  await h.fire(30_000);
  assert.equal(h.delays.at(-1), 5_000);
  assert.equal(controller.getState().connection.phase, "ready");
  controller.stop();
});

test("a rate-limit error honours retryAfterMs and shows a notice", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(REPLIES, { ok: true, messages: [] });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();

  const limited = Object.assign(new Error("ratelimited"), { retryAfterMs: 45_000 });
  h.respond(HISTORY, limited);
  await h.fire(5_000);

  assert.equal(h.delays.at(-1), 45_000);
  assert.equal(controller.getState().notice, "Slack rate limit; retrying in 45s.");
  controller.stop();
});

test("an auth failure is reported as unrecoverable", async () => {
  const h = harness();
  h.respond(HISTORY, new Error("invalid_auth"));
  h.respond(REPLIES, { ok: true, messages: [] });
  const controller = createSlackController(h.deps);

  controller.start();
  await h.settle();

  const connection = controller.getState().connection;
  assert.equal(connection.phase === "error" ? connection.recoverable : undefined, false);
  assert.equal(h.delays.at(-1), 30_000);
  controller.stop();
});

test("a hidden tab skips the poll and resumes as soon as it is visible", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(REPLIES, { ok: true, messages: [] });
  const controller = createSlackController(h.deps);
  h.setVisible(false);

  controller.start();
  await h.settle();
  assert.equal(h.calls.filter((entry) => entry.method === HISTORY).length, 0);
  assert.ok(h.pending().includes(1_000), "the skipped poll re-checks visibility on a short probe");

  h.setVisible(true);
  await h.fire(1_000);
  assert.equal(h.calls.filter((entry) => entry.method === HISTORY).length, 1);
  assert.equal(h.delays.at(-1), 5_000);
  controller.stop();
});

test("stop drops in-flight results and every timer", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(REPLIES, { ok: true, messages: [] });
  const controller = createSlackController(h.deps);

  controller.start();
  controller.stop();
  await h.settle();

  assert.deepEqual(h.pending(), []);
  assert.equal(controller.getState().sessions.length, 0);
  assert.equal(controller.getState().connection.phase, "connecting");
});

test("onNotify fires once per newly waiting session", async () => {
  const h = harness();
  const waiting = rootCard({ status: "waiting", latestReply: "1770000200.000100" });
  h.respond(HISTORY, { ok: true, messages: [waiting] });
  h.respond(REPLIES, { ok: true, messages: [] });
  const controller = createSlackController(h.deps);

  controller.start();
  await h.settle();
  assert.deepEqual(h.notified.map((session) => session.sessionId), [SESSION_ID]);

  await h.fire(5_000);
  assert.equal(h.notified.length, 1, "the same waiting session is not announced twice");

  h.respond(HISTORY, {
    ok: true,
    messages: [waiting, rootCard({ sessionId: "019second", ts: "1770000500.000100", status: "waiting" })],
  });
  await h.fire(5_000);
  assert.deepEqual(h.notified.map((session) => session.sessionId), [SESSION_ID, "019second"]);

  h.respond(HISTORY, { ok: true, messages: [waiting, rootCard({ sessionId: "019second", ts: "1770000500.000100", status: "working" })] });
  await h.fire(5_000);
  assert.equal(h.notified.length, 2);

  h.respond(HISTORY, { ok: true, messages: [waiting, rootCard({ sessionId: "019second", ts: "1770000500.000100", status: "waiting" })] });
  await h.fire(5_000);
  assert.equal(h.notified.length, 3, "a session that waits again is announced again");
  controller.stop();
});

test("subscribe publishes a fresh state object and unsubscribes cleanly", async () => {
  const h = harness();
  h.respond(HISTORY, { ok: true, messages: [rootCard()] });
  h.respond(REPLIES, { ok: true, messages: [] });
  const controller = createSlackController(h.deps);
  const seen: number[] = [];
  const unsubscribe = controller.subscribe((state) => seen.push(state.sessions.length));

  controller.start();
  await h.settle();
  const before = controller.getState();
  controller.setFilter("attention");
  const after = controller.getState();

  assert.notEqual(before, after, "state is republished, never mutated in place");
  assert.equal(after.filter, "attention");
  assert.ok(seen.length >= 2);

  unsubscribe();
  const count = seen.length;
  controller.setQuery("parser");
  assert.equal(seen.length, count);
  controller.stop();
});

test("the query and filter narrow the published session list without losing attention", async () => {
  const h = harness();
  h.respond(HISTORY, {
    ok: true,
    messages: [
      rootCard({ sessionId: "019alpha", ts: "1770000000.000100", status: "waiting", title: "Alpha parser" }),
      rootCard({ sessionId: "019beta", ts: "1770000001.000100", status: "working", title: "Beta docs" }),
    ],
  });
  h.respond(REPLIES, { ok: true, messages: [] });
  const controller = createSlackController(h.deps);
  controller.start();
  await h.settle();

  controller.setQuery("beta");
  assert.deepEqual(controller.getState().sessions.map((entry) => entry.sessionId), ["019beta"]);
  assert.deepEqual(controller.getState().attention.map((entry) => entry.sessionId), ["019alpha"]);

  controller.setQuery("");
  controller.setFilter("attention");
  assert.deepEqual(controller.getState().sessions.map((entry) => entry.sessionId), ["019alpha"]);
  controller.stop();
});
