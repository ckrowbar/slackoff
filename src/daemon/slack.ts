import { randomUUID } from "node:crypto";

import { App, LogLevel } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import { z } from "zod";

import type { DaemonConfig } from "../config.js";
import {
  encodeMessage,
  type QuestionRequest,
  type SessionDescriptor,
  type SessionStatus,
  type SlackBinding,
} from "../protocol.js";
import {
  buildCollapsedSessionBlocks,
  buildSessionBlocks,
  CLOSE_THREAD_ACTION,
  escapeMrkdwn,
  STOP_ACTION,
} from "./blocks.js";
import type { ActiveSession } from "./registry.js";
import { SessionRegistry } from "./registry.js";

const DmMessageSchema = z.object({
  type: z.literal("message"),
  channel: z.string().min(1),
  user: z.string().min(1),
  text: z.string().default(""),
  ts: z.string().min(1),
  thread_ts: z.string().optional(),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
});

const ActionValueSchema = z.object({ value: z.string().min(1) });
const ActionBodySchema = z.object({
  user: z.object({ id: z.string().min(1) }),
});
const SlackErrorSchema = z.object({ data: z.object({ error: z.string() }) });

export class SlackController {
  readonly #app: App;
  readonly #config: DaemonConfig;
  readonly #registry: SessionRegistry;
  readonly #seenEvents = new Map<string, number>();
  readonly #rootRefreshTimers = new Map<string, NodeJS.Timeout>();
  readonly #closedBindings = new Set<string>();

  constructor(config: DaemonConfig, registry: SessionRegistry) {
    this.#config = config;
    this.#registry = registry;
    this.#app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
    });
    this.#registerHandlers();
  }

  get client(): WebClient {
    return this.#app.client;
  }

  async start(): Promise<void> {
    await this.#app.start();
  }

  async stop(): Promise<void> {
    for (const timer of this.#rootRefreshTimers.values()) clearTimeout(timer);
    this.#rootRefreshTimers.clear();
    await this.#app.stop();
  }

  async ensureBinding(session: SessionDescriptor, binding: SlackBinding | undefined): Promise<SlackBinding> {
    if (binding && !this.#closedBindings.delete(binding.bindingId)) {
      try {
        await this.#app.client.chat.update({
          channel: binding.channelId,
          ts: binding.threadTs,
          text: `OMP session: ${session.title}`,
          blocks: buildSessionBlocks(session, binding.bindingId, "idle", undefined),
        });
        return binding;
      } catch (error) {
        const parsed = SlackErrorSchema.safeParse(error);
        const code = parsed.success ? parsed.data.data.error : undefined;
        if (code !== "message_not_found" && code !== "channel_not_found") throw error;
      }
    }

    const bindingId = randomUUID();
    const result = await this.#app.client.chat.postMessage({
      channel: this.#config.userId,
      text: `OMP session: ${session.title}`,
      blocks: buildSessionBlocks(session, bindingId, "idle", undefined),
    });
    if (!result.channel || !result.ts) throw new Error("Slack did not return a DM channel and message timestamp");
    return { bindingId, channelId: result.channel, threadTs: result.ts };
  }

  async refreshRoot(record: ActiveSession): Promise<void> {
    clearTimeout(this.#rootRefreshTimers.get(record.session.id));
    this.#rootRefreshTimers.delete(record.session.id);
    await this.#app.client.chat.update({
      channel: record.binding.channelId,
      ts: record.binding.threadTs,
      text: record.collapsed
        ? `${record.session.title} · Closed`
        : `${record.session.title} · ${record.activity ?? record.status}`,
      blocks: record.collapsed
        ? buildCollapsedSessionBlocks(record.session)
        : buildSessionBlocks(record.session, record.binding.bindingId, record.status, record.activity),
    });

  }

  scheduleRootRefresh(record: ActiveSession): void {
    clearTimeout(this.#rootRefreshTimers.get(record.session.id));
    const timer = setTimeout(() => {
      this.#rootRefreshTimers.delete(record.session.id);
      void this.refreshRoot(record).catch((error) => console.error("OMP status update failed", error));
    }, 350);
    timer.unref();
    this.#rootRefreshTimers.set(record.session.id, timer);
  }

  async postTranscript(record: ActiveSession, role: "user" | "assistant", text: string): Promise<void> {
    const label = role === "user" ? "Local instruction" : "OMP";

    for (const chunk of splitText(text, 2_800)) {
      await this.#app.client.chat.postMessage({
        channel: record.binding.channelId,
        thread_ts: record.binding.threadTs,
        text: `${label}: ${chunk}`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*${label}*\n${escapeMrkdwn(chunk)}` },
          },
        ],
      });
    }
  }


  async postQuestion(record: ActiveSession, question: QuestionRequest): Promise<void> {
    if (!record.socket) throw new Error("OMP session is offline");
    if (record.pendingQuestion) throw new Error("OMP session is already waiting for an answer");

    const result = await this.#app.client.chat.postMessage({
      channel: record.binding.channelId,
      thread_ts: record.binding.threadTs,
      text: `Question: ${question.prompt}`,
      blocks: buildQuestionBlocks(question.prompt, question.options, question.multi, "waiting"),
    });
    if (!result.ts) throw new Error("Slack did not return a question message timestamp");

    record.pendingQuestion = {
      questionId: question.questionId,
      messageTs: result.ts,
      prompt: question.prompt,
      multi: question.multi,
      options: question.options.map((option) => option.label),
    };
    record.status = "waiting";
    record.activity = "Waiting for your reply in Slack";
    await this.refreshRoot(record);
  }

  async cancelQuestion(
    record: ActiveSession,
    questionId: string,
    nextStatus: SessionStatus = "working",
  ): Promise<void> {
    const pending = record.pendingQuestion;
    if (!pending || pending.questionId !== questionId) return;
    record.pendingQuestion = undefined;
    await this.#app.client.chat.update({
      channel: record.binding.channelId,
      ts: pending.messageTs,
      text: `Cancelled question: ${pending.prompt}`,
      blocks: buildQuestionBlocks(
        pending.prompt,
        pending.options.map((label) => ({ label })),
        pending.multi,
        "cancelled",
      ),
    });
    record.status = nextStatus;
    record.activity = nextStatus === "working" ? "Question cancelled" : undefined;
    await this.refreshRoot(record);
  }

  #registerHandlers(): void {
    this.#app.event("message", async ({ event, body }) => {
      const eventId = "event_id" in body && typeof body.event_id === "string" ? body.event_id : undefined;
      if (eventId && this.#isDuplicateEvent(eventId)) return;
      const parsed = DmMessageSchema.safeParse(event);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.bot_id || message.subtype) return;
      if (message.user !== this.#config.userId) {
        console.warn(`Slackoff ignored a DM from unauthorized user ${message.user}`);
        return;
      }

      if (!message.thread_ts) {
        await this.#app.client.chat.postMessage({
          channel: message.channel,
          text: "Reply inside an OMP session thread, or enable a session from OMP with /slackoff on.",
        });
        return;
      }

      const record = this.#registry.getByThread(message.channel, message.thread_ts);
      if (!record) return;
      if (await this.#routeQuestionAnswer(record, message.text)) return;
      await this.routeInstruction(record, message.text);
    });

    

    this.#app.action(STOP_ACTION, async ({ ack, body, action }) => {
      await ack();
      const parsedBody = ActionBodySchema.safeParse(body);
      const parsedAction = ActionValueSchema.safeParse(action);
      if (!parsedBody.success || !parsedAction.success || parsedBody.data.user.id !== this.#config.userId) return;
      const record = this.#registry.getByBindingId(parsedAction.data.value);
      if (!record) return;
      await this.stopTurn(record);
    });

    this.#app.action(CLOSE_THREAD_ACTION, async ({ ack, body, action }) => {
      await ack();
      const parsedBody = ActionBodySchema.safeParse(body);
      const parsedAction = ActionValueSchema.safeParse(action);
      if (!parsedBody.success || !parsedAction.success || parsedBody.data.user.id !== this.#config.userId) return;
      const record = this.#registry.getByBindingId(parsedAction.data.value);
      if (!record) return;
      await this.closeSession(record);
    });

    
  }

  async #routeQuestionAnswer(record: ActiveSession, answer: string): Promise<boolean> {
    const pending = record.pendingQuestion;
    if (!pending) return false;
    if (!record.socket) {
      await this.#app.client.chat.postMessage({
        channel: record.binding.channelId,
        thread_ts: record.binding.threadTs,
        text: "Session offline; answer was not delivered.",
      });
      return true;
    }

    record.socket.write(
      encodeMessage({
        type: "question_answer",
        sessionId: record.session.id,
        questionId: pending.questionId,
        answer,
      }),
    );
    record.pendingQuestion = undefined;
    await this.#app.client.chat.update({
      channel: record.binding.channelId,
      ts: pending.messageTs,
      text: `Answered question: ${pending.prompt}`,
      blocks: buildQuestionBlocks(
        pending.prompt,
        pending.options.map((label) => ({ label })),
        pending.multi,
        "answered",
      ),
    });
    record.status = "working";
    record.activity = "Reply received";
    await this.refreshRoot(record);
    return true;
  }

  async routeInstruction(record: ActiveSession, text: string): Promise<void> {
    if (record.collapsed || record.status === "disabled") return;
    if (!record.socket) {
      await this.#app.client.chat.postMessage({
        channel: record.binding.channelId,
        thread_ts: record.binding.threadTs,
        text: "Session offline; instruction was not delivered.",
      });
      return;
    }

    record.collapsed = false;
    record.status = "working";
    record.activity = "Instruction queued";
    this.scheduleRootRefresh(record);
    record.socket.write(
      encodeMessage({ type: "instruction", sessionId: record.session.id, commandId: randomUUID(), text }),
    );
  }

  async stopTurn(record: ActiveSession): Promise<void> {
    record.collapsed = false;
    record.status = "stopping";
    record.activity = "Stopping active turn";
    if (record.socket) {
      record.socket.write(
        encodeMessage({ type: "stop", sessionId: record.session.id, commandId: randomUUID() }),
      );
    }
    await this.refreshRoot(record);
  }

  async closeSession(record: ActiveSession): Promise<void> {
    record.collapsed = true;
    record.status = "disabled";
    record.activity = undefined;
    this.#closedBindings.add(record.binding.bindingId);
    if (record.socket) {
      record.socket.write(
        encodeMessage({ type: "stop", sessionId: record.session.id, commandId: randomUUID() }),
      );
      record.socket.write(
        encodeMessage({ type: "replaced", sessionId: record.session.id, reason: "closed" }),
      );
    }
    await this.refreshRoot(record);
  }

  #isDuplicateEvent(eventId: string): boolean {
    const now = Date.now();
    for (const [id, expiry] of this.#seenEvents) {
      if (expiry <= now) this.#seenEvents.delete(id);
    }
    if (this.#seenEvents.has(eventId)) return true;
    this.#seenEvents.set(eventId, now + 30 * 60_000);
    return false;
  }
}

type QuestionState = "waiting" | "answered" | "cancelled";

function buildQuestionBlocks(
  prompt: string,
  options: Array<{ label: string; description?: string | undefined }>,
  multi: boolean,
  state: QuestionState,
): KnownBlock[] {
  const stateText: Record<QuestionState, string> = {
    waiting: multi ? "Reply in this thread with one or more choices." : "Reply in this thread with your choice.",
    answered: "Answered in this thread.",
    cancelled: "Question cancelled.",
  };
  const optionLines = options.map((option, index) => {
    const description = option.description ? ` — ${escapeMrkdwn(option.description)}` : "";
    return `${index + 1}. *${escapeMrkdwn(option.label)}*${description}`;
  });
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*OMP needs your input*\n${escapeMrkdwn(prompt)}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: optionLines.join("\n") },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: stateText[state] }],
    },
  ];
}


function splitText(text: string, maximum: number): string[] {
  const normalized = text.trim();
  if (normalized.length <= maximum) return [normalized];
  const chunks: string[] = [];
  for (let offset = 0; offset < normalized.length; offset += maximum) {
    chunks.push(normalized.slice(offset, offset + maximum));
  }
  return chunks;
}
