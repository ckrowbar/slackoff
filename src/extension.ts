import { basename } from "node:path";
import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@oh-my-pi/pi-coding-agent";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { z } from "zod";

import { BridgeClient } from "./client.js";
import { loadClientConfig } from "./config.js";
import {
  ModelEffortSchema,
  PROTOCOL_VERSION,
  SlackBindingSchema,
  type ClientMessage,
  type ModelDescriptor,
  type ModelEffort,
  type ServerMessage,
  type SessionEffortState,
  type SessionModelState,
  type SessionStatus,
} from "./protocol.js";

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

interface SlackQuestion {
  id: string;
  question: string;
  options: Array<{ label: string; description?: string | undefined }>;
  multi?: boolean | undefined;
}

interface PendingSlackAnswer {
  sessionId: string;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}
export type BtwLifecycleEvent =
  | { type: "btw_start"; requestId: string; question: string }
  | { type: "btw_update"; requestId: string; delta: string }
  | {
      type: "btw_end";
      requestId: string;
      question: string;
      outcome: "completed" | "aborted" | "error";
      answer?: string | undefined;
      error?: string | undefined;
    };

interface BtwEventAPI {
  on(event: "btw_start", handler: (event: Extract<BtwLifecycleEvent, { type: "btw_start" }>) => void): void;
  on(event: "btw_update", handler: (event: Extract<BtwLifecycleEvent, { type: "btw_update" }>) => void): void;
  on(event: "btw_end", handler: (event: Extract<BtwLifecycleEvent, { type: "btw_end" }>) => void): void;
}

export function forwardBtwLifecycleEvent(
  event: BtwLifecycleEvent,
  registration: { enabled: boolean; sessionId?: string | undefined },
  send: (message: ClientMessage) => boolean,
): boolean {
  if (!registration.enabled || !registration.sessionId) return false;
  const sessionId = registration.sessionId;
  switch (event.type) {
    case "btw_start":
      return send({ ...event, sessionId });
    case "btw_update":
      return send({ ...event, sessionId });
    case "btw_end":
      return send({ ...event, sessionId });
  }
}

interface RegistrationMaintenanceOptions {
  enabled: boolean;
  registered: boolean;
  blocked?: boolean;
  activate(): Promise<void>;
  onRegistered(): void;
  onError(error: Error): void;
}

export function maintainSlackoffRegistration(
  options: RegistrationMaintenanceOptions,
): Promise<void> | undefined {
  if (!options.enabled || options.blocked) return undefined;
  if (options.registered) {
    options.onRegistered();
    return undefined;
  }
  return options.activate().catch((error: unknown) => {
    options.onError(error instanceof Error ? error : new Error(String(error)));
  });
}

export function shouldAbortTurn(message: ServerMessage): boolean {
  return message.type === "stop";
}

const SLACKOFF_INSTANCE_ENV = "SLACKOFF_EXTENSION_INSTANCE";


export default function slackoffExtension(pi: ExtensionAPI): void {
  const instance = randomUUID();
  if (process.env[SLACKOFF_INSTANCE_ENV]) return;
  process.env[SLACKOFF_INSTANCE_ENV] = instance;
  const slackAskParameters = pi.zod.object({
    questions: pi.zod
      .array(
        pi.zod.object({
          id: pi.zod.string().min(1),
          question: pi.zod.string().min(1),
          options: pi.zod
            .array(
              pi.zod.object({
                label: pi.zod.string().min(1),
                description: pi.zod.string().optional(),
              }),
            )
            .min(2)
            .max(5),
          multi: pi.zod.boolean().optional(),
        }),
      )
      .min(1),
  });
  let currentContext: ExtensionContext | undefined;
  let currentState: SessionState = { version: 1, enabled: false };
  let client: BridgeClient | undefined;
  let registeredSessionId: string | undefined;
  let registration: Promise<void> | undefined;
  const pendingAnswers = new Map<string, PendingSlackAnswer>();
  let replacedNativeAsk = false;
  let lastModelStateSignature: string | undefined;
  let lastSessionTitle: string | undefined;
  let lastRegistrationError: string | undefined;
  let resetBindingOnNextRegistration = false;
  let registrationBlocked = false;

  const reportError = (error: Error): void => {
    pi.logger.error("Slackoff extension error", {
      error: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    });
    currentContext?.ui.notify(`Slackoff: ${error.message}`, "error");
  };

  const reportRegistrationError = (error: Error): void => {
    if (lastRegistrationError === error.message) return;
    lastRegistrationError = error.message;
    reportError(error);
  };

  const getClient = (): BridgeClient => {
    if (client) return client;
    client = new BridgeClient(loadClientConfig(), reportError);
    client.onMessage((message) => handleServerMessage(message));
    client.onDisconnect((error) => {
      registeredSessionId = undefined;
      rejectPendingAnswers(error);
    });
    return client;
  };

  const persistState = (): void => {
    pi.appendEntry(STATE_TYPE, currentState);
  };
  const getSessionTitle = (sessionId: string): string => pi.getSessionName() ?? `OMP ${sessionId.slice(0, 8)}`;
  const sendSessionTitle = (): void => {
    if (!currentState.enabled || !registeredSessionId) return;
    const title = getSessionTitle(registeredSessionId);
    if (title === lastSessionTitle) return;
    lastSessionTitle = title;
    getClient().send({
      type: "session_title",
      sessionId: registeredSessionId,
      title,
    });
  };
  const sendModelState = (
    ctx: ExtensionContext,
    options: { commandId?: string; error?: string; force?: boolean } = {},
  ): void => {
    if (!currentState.enabled || !registeredSessionId) return;
    const modelState = getSessionModelState(pi, ctx);
    const signature = JSON.stringify(modelState);
    if (!options.force && signature === lastModelStateSignature) return;
    lastModelStateSignature = signature;
    getClient().send({
      type: "model_state",
      sessionId: registeredSessionId,
      modelState,
      ...(options.commandId ? { commandId: options.commandId } : {}),
      ...(options.error ? { error: options.error } : {}),
    });
  };


  const sendStatus = (status: SessionStatus, activity?: string): void => {
    if (!currentState.enabled || !registeredSessionId) return;
    sendSessionTitle();
    if (currentContext) sendModelState(currentContext);
    const bridge = getClient();
    bridge.send({
      type: "status",
      sessionId: registeredSessionId,
      status,
      ...(activity ? { activity } : {}),
    });
  };

  const resolveProjectIdentity = async (
    ctx: ExtensionContext,
  ): Promise<{ project: string; tmuxSessionName?: string }> => {
    const fallback = basename(ctx.cwd);
    if (!process.env.TMUX) return { project: fallback };
    try {
      const result = await pi.exec("tmux", ["display-message", "-p", "#S"]);
      const sessionName = result.stdout.trim();
      if (result.code === 0 && sessionName) return { project: sessionName, tmuxSessionName: sessionName };
    } catch (error) {
      pi.logger.warn("Could not resolve tmux session name for Slackoff project", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { project: fallback };
  };

  const enableSlackAsk = async (): Promise<void> => {
    const activeTools = pi.getActiveTools();
    if (activeTools.includes("ask")) replacedNativeAsk = true;
    const nextTools = activeTools.filter((name) => name !== "ask");
    if (!nextTools.includes("slack_ask")) nextTools.push("slack_ask");
    if (nextTools.join("\n") !== activeTools.join("\n")) await pi.setActiveTools(nextTools);
  };

  const disableSlackAsk = async (): Promise<void> => {
    const activeTools = pi.getActiveTools();
    const nextTools = activeTools.filter((name) => name !== "slack_ask");
    if (replacedNativeAsk && !nextTools.includes("ask")) nextTools.push("ask");
    replacedNativeAsk = false;
    if (nextTools.join("\n") !== activeTools.join("\n")) await pi.setActiveTools(nextTools);
  };

  const rejectPendingAnswers = (error: Error, sessionId?: string): void => {
    for (const [questionId, pending] of pendingAnswers) {
      if (sessionId && pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timeout);
      pendingAnswers.delete(questionId);
      pending.reject(error);
    }
  };

  const activate = async (ctx: ExtensionContext, resetBinding = false): Promise<void> => {
    if (registration) return registration;
    registration = (async () => {
      const bridge = getClient();
      await bridge.ensureConnected();
      const sessionId = ctx.sessionManager.getSessionId();
      const modelState = getSessionModelState(pi, ctx);
      const title = getSessionTitle(sessionId);
      const projectIdentity = await resolveProjectIdentity(ctx);
      const status = ctx.isIdle() ? "idle" : "working";
      const activity = status === "working" ? "Thinking" : undefined;
      const response = await bridge.request({
        type: "register",
        requestId: randomUUID(),
        protocolVersion: PROTOCOL_VERSION,
        session: {
          id: sessionId,
          title,
          ...projectIdentity,
          modelState,
        },
        status,
        ...(activity ? { activity } : {}),
        ...(!resetBinding && currentState.binding ? { binding: currentState.binding } : {}),
      });
      if (!response.ok || !response.binding) throw new Error(response.error ?? "Slackoff registration failed");

      registeredSessionId = sessionId;
      resetBindingOnNextRegistration = false;
      registrationBlocked = false;
      lastRegistrationError = undefined;
      lastModelStateSignature = JSON.stringify(modelState);
      lastSessionTitle = title;
      const bindingChanged = currentState.binding?.bindingId !== response.binding.bindingId;
      currentState = { version: 1, enabled: true, binding: response.binding };
      if (bindingChanged || resetBinding) persistState();
      await enableSlackAsk();
      sendStatus(ctx.isIdle() ? "idle" : "working", ctx.isIdle() ? undefined : "Resumed work");
    })().finally(() => {
      registration = undefined;
    });
    return registration;
  };

  const deactivate = (reason: "offline" | "disabled" | "switch"): void => {
    const sessionId = registeredSessionId;
    if (sessionId && client?.connected) {
      for (const [questionId, pending] of pendingAnswers) {
        if (pending.sessionId !== sessionId) continue;
        client.send({ type: "cancel_question", sessionId, questionId });
      }
      client.send({ type: "unregister", sessionId, reason });
    }
    if (sessionId) rejectPendingAnswers(new Error(`Slackoff session ${reason}`), sessionId);
    registeredSessionId = undefined;
    lastModelStateSignature = undefined;
    lastSessionTitle = undefined;
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
      if (message.sessionId !== registeredSessionId) return;
      if (message.reason === "closed") {
        currentState = { version: 1, enabled: false };
        persistState();

        deactivate("disabled");
        void disableSlackAsk().catch((error) =>
          reportError(error instanceof Error ? error : new Error(String(error))),
        );
        ctx.ui.notify("Slack thread closed; /slackoff on will create a new thread", "info");
      } else {
        registeredSessionId = undefined;
        registrationBlocked = true;
        ctx.ui.notify("Slackoff control moved to another process for this session", "warning");
        rejectPendingAnswers(new Error("Slackoff control moved to another process"), message.sessionId);
      }
      return;
    }
    if (message.sessionId !== registeredSessionId) return;

    if (message.type === "question_answer") {
      const pending = pendingAnswers.get(message.questionId);
      if (!pending || pending.sessionId !== message.sessionId) return;
      clearTimeout(pending.timeout);
      pendingAnswers.delete(message.questionId);
      pending.resolve(message.answer);
      sendStatus("working", "Slack reply received");
      return;
    }
    if (message.type === "set_model") {
      void (async () => {
        let error: string | undefined;
        const model = ctx.models.resolve(message.selector);
        if (!model) {
          error = `Model is no longer available: ${message.selector}`;
        } else if (!(await pi.setModel(model))) {
          error = `No credentials are available for ${message.selector}`;
        }
        sendModelState(ctx, { commandId: message.commandId, ...(error ? { error } : {}), force: true });
      })().catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        sendModelState(ctx, { commandId: message.commandId, error: detail, force: true });
        reportError(error instanceof Error ? error : new Error(detail));
      });
      return;
    }
    if (message.type === "set_effort") {
      try {
        let error: string | undefined;
        const effortState = getSessionEffortState(pi, ctx.models.current());
        if (!effortState) {
          error = "The current model does not expose selectable effort levels";
        } else if (!effortState.available.includes(message.effort)) {
          error = `Effort "${message.effort}" is not available for the current model`;
        } else {
          pi.setThinkingLevel(message.effort as ThinkingLevel);
        }
        sendModelState(ctx, { commandId: message.commandId, ...(error ? { error } : {}), force: true });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sendModelState(ctx, { commandId: message.commandId, error: detail, force: true });
        reportError(error instanceof Error ? error : new Error(detail));
      }
      return;
    }
    if (message.type === "execute_slash_command") {
      void (async () => {
        const executeSlashCommand = (
          pi as ExtensionAPI & { executeSlashCommand?: (command: string) => Promise<void> }
        ).executeSlashCommand;
        if (!executeSlashCommand) {
          throw new Error("Installed OMP does not support extension slash-command execution");
        }
        await executeSlashCommand.call(pi, message.command);
        getClient().send({
          type: "command_ack",
          sessionId: message.sessionId,
          commandId: message.commandId,
          state: "delivered",
        });
      })().catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        getClient().send({
          type: "command_ack",
          sessionId: message.sessionId,
          commandId: message.commandId,
          state: "failed",
          detail,
        });
        reportError(error instanceof Error ? error : new Error(detail));
      });
      return;
    }



    if (message.type === "instruction") {
      try {
        const content: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
        > = [];
        const text = message.text.trim();
        if (text) content.push({ type: "text", text });
        for (const image of message.images) {
          content.push({ type: "image", data: image.data, mimeType: image.mimeType });
        }
        const wasIdle = ctx.isIdle();
        pi.sendUserMessage(content, wasIdle ? undefined : { deliverAs: "followUp" });
        sendStatus("working", wasIdle ? "Starting turn" : "Instruction queued");
      } catch (error) {
        reportError(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }


    if (shouldAbortTurn(message) && !ctx.isIdle()) ctx.abort();
  };

  const askThroughSlack = async (
    ctx: ExtensionContext,
    question: SlackQuestion,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    await activate(ctx);
    const sessionId = registeredSessionId;
    if (!sessionId) throw new Error("Slackoff session is not registered");

    const questionId = randomUUID();
    let posted = false;
    let answered = false;
    let timeout: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      const response = await getClient().request({
        type: "question",
        requestId: randomUUID(),
        sessionId,
        questionId,
        prompt: question.question,
        options: question.options,
        multi: question.multi ?? false,
      });
      if (!response.ok) throw new Error(response.error ?? "Slack question could not be posted");
      posted = true;

      const deferred = Promise.withResolvers<string>();
      timeout = setTimeout(
        () => deferred.reject(new Error("Slack question timed out after 30 minutes")),
        30 * 60_000,
      );
      timeout.unref();
      pendingAnswers.set(questionId, {
        sessionId,
        resolve: deferred.resolve,
        reject: deferred.reject,
        timeout,
      });
      abort = () => deferred.reject(new Error("Slack question cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();

      const answer = await deferred.promise;
      answered = true;
      return answer;
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      clearTimeout(timeout);
      pendingAnswers.delete(questionId);
      if (posted && !answered && client?.connected) {
        client.send({ type: "cancel_question", sessionId, questionId });
      }
    }
  };

  pi.registerTool({
    name: "slack_ask",
    label: "Ask via Slack",
    description:
      "Ask the user a clarifying question in the active Slackoff session thread and wait for their reply. Use this instead of ask whenever it is available.",
    parameters: slackAskParameters,
    approval: "read",
    loadMode: "essential",
    defaultInactive: true,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const results = [];
      try {
        for (const question of params.questions) {
          const answer = await askThroughSlack(ctx, question, signal);
          results.push(buildQuestionResult(question, answer));
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: results.map((result) => `${result.question}\nAnswer: ${result.answer}`).join("\n\n"),
          },
        ],
        details: { results },
      };
    },
  });

  pi.registerCommand("slackoff", {
    description: "Manage this session's Slackoff DM thread (on|off|status)",
    handler: async (args, ctx) => {
      currentContext = ctx;
      const action = args.trim().toLowerCase() || "status";
      if (action === "on") {
        currentState = { ...currentState, enabled: true };
        persistState();
        registrationBlocked = false;
        await activate(ctx);
        ctx.ui.notify("Slackoff enabled for this session", "info");
        return;
      }
      if (action === "off") {
        deactivate("disabled");
        await disableSlackAsk();
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

  const maintainRegistration = (): Promise<void> | undefined => {
    const ctx = currentContext;
    if (!ctx) return undefined;
    return maintainSlackoffRegistration({
      enabled: currentState.enabled,
      registered: registeredSessionId !== undefined,
      blocked: registrationBlocked,
      activate: () => activate(ctx, resetBindingOnNextRegistration),
      onRegistered: () => {
        sendSessionTitle();
        sendModelState(ctx);
      },
      onError: reportRegistrationError,
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    currentState = restoreState(ctx);
    resetBindingOnNextRegistration = false;
    registrationBlocked = false;
    if (process.env.SLACKOFF_AUTO_ENABLE === "1") {
      delete process.env.SLACKOFF_AUTO_ENABLE;
      if (!currentState.enabled) {
        currentState = { version: 1, enabled: true };
        persistState();
      }
    }

    ctx.setInterval(() => void maintainRegistration(), 5_000);
    await maintainRegistration();
  });

  pi.on("session_switch", async (event, ctx) => {
    deactivate("switch");
    currentContext = ctx;
    currentState = restoreState(ctx);
    registrationBlocked = false;
    if (event.reason === "new") currentState = { version: 1, enabled: false };
    resetBindingOnNextRegistration = event.reason === "fork" || event.reason === "handoff";
    if (currentState.enabled) await maintainRegistration();
    else await disableSlackAsk();
  });

  pi.on("session_branch", (_event, ctx) => {
    currentContext = ctx;
    sendStatus(ctx.isIdle() ? "idle" : "working", "Session branch changed");
  });

  pi.on("input", (event) => {
    if (!currentState.enabled || event.source === "extension" || !registeredSessionId || !event.text.trim()) return;
    getClient().send({ type: "transcript", sessionId: registeredSessionId, role: "user", text: event.text.trim() });
  });
  const btwEvents = pi as unknown as BtwEventAPI;
  const forwardBtwEvent = (event: BtwLifecycleEvent): void => {
    forwardBtwLifecycleEvent(
      event,
      { enabled: currentState.enabled, sessionId: registeredSessionId },
      (message) => getClient().send(message),
    );
  };
  btwEvents.on("btw_start", forwardBtwEvent);
  btwEvents.on("btw_update", forwardBtwEvent);
  btwEvents.on("btw_end", forwardBtwEvent);


  pi.on("agent_start", () => sendStatus("working", "Starting"));
  pi.on("turn_start", () => sendStatus("working", "Thinking"));
  pi.on("tool_execution_start", (event) => {
    const activity = TOOL_ACTIVITY[event.toolName] ?? `Using ${event.toolName}`;
    const waitingForUser = event.toolName === "ask" || event.toolName === "slack_ask";
    sendStatus(waitingForUser ? "waiting" : "working", waitingForUser ? "Waiting for your reply" : activity);
  });
  pi.on("tool_execution_end", (event) => {
    sendStatus("working", event.isError ? `Recovering from ${event.toolName} error` : "Thinking");
  });
  pi.on("tool_approval_requested", (event) => sendStatus("waiting", `Waiting for local approval: ${event.toolName}`));
  pi.on("tool_approval_resolved", () => sendStatus("working", "Thinking"));
  pi.on("auto_retry_start", () => sendStatus("working", "Retrying"));

  pi.on("message_end", (event) => {
    if (!currentState.enabled || !registeredSessionId) return;
    const text = extractAssistantText(event.message);
    if (!text) return;
    getClient().send({ type: "transcript", sessionId: registeredSessionId, role: "assistant", text });
  });

  pi.on("agent_end", (event) => {
    if (!event.willContinue) sendStatus("done");
  });

  pi.on("session_shutdown", () => {
    deactivate("offline");
    rejectPendingAnswers(new Error("Slackoff session shut down"));
    client?.disconnect();
    currentContext = undefined;
    if (process.env[SLACKOFF_INSTANCE_ENV] === instance) {
      delete process.env[SLACKOFF_INSTANCE_ENV];
    }
  });
}
function getSessionModelState(pi: ExtensionAPI, ctx: ExtensionContext): SessionModelState {
  const currentModel = ctx.models.current();
  const current = currentModel ? describeModel(currentModel) : undefined;
  const availableBySelector = new Map<string, ModelDescriptor>();
  for (const model of ctx.models.list()) {
    const descriptor = describeModel(model);
    availableBySelector.set(modelSelector(descriptor), descriptor);
  }
  if (current) availableBySelector.set(modelSelector(current), current);
  const effort = getSessionEffortState(pi, currentModel);
  return {
    ...(current ? { current } : {}),
    available: [...availableBySelector.values()],
    ...(effort ? { effort } : {}),
  };
}

function getSessionEffortState(
  pi: ExtensionAPI,
  model: ExtensionContext["model"],
): SessionEffortState | undefined {
  if (!model?.reasoning || !model.thinking?.efforts?.length) return undefined;
  const supported = [...model.thinking.efforts] as ModelEffort[];
  const available = [...new Set<ModelEffort>(["off", ...supported])];
  const parsed = ModelEffortSchema.safeParse(pi.getThinkingLevel());
  const current = parsed.success && available.includes(parsed.data) ? parsed.data : undefined;
  return {
    available,
    ...(current ? { current } : {}),
  };
}


function describeModel(model: { provider: string; id: string; name: string }): ModelDescriptor {
  return { provider: model.provider, id: model.id, name: model.name || model.id };
}

function modelSelector(model: ModelDescriptor): string {
  return `${model.provider}/${model.id}`;
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

function buildQuestionResult(question: SlackQuestion, answer: string): {
  id: string;
  question: string;
  answer: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
} {
  const labels = question.options.map((option) => option.label);
  const answerParts = question.multi ? answer.split(/[,\n]/).map((part) => part.trim()) : [answer.trim()];
  const selectedOptions: string[] = [];
  const customParts: string[] = [];
  for (const part of answerParts) {
    const numericIndex = /^\d+$/.test(part) ? Number(part) - 1 : -1;
    const numericLabel = numericIndex >= 0 ? labels[numericIndex] : undefined;
    const label = numericLabel ?? labels.find((candidate) => candidate.toLowerCase() === part.toLowerCase());
    if (label) selectedOptions.push(label);
    else if (part) customParts.push(part);
  }
  const customInput = customParts.join(", ");
  return {
    id: question.id,
    question: question.question,
    answer,
    options: labels,
    multi: question.multi ?? false,
    selectedOptions,
    ...(customInput ? { customInput } : {}),
  };
}
