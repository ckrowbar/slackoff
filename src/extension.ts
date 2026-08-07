import { basename } from "node:path";
import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";

import { BridgeClient } from "./client.js";
import { loadClientConfig } from "./config.js";
import { PROTOCOL_VERSION, SlackBindingSchema, type ServerMessage, type SessionStatus } from "./protocol.js";

const STATE_TYPE = "io.github.ckrowbar.slackoff.state";
const SessionStateSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  binding: SlackBindingSchema.optional(),
});
type SessionState = z.infer<typeof SessionStateSchema>;

const TOOL_ACTIVITY: Record<string, string> = {
  read: "Reading",
  grep: "Searching",
  glob: "Locating files",
  edit: "Editing",
  write: "Writing",
  bash: "Running a command",
  task: "Running delegated work",
  ask: "Waiting for input",
};

export default function slackoffExtension(pi: ExtensionAPI): void {
  let currentContext: ExtensionContext | undefined;
  let currentState: SessionState = { version: 1, enabled: false };
  let client: BridgeClient | undefined;
  let registeredSessionId: string | undefined;
  let registration: Promise<void> | undefined;

  const reportError = (error: Error): void => {
    pi.logger.error("Slackoff extension error", {
      error: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    });
    currentContext?.ui.notify(`Slackoff: ${error.message}`, "error");
  };

  const getClient = (): BridgeClient => {
    if (client) return client;
    client = new BridgeClient(loadClientConfig(), reportError);
    client.onMessage((message) => handleServerMessage(message));
    return client;
  };

  const persistState = (): void => {
    pi.appendEntry(STATE_TYPE, currentState);
  };

  const sendStatus = (status: SessionStatus, activity?: string): void => {
    if (!currentState.enabled || !registeredSessionId) return;
    const bridge = getClient();
    bridge.send({
      type: "status",
      sessionId: registeredSessionId,
      status,
      occurredAt: new Date().toISOString(),
      ...(activity ? { activity } : {}),
    });
  };

  const activate = async (ctx: ExtensionContext, resetBinding = false): Promise<void> => {
    if (registration) return registration;
    registration = (async () => {
      const bridge = getClient();
      await bridge.ensureConnected();
      const sessionId = ctx.sessionManager.getSessionId();
      const response = await bridge.request({
        type: "register",
        requestId: randomUUID(),
        protocolVersion: PROTOCOL_VERSION,
        session: {
          id: sessionId,
          title: pi.getSessionName() ?? `OMP ${sessionId.slice(0, 8)}`,
          project: basename(ctx.cwd),
        },
        ...(!resetBinding && currentState.binding ? { binding: currentState.binding } : {}),
      });
      if (!response.ok || !response.binding) throw new Error(response.error ?? "Slackoff registration failed");

      registeredSessionId = sessionId;
      const bindingChanged = currentState.binding?.bindingId !== response.binding.bindingId;
      currentState = { version: 1, enabled: true, binding: response.binding };
      if (bindingChanged || resetBinding) persistState();
      sendStatus(ctx.isIdle() ? "idle" : "working", ctx.isIdle() ? undefined : "Resumed work");
    })().finally(() => {
      registration = undefined;
    });
    return registration;
  };

  const deactivate = (reason: "offline" | "disabled" | "switch"): void => {
    if (registeredSessionId && client?.connected) {
      client.send({ type: "unregister", sessionId: registeredSessionId, reason });
    }
    registeredSessionId = undefined;
  };

  const restoreState = (ctx: ExtensionContext): SessionState => {
    let restored: SessionState = { version: 1, enabled: false };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
      const parsed = SessionStateSchema.safeParse(entry.data);
      if (parsed.success) restored = parsed.data;
    }
    return restored;
  };

  const handleServerMessage = (message: ServerMessage): void => {
    const ctx = currentContext;
    if (!ctx || message.type === "response") return;
    if (message.type === "replaced") {
      if (message.sessionId === registeredSessionId) {
        registeredSessionId = undefined;
        ctx.ui.notify("Slackoff control moved to another process for this session", "warning");
      }
      return;
    }
    if (message.sessionId !== registeredSessionId) return;

    if (message.type === "instruction") {
      try {
        const wasIdle = ctx.isIdle();
        pi.sendUserMessage(message.text, wasIdle ? undefined : { deliverAs: "followUp" });
        client?.send({
          type: "command_ack",
          sessionId: message.sessionId,
          commandId: message.commandId,
          state: wasIdle ? "delivered" : "queued",
        });
        sendStatus("working", wasIdle ? "Starting turn" : "Instruction queued");
      } catch (error) {
        client?.send({
          type: "command_ack",
          sessionId: message.sessionId,
          commandId: message.commandId,
          state: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (ctx.isIdle()) {
      client?.send({
        type: "command_ack",
        sessionId: message.sessionId,
        commandId: message.commandId,
        state: "ignored",
      });
      return;
    }
    ctx.abort();
    client?.send({
      type: "command_ack",
      sessionId: message.sessionId,
      commandId: message.commandId,
      state: "stopped",
    });
  };

  pi.registerCommand("slackoff", {
    description: "Manage this session's Slackoff DM thread (on|off|status)",
    handler: async (args, ctx) => {
      currentContext = ctx;
      const action = args.trim().toLowerCase() || "status";
      if (action === "on") {
        currentState = { ...currentState, enabled: true };
        persistState();
        await activate(ctx);
        ctx.ui.notify("Slackoff enabled for this session", "info");
        return;
      }
      if (action === "off") {
        deactivate("disabled");
        currentState = { version: 1, enabled: false };
        persistState();
        ctx.ui.notify("Slackoff disabled for this session", "info");
        return;
      }
      if (action === "status") {
        const connection = client?.connected ? "connected" : "disconnected";
        ctx.ui.notify(`Slackoff is ${currentState.enabled ? "enabled" : "disabled"} (${connection})`, "info");
        return;
      }
      ctx.ui.notify("Usage: /slackoff on|off|status", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    currentState = restoreState(ctx);
    if (currentState.enabled) await activate(ctx);

    ctx.setInterval(() => {
      if (currentState.enabled && !client?.connected) {
        void activate(ctx).catch((error) => reportError(error instanceof Error ? error : new Error(String(error))));
      }
    }, 5_000);
  });

  pi.on("session_switch", async (event, ctx) => {
    deactivate("switch");
    currentContext = ctx;
    currentState = restoreState(ctx);
    if (event.reason === "new") currentState = { version: 1, enabled: false };
    const resetBinding = event.reason === "fork" || event.reason === "handoff";
    if (currentState.enabled) await activate(ctx, resetBinding);
  });

  pi.on("session_branch", (_event, ctx) => {
    currentContext = ctx;
    sendStatus(ctx.isIdle() ? "idle" : "working", "Session branch changed");
  });

  pi.on("input", (event) => {
    if (!currentState.enabled || event.source === "extension" || !registeredSessionId || !event.text.trim()) return;
    getClient().send({ type: "transcript", sessionId: registeredSessionId, role: "user", text: event.text.trim() });
  });

  pi.on("agent_start", () => sendStatus("working", "Starting turn"));
  pi.on("turn_start", () => sendStatus("working", "Thinking"));
  pi.on("tool_execution_start", (event) => {
    const activity = TOOL_ACTIVITY[event.toolName] ?? `Using ${event.toolName}`;
    sendStatus(event.toolName === "ask" ? "waiting" : "working", activity);
  });
  pi.on("tool_execution_end", (event) => {
    sendStatus("working", event.isError ? `${event.toolName} failed` : "Continuing");
  });
  pi.on("tool_approval_requested", (event) => sendStatus("waiting", `Waiting for local approval: ${event.toolName}`));
  pi.on("tool_approval_resolved", () => sendStatus("working", "Approval resolved"));
  pi.on("auto_retry_start", () => sendStatus("working", "Retrying"));

  pi.on("message_end", (event) => {
    if (!currentState.enabled || !registeredSessionId) return;
    const text = extractAssistantText(event.message);
    if (!text) return;
    getClient().send({ type: "transcript", sessionId: registeredSessionId, role: "assistant", text });
  });

  pi.on("agent_end", (event) => {
    if (!event.willContinue) sendStatus("idle");
  });

  pi.on("session_shutdown", () => {
    deactivate("offline");
    client?.disconnect();
    currentContext = undefined;
  });
}

function extractAssistantText(message: MessageEndEvent["message"]): string | undefined {
  if (!("role" in message) || message.role !== "assistant" || !("content" in message)) return undefined;
  const content = message.content;
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || undefined;
}
