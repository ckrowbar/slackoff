import assert from "node:assert/strict";
import { Socket } from "node:net";
import test from "node:test";

import { SessionRegistry } from "../src/daemon/registry.js";

const session = {
  id: "session-1",
  title: "Fix parser",
  project: "project",
  modelState: {
    current: { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    available: [{ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
  },
};
const binding = { bindingId: "binding-1", channelId: "D123", threadTs: "100.200" };

test("routes a Slack thread to its active OMP session", () => {
  const registry = new SessionRegistry();
  const socket = new Socket();
  const { record } = registry.register(session, binding, socket);

  assert.equal(registry.getByThread("D123", "100.200"), record);
  assert.equal(registry.getByBindingId("binding-1"), record);
});

test("new registration takes the lease and stale disconnect cannot evict it", () => {
  const registry = new SessionRegistry();
  const firstSocket = new Socket();
  const secondSocket = new Socket();
  registry.register(session, binding, firstSocket);

  const takeover = registry.register(session, binding, secondSocket);
  const staleUnregister = registry.unregister(session.id, firstSocket, "offline");

  assert.equal(takeover.replacedSocket, firstSocket);
  assert.equal(staleUnregister, undefined);
  assert.equal(registry.getBySessionId(session.id)?.socket, secondSocket);
});

test("lease takeover does not reset a working session to ready", () => {
  const registry = new SessionRegistry();
  const firstSocket = new Socket();
  const secondSocket = new Socket();
  const original = registry.register(session, binding, firstSocket).record;
  original.status = "working";
  original.activity = "Thinking";

  const takeover = registry.register(session, binding, secondSocket, "working", "Thinking").record;

  assert.equal(takeover.status, "working");
  assert.equal(takeover.activity, "Thinking");
});

test("updates titles only from the session's active connection", () => {
  const registry = new SessionRegistry();
  const activeSocket = new Socket();
  const staleSocket = new Socket();
  registry.register({ ...session }, binding, activeSocket);

  assert.equal(registry.updateTitle(session.id, staleSocket, "Stale title"), undefined);
  const updated = registry.updateTitle(session.id, activeSocket, "Investigate parser regression");

  assert.equal(updated?.session.title, "Investigate parser regression");
  assert.equal(registry.getBySessionId(session.id)?.session.title, "Investigate parser regression");
  assert.equal(registry.updateTitle(session.id, activeSocket, "Investigate parser regression"), undefined);
});

test("disabled registration remains addressable but cannot receive commands", () => {
  const registry = new SessionRegistry();
  const socket = new Socket();
  registry.register(session, binding, socket);

  const record = registry.unregister(session.id, socket, "disabled");

  assert.equal(record?.status, "disabled");
  assert.equal(record?.socket, undefined);
  assert.equal(record?.collapsed, true);
  assert.equal(registry.getByThread("D123", "100.200"), record);
});

test("disconnecting one session does not affect another session", () => {
  const registry = new SessionRegistry();
  const firstSocket = new Socket();
  const secondSocket = new Socket();
  registry.register(session, binding, firstSocket);
  registry.register(
    { ...session, id: "session-2", title: "Review API", project: "other-project" },
    { bindingId: "binding-2", channelId: "D123", threadTs: "300.400" },
    secondSocket,
  );

  registry.disconnect(firstSocket);

  assert.equal(registry.getBySessionId("session-1")?.status, "offline");
  assert.equal(registry.getBySessionId("session-2")?.status, "idle");
  assert.equal(registry.getBySessionId("session-2")?.socket, secondSocket);
});

test("re-registering a session restores its existing thread binding", () => {
  const registry = new SessionRegistry();
  const firstSocket = new Socket();
  const secondSocket = new Socket();
  const original = registry.register(session, binding, firstSocket).record;
  original.collapsed = true;
  registry.disconnect(firstSocket);

  const restored = registry.register(session, binding, secondSocket).record;

  assert.equal(restored, original);
  assert.equal(restored.binding.threadTs, "100.200");
  assert.equal(restored.status, "idle");
  assert.equal(restored.collapsed, false);
  assert.equal(restored.socket, secondSocket);
});

test("registering after closure moves the session to a new thread", () => {
  const registry = new SessionRegistry();
  const firstSocket = new Socket();
  const secondSocket = new Socket();
  const first = registry.register(session, binding, firstSocket).record;
  registry.unregister(session.id, firstSocket, "disabled");
  const nextBinding = { bindingId: "binding-2", channelId: "D123", threadTs: "300.400" };

  const reopened = registry.register(session, nextBinding, secondSocket).record;

  assert.equal(reopened, first);
  assert.equal(reopened.collapsed, false);
  assert.equal(registry.getByThread("D123", "100.200"), undefined);
  assert.equal(registry.getByThread("D123", "300.400"), reopened);
});
