import assert from "node:assert/strict";
import { test } from "node:test";

import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { createFakeSdk, makeThreadResponse } from "@get-bb/plugin-sdk/testing";

import { SlackoffBridge, type BridgeSettings, type SlackClient } from "./bridge.ts";
import { ACTION } from "./cards.ts";
import { SlackApiError, type SlackResponse } from "./slack/api.ts";
import { BindingStore, type KvStore } from "./store.ts";

const USER = "U0USER";
const DM = "D0DM";
const THREAD = "thr_one";
const PROJECT = "proj_one";

interface Row {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  scope: { kind: "thread" } | { kind: "turn"; turnId: string };
  createdAt: number;
}

class MemoryKv implements KvStore {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async set(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.values.delete(key);
  }
  async list(prefix = "") {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
}

class FakeSlack implements SlackClient {
  readonly calls: { method: string; body: Record<string, unknown> }[] = [];
  reject: ((method: string, body: Record<string, unknown>) => string | undefined) | undefined;
  #ts = 100;

  async call<T extends SlackResponse>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, body });
    const error = this.reject?.(method, body);
    if (error) throw new SlackApiError(method, error);
    if (method === "chat.postMessage") {
      const ts = `${(this.#ts += 1)}.000`;
      body.posted_ts = ts;
      return { ok: true, channel: DM, ts } as unknown as T;
    }
    if (method === "chat.getPermalink") return { ok: true, permalink: `https://slack.test/${String(body.message_ts)}` } as unknown as T;
    return { ok: true } as unknown as T;
  }

  async download(): Promise<Uint8Array> {
    return new Uint8Array([1, 2, 3]);
  }

  posts(): Record<string, unknown>[] {
    return this.calls.filter((call) => call.method === "chat.postMessage").map((call) => call.body);
  }

  updates(): Record<string, unknown>[] {
    return this.calls.filter((call) => call.method === "chat.update").map((call) => call.body);
  }
}

function setup(options: { settings?: Partial<BridgeSettings>; rows?: Row[]; interactions?: unknown[]; output?: string | null } = {}) {
  const rows: Row[] = options.rows ?? [];
  const interactions: unknown[] = options.interactions ?? [];
  const thread = makeThreadResponse({ id: THREAD, projectId: PROJECT, title: "Fix the parser", providerId: "claude-code", environmentId: "env_one" });
  const { sdk, harness } = createFakeSdk({
    pluginId: "slackoff",
    overrides: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({ ...thread, id: threadId }),
        output: async () => ({ output: options.output ?? null }),
        send: async () => ({ ok: true, delivery: "sent" }),
        stop: async () => ({ ok: true }),
        spawn: async () => ({ ...thread, id: "thr_new" }),
        update: async () => thread,
        defaultExecutionOptions: async () => ({ model: "claude-opus-5-5", reasoningLevel: "high", permissionMode: "full", serviceTier: "default", source: "client/turn/requested" }),
        events: {
          list: async (args: { afterSeq?: string; order?: string; limit?: string; types?: readonly string[] }) => {
            if (args.order === "desc") return rows.slice(-1);
            const after = Number(args.afterSeq ?? 0);
            return rows
              .filter((row) => row.seq > after && (!args.types || args.types.includes(row.type)))
              .slice(0, Number(args.limit ?? 100))
              .map((row) => ({ ...row, id: `evt_${row.seq}`, threadId: THREAD }));
          },
        },
        interactions: {
          list: async () => interactions,
          get: async ({ interactionId }: { interactionId: string }) => interactions.find((item) => (item as { id: string }).id === interactionId),
          resolve: async ({ interactionId, resolution }: { interactionId: string; resolution: unknown }) => {
            const item = interactions.find((candidate) => (candidate as { id: string }).id === interactionId) as Record<string, unknown>;
            item.status = "resolved";
            item.resolution = resolution;
            return item;
          },
        },
      },
      projects: {
        get: async () => ({ id: PROJECT, name: "parser", kind: "standard" }),
        list: async () => [{ id: PROJECT, name: "parser", kind: "standard" }],
        attachments: { upload: async () => ({ type: "localImage", path: "attachments/a.png", name: "a.png", sizeBytes: 3 }) },
      },
      providers: {
        models: async () => ({
          models: [
            { id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "Opus 5.5", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
            { id: "claude-sonnet-5-5", model: "claude-sonnet-5-5", displayName: "Sonnet 5.5", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
          ],
        }),
      },
    } as never,
  });
  const slack = new FakeSlack();
  const kv = new MemoryKv();
  const store = new BindingStore(kv);
  const settings: BridgeSettings = { userId: USER, defaultProjectId: undefined, mirrorNewThreads: false, showActivity: true, appUrl: undefined, ...options.settings };
  const logs: string[] = [];
  const bridge = new SlackoffBridge({
    pluginId: "slackoff",
    sdk: sdk as unknown as PluginBbSdk,
    slack,
    store,
    settings: async () => settings,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    cardDelayMs: 0,
  });
  const settle = async () => {
    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await bridge.idle();
    }
  };
  let seq = rows.at(-1)?.seq ?? 0;
  const push = (type: string, data: Record<string, unknown>, turnId = "t1") => {
    seq += 1;
    rows.push({ seq, type, data, scope: { kind: "turn", turnId }, createdAt: 1_000 * seq });
  };
  return { bridge, slack, store, harness, rows, push, settle, thread, interactions, logs };
}

function message(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "events_api",
    envelope_id: "env",
    payload: { event_id: `ev_${Math.random()}`, event: { type: "message", channel: DM, channel_type: "im", user: USER, text, ts: "200.000", ...extra } },
  };
}

function blockText(body: Record<string, unknown>): string {
  return JSON.stringify(body.blocks);
}

test("enabling posts a status card and the latest reply", async () => {
  const { bridge, slack, store, settle } = setup({ output: "Done: **parser** fixed." });
  await bridge.enable(THREAD);
  await settle();
  const [card, latest] = slack.posts();
  assert.equal(card?.channel, USER);
  assert.match(blockText(card!), /Fix the parser/);
  assert.match(blockText(card!), /Opus 5.5 · high/);
  assert.equal(latest?.thread_ts, "101.000");
  assert.match(blockText(latest!), /"text":"parser","style":\{"bold":true\}/);
  const binding = await store.get(THREAD);
  assert.equal(binding?.rootTs, "101.000");
  assert.equal(binding?.cardTs, "101.000");
});

test("assistant output is mirrored as rich text and BB prompts are labelled", async () => {
  const { bridge, slack, push, settle } = setup();
  await bridge.enable(THREAD);
  push("client/turn/requested", { initiator: "user", input: [{ type: "text", text: "Run the tests", mentions: [] }] });
  push("turn/started", {});
  push("item/completed", { item: { type: "agentMessage", id: "m1", text: "All green:\n\n- `npm test`" } });
  push("item/completed", { item: { type: "agentMessage", id: "m2", text: "subagent chatter", parentToolCallId: "tool" } });
  bridge.onThreadEvents(makeThreadResponse({ id: THREAD }));
  await settle();
  const replies = slack.posts().slice(1);
  assert.equal(replies.length, 2);
  assert.match(blockText(replies[0]!), /💬 You/);
  assert.match(blockText(replies[0]!), /Run the tests/);
  assert.match(blockText(replies[1]!), /rich_text_list/);
  assert.match(blockText(replies[1]!), /"text":"npm test","style":\{"code":true\}/);
});

test("tool steps build a progress card that an assistant message closes", async () => {
  const { bridge, slack, push, settle } = setup();
  await bridge.enable(THREAD);
  push("turn/started", {});
  push("item/started", { item: { type: "commandExecution", id: "c1", command: "npm test", status: "pending" } });
  bridge.onThreadEvents(makeThreadResponse({ id: THREAD }));
  await settle();
  const progress = slack.posts()[1]!;
  assert.match(blockText(progress), /Working/);
  assert.match(blockText(progress), /Running command · `npm test`/);

  push("item/completed", { item: { type: "commandExecution", id: "c1", command: "npm test", status: "completed" } });
  push("item/completed", { item: { type: "agentMessage", id: "m1", text: "Tests pass." } });
  push("turn/completed", { status: "completed" });
  bridge.onThreadEvents(makeThreadResponse({ id: THREAD }));
  await settle();
  const closed = slack.updates().find((update) => update.ts === progress.posted_ts && /Worked for/.test(blockText(update)));
  assert.ok(closed, "the progress card is finalised in place");
  assert.match(blockText(closed), /✓ Ran command/);
  assert.match(blockText(slack.posts().at(-1)!), /Tests pass/);
});

test("a Slack reply is sent to BB and not mirrored back", async () => {
  const { bridge, slack, harness, push, settle } = setup();
  const binding = await bridge.enable(THREAD);
  bridge.handleEnvelope(message("Please use <https://example.com|the docs> &amp; retry", { thread_ts: binding.rootTs }));
  await settle();
  const [send] = harness.callsTo("threads.send");
  assert.deepEqual((send?.[0] as { input: unknown }).input, [{ type: "text", text: "Please use [the docs](https://example.com) & retry", mentions: [] }]);
  assert.ok(slack.calls.some((call) => call.method === "reactions.add" && call.body.name === "eyes"));

  const before = slack.posts().length;
  push("client/turn/requested", { initiator: "user", input: [{ type: "text", text: "Please use [the docs](https://example.com) & retry", mentions: [] }] });
  bridge.onThreadEvents(makeThreadResponse({ id: THREAD }));
  await settle();
  assert.equal(slack.posts().length, before);
});

test("Slack rich text keeps code blocks for the agent", async () => {
  const { bridge, harness, settle } = setup();
  const binding = await bridge.enable(THREAD);
  bridge.handleEnvelope(
    message("ignored", {
      thread_ts: binding.rootTs,
      blocks: [
        {
          type: "rich_text",
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "Run " }, { type: "text", text: "this", style: { bold: true } }] },
            { type: "rich_text_preformatted", elements: [{ type: "text", text: "npm test" }] },
          ],
        },
      ],
    }),
  );
  await settle();
  const [send] = harness.callsTo("threads.send");
  assert.equal(((send?.[0] as { input: { text: string }[] }).input[0])?.text, "Run **this**\n```\nnpm test\n```");
});

test("commands control the thread", async () => {
  const { bridge, harness, settle } = setup();
  const binding = await bridge.enable(THREAD);
  bridge.handleEnvelope(message("!stop", { thread_ts: binding.rootTs }));
  bridge.handleEnvelope(message("!model claude-sonnet-5-5", { thread_ts: binding.rootTs }));
  await settle();
  assert.equal(harness.callsTo("threads.stop").length, 1);
  assert.deepEqual(harness.callsTo("threads.update")[0]?.[0], { threadId: THREAD, model: "claude-sonnet-5-5" });
  assert.equal(harness.callsTo("threads.send").length, 0);
});

test("messages from other Slack users are ignored", async () => {
  const { bridge, harness, settle, logs } = setup();
  const binding = await bridge.enable(THREAD);
  bridge.handleEnvelope(message("hi", { thread_ts: binding.rootTs, user: "U0OTHER" }));
  await settle();
  assert.equal(harness.callsTo("threads.send").length, 0);
  assert.ok(logs.some((line) => /unauthorised/.test(line)));
});

const approval = () => ({
  id: "int_1",
  threadId: THREAD,
  turnId: "t1",
  status: "pending",
  statusReason: null,
  createdAt: 1,
  resolvedAt: null,
  resolution: null,
  payload: {
    kind: "approval",
    reason: "Needs network",
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
    subject: { kind: "command", command: "curl https://x.dev", cwd: "/repo", itemId: "c1", actions: [], sessionGrant: null },
  },
});

test("approvals get buttons that resolve the interaction", async () => {
  const pending = approval();
  const { bridge, slack, harness, settle, interactions } = setup({ interactions: [] });
  await bridge.enable(THREAD);
  interactions.push(pending);
  bridge.onInteraction(makeThreadResponse({ id: THREAD }), pending as never);
  await settle();
  const card = slack.posts().find((post) => /Approve command/.test(blockText(post)))!;
  assert.match(blockText(card), /curl https:\/\/x.dev/);
  const actions = (card.blocks as { type: string; elements?: { action_id: string }[] }[]).find((block) => block.type === "actions")!;
  const ids = actions.elements!.map((element) => element.action_id);
  assert.equal(new Set(ids).size, 3, "every button in a block needs its own action_id");

  bridge.handleEnvelope({
    type: "interactive",
    envelope_id: "e",
    payload: { type: "block_actions", user: { id: USER }, actions: [{ action_id: `${ACTION.approve}:allow_once`, value: `${THREAD}|int_1|allow_once` }] },
  });
  await settle();
  assert.deepEqual(harness.callsTo("threads.interactions.resolve")[0]?.[0], {
    threadId: THREAD,
    interactionId: "int_1",
    resolution: { decision: "allow_once", grantedPermissions: null },
  });
  assert.ok(slack.updates().some((update) => update.ts === card.posted_ts && /Allowed once in Slack/.test(blockText(update))));
});

test("a reply answers a pending question by option number", async () => {
  const question = {
    ...approval(),
    id: "int_q",
    payload: {
      kind: "user_question",
      questions: [
        {
          id: "q1",
          prompt: "Which **database**?",
          multiSelect: false,
          allowFreeText: false,
          options: [
            { label: "Postgres", value: "pg" },
            { label: "SQLite", value: "sqlite" },
          ],
        },
      ],
    },
  };
  const { bridge, slack, harness, settle } = setup({ interactions: [question] });
  const binding = await bridge.enable(THREAD);
  await settle();
  assert.ok(slack.posts().some((post) => /The agent has a question/.test(blockText(post))));
  bridge.handleEnvelope(message("2", { thread_ts: binding.rootTs }));
  await settle();
  assert.deepEqual((harness.callsTo("threads.interactions.resolve")[0]?.[0] as { resolution: unknown }).resolution, {
    kind: "user_answer",
    answers: { q1: { selected: ["sqlite"] } },
  });
  assert.equal(harness.callsTo("threads.send").length, 0);
});

test("a top-level DM starts a thread in the default project", async () => {
  const { bridge, slack, harness, store, settle } = setup({ settings: { defaultProjectId: PROJECT } });
  bridge.handleEnvelope(message("Fix the flaky test", { files: [{ id: "F1", name: "a.png", mimetype: "image/png", size: 3, url_private_download: "https://files.slack.com/a.png" }] }));
  await settle();
  const spawn = harness.callsTo("threads.spawn")[0]?.[0] as { projectId: string; input: unknown[] };
  assert.equal(spawn.projectId, PROJECT);
  assert.deepEqual(spawn.input, [
    { type: "text", text: "Fix the flaky test", mentions: [] },
    { type: "localImage", path: "attachments/a.png" },
  ]);
  const binding = await store.get("thr_new");
  assert.equal(binding?.rootTs, "200.000");
  assert.notEqual(binding?.cardTs, binding?.rootTs);
  assert.equal(slack.posts()[0]?.thread_ts, "200.000");
});

test("rejected rich blocks fall back to mrkdwn", async () => {
  const { bridge, slack, push, settle } = setup();
  await bridge.enable(THREAD);
  slack.reject = (method, body) => (method === "chat.postMessage" && JSON.stringify(body.blocks).includes("rich_text") ? "invalid_blocks" : undefined);
  push("item/completed", { item: { type: "agentMessage", id: "m1", text: "**Bold** and `code`" } });
  bridge.onThreadEvents(makeThreadResponse({ id: THREAD }));
  await settle();
  const fallback = slack.posts().at(-1)!;
  assert.deepEqual(fallback.blocks, [{ type: "section", text: { type: "mrkdwn", text: "*Bold* and `code`" } }]);
});

test("disabling collapses the card and stops mirroring", async () => {
  const { bridge, slack, push, settle } = setup();
  await bridge.enable(THREAD);
  await bridge.disable(THREAD);
  await settle();
  assert.match(blockText(slack.updates().at(-1)!), /Resume mirroring/);
  const before = slack.posts().length;
  push("item/completed", { item: { type: "agentMessage", id: "m1", text: "hidden" } });
  bridge.onThreadEvents(makeThreadResponse({ id: THREAD }));
  await settle();
  assert.equal(slack.posts().length, before);
});

test("a session approval passes the provider's session grant", async () => {
  const pending = approval();
  const grant = { fileSystem: null, network: { enabled: true } };
  (pending.payload.subject as Record<string, unknown>).sessionGrant = grant;
  const { bridge, harness, settle } = setup({ interactions: [pending] });
  await bridge.enable(THREAD);
  await settle();
  bridge.handleEnvelope({
    type: "interactive",
    envelope_id: "e",
    payload: { type: "block_actions", user: { id: USER }, actions: [{ action_id: `${ACTION.approve}:allow_for_session`, value: `${THREAD}|int_1|allow_for_session` }] },
  });
  await settle();
  assert.deepEqual((harness.callsTo("threads.interactions.resolve")[0]?.[0] as { resolution: unknown }).resolution, {
    decision: "allow_for_session",
    grantedPermissions: grant,
  });
});

test("commands are shown verbatim and long ones must be approved in BB", async () => {
  const fenced = approval();
  fenced.payload.subject.command = "echo '```'\n**not bold**";
  const long = { ...approval(), id: "int_2" };
  long.payload = { ...long.payload, subject: { ...long.payload.subject, command: `curl ${"x".repeat(3_000)}` } };
  const { bridge, slack, settle } = setup({ interactions: [fenced, long] });
  await bridge.enable(THREAD);
  await settle();
  const [first, second] = slack.posts().filter((post) => /Approve command/.test(blockText(post)));
  assert.match(blockText(first!), /rich_text_preformatted","elements":\[\{"type":"text","text":"echo '```'\\n\*\*not bold\*\*"/);
  assert.doesNotMatch(blockText(second!), /slackoff_approve/);
  assert.match(blockText(second!), /Review and answer it in BB/);
});

test("a transient BB error during reconcile keeps the mirror", async () => {
  const { bridge, store, harness, settle } = setup();
  await bridge.enable(THREAD);
  harness.stub("threads.get", async () => {
    throw new Error("socket hang up");
  });
  await bridge.reconcileAll();
  await settle();
  assert.ok(await store.get(THREAD));
});
