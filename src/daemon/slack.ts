import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import { App, LogLevel } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import { z } from "zod";

import type { DaemonConfig } from "../config.js";
import {
  buildBtwMetadata,
  buildQuestionMetadata,
  buildSessionMetadata,
  buildTranscriptMetadata,
  type MessageMetadata,
} from "../metadata.js";
import {
  parseSessionLaunchRequest,
  SESSION_LAUNCH_FAILURE_PREFIX,
  SESSION_LAUNCH_REQUEST_PREFIX,
  SESSION_LAUNCH_SUCCESS_PREFIX,
} from "../session-launch.js";
import {
  encodeMessage,
  type ImageInput,
  type QuestionRequest,
  type SessionDescriptor,
  type SessionStatus,
  type SlackBinding,
} from "../protocol.js";
import {
  buildAttachSessionModal,
  buildCloseSessionModal,
  buildCollapsedSessionBlocks,
  buildThreadReplyPermalink,
  buildHomeView,
  buildLaunchModal,
  buildSessionBlocks,
  CLOSE_AND_DELETE_TMUX,
  CLOSE_SESSION_BLOCK,
  CLOSE_SESSION_INPUT,
  CLOSE_SESSION_VIEW,
  CLOSE_THREAD_ACTION,
  CLOSE_THREAD_ONLY,
  escapeMrkdwn,
  HOME_ATTACH_ACTION,
  HOME_ATTACH_BLOCK,
  HOME_ATTACH_INPUT,
  HOME_ATTACH_VIEW,
  HOME_CWD_BLOCK,
  HOME_CWD_INPUT,
  HOME_LAUNCH_VIEW,
  HOME_NAME_BLOCK,
  HOME_NAME_INPUT,
  HOME_NEW_SESSION_ACTION,
  HOME_PROMPT_BLOCK,
  HOME_PROMPT_INPUT,
  MODEL_ACTION,
  STOP_ACTION,
} from "./blocks.js";
import { parseThreadCommand } from "./commands.js";
import { downloadSlackImages } from "./images.js";
import { TmuxAttachmentTracker, TmuxLauncher } from "./launcher.js";
import {
  abortBtwRequests as abortActiveBtwRequests,
  appendBtwDelta,
  completeBtwRequest,
  finishBtwRequest,
  startBtwRequest,
  type ActiveSession,
  type BtwRequest,
} from "./registry.js";
import { SessionRegistry } from "./registry.js";

const DmMessageSchema = z.object({
  type: z.literal("message"),
  channel: z.string().min(1),
  user: z.string().min(1),
  text: z.string().default(""),
  ts: z.string().min(1),
  thread_ts: z.string().optional(),
  files: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        mimetype: z.string(),
        size: z.number().int().nonnegative(),
        url_private: z.string().url().optional(),
        url_private_download: z.string().url().optional(),
      }),
    )
    .default([]),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
});

const ActionValueSchema = z.object({ value: z.string().min(1) });
const ModelActionSchema = z.object({
  block_id: z.string().min(1),
  selected_option: z.object({ value: z.string().min(1) }),
});
const ActionBodySchema = z.object({
  user: z.object({ id: z.string().min(1) }),
});
const HomeActionBodySchema = z.object({
  user: z.object({ id: z.string().min(1) }),
  trigger_id: z.string().min(1),
});
const HomeLaunchBodySchema = z.object({
  user: z.object({ id: z.string().min(1) }),
});
const HomeLaunchStateSchema = z.object({
  [HOME_NAME_BLOCK]: z.object({
    [HOME_NAME_INPUT]: z.object({ value: z.string() }),
  }),
  [HOME_CWD_BLOCK]: z.object({
    [HOME_CWD_INPUT]: z.object({ value: z.string() }),
  }),
  [HOME_PROMPT_BLOCK]: z.object({
    [HOME_PROMPT_INPUT]: z.object({ value: z.string().nullish() }),
  }),
});
const HomeAttachStateSchema = z.object({
  [HOME_ATTACH_BLOCK]: z.object({
    [HOME_ATTACH_INPUT]: z.object({
      selected_option: z.object({ value: z.string().min(1) }),
    }),
  }),
});
const CloseSessionStateSchema = z.object({
  [CLOSE_SESSION_BLOCK]: z.object({
    [CLOSE_SESSION_INPUT]: z.object({
      selected_option: z.object({
        value: z.enum([CLOSE_THREAD_ONLY, CLOSE_AND_DELETE_TMUX]),
      }),
    }),
  }),
});
const SlackErrorSchema = z.object({ data: z.object({ error: z.string() }) });

export class SlackController {
  readonly #app: App;
  readonly #config: DaemonConfig;
  readonly #registry: SessionRegistry;
  readonly #launcher: TmuxLauncher;
  readonly #seenEvents = new Map<string, number>();
  readonly #rootRefreshTimers = new Map<string, NodeJS.Timeout>();
  readonly #btwUpdateTimers = new Map<string, NodeJS.Timeout>();
  readonly #btwUpdateChains = new Map<string, Promise<void>>();
  readonly #closedBindings = new Set<string>();
  readonly #threadPermalinks = new Map<string, string>();
  readonly #tmuxAttachments = new TmuxAttachmentTracker();
  #homeRefreshTimer: NodeJS.Timeout | undefined;
  #homeNotice: string | undefined;

  constructor(config: DaemonConfig, registry: SessionRegistry) {
    this.#config = config;
    this.#registry = registry;
    this.#launcher = new TmuxLauncher(config.ompPath);
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

  claimTmuxAttachment(session: SessionDescriptor): SessionDescriptor {
    const name = this.#tmuxAttachments.claim(session.id, session.tmuxSessionName);
    return name ? { ...session, project: name, tmuxSessionName: name } : session;
  }

  completeTmuxAttachment(sessionId: string): void {
    this.#tmuxAttachments.complete(sessionId);
  }

  async start(): Promise<void> {
    await this.#app.start();
    await this.publishHome();
  }
  async stop(): Promise<void> {
    for (const timer of this.#rootRefreshTimers.values()) clearTimeout(timer);
    this.#rootRefreshTimers.clear();
    for (const timer of this.#btwUpdateTimers.values()) clearTimeout(timer);
    this.#btwUpdateTimers.clear();
    await Promise.allSettled(this.#btwUpdateChains.values());
    this.#btwUpdateChains.clear();
    clearTimeout(this.#homeRefreshTimer);
    this.#homeRefreshTimer = undefined;
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
          metadata: buildSessionMetadata({
            sessionId: session.id,
            bindingId: binding.bindingId,
            title: session.title,
            project: session.project,
            status: "idle",
            activity: undefined,
            collapsed: false,
            connected: true,
            model: session.modelState.current,
            models: session.modelState.available,
            effort: session.modelState.effort?.current,
            efforts: session.modelState.effort?.available,
          }),
        });
        await this.#getThreadPermalink(binding);
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
      metadata: buildSessionMetadata({
        sessionId: session.id,
        bindingId,
        title: session.title,
        project: session.project,
        status: "idle",
        activity: undefined,
        collapsed: false,
        connected: true,
        model: session.modelState.current,
        models: session.modelState.available,
        effort: session.modelState.effort?.current,
        efforts: session.modelState.effort?.available,
      }),
    });
    if (!result.channel || !result.ts) throw new Error("Slack did not return a DM channel and message timestamp");
    const createdBinding = { bindingId, channelId: result.channel, threadTs: result.ts };
    await this.#getThreadPermalink(createdBinding);
    return createdBinding;
  }

  #sessionMetadata(record: ActiveSession): MessageMetadata {
    return buildSessionMetadata({
      sessionId: record.session.id,
      bindingId: record.binding.bindingId,
      title: record.session.title,
      project: record.session.project,
      status: record.status,
      activity: record.activity,
      collapsed: record.collapsed,
      connected: record.socket !== undefined,
      model: record.session.modelState.current,
      models: record.session.modelState.available,
      effort: record.session.modelState.effort?.current,
      efforts: record.session.modelState.effort?.available,
    });
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
      metadata: this.#sessionMetadata(record),
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

  async publishHome(): Promise<void> {
    const records = [...this.#registry.values()].filter((record) => record.socket && !record.collapsed);
    const sessions = await Promise.all(
      records.map(async (record) => ({
        title: record.session.title,
        project: record.session.project,
        status: record.status,
        ...(record.activity ? { activity: record.activity } : {}),
        permalink: await this.#getThreadPermalink(record.binding),
      })),
    );
    await this.#app.client.views.publish({
      user_id: this.#config.userId,
      view: buildHomeView(sessions, this.#homeNotice),
    });
  }

  async #getThreadPermalink(binding: SlackBinding): Promise<string> {
    const key = `${binding.channelId}:${binding.threadTs}`;
    const cached = this.#threadPermalinks.get(key);
    if (cached) return cached;

    const result = await this.#app.client.chat.getPermalink({
      channel: binding.channelId,
      message_ts: binding.threadTs,
    });
    if (!result.permalink) throw new Error("Slack did not return a session thread permalink");
    this.#threadPermalinks.set(key, result.permalink);
    return result.permalink;
  }

  scheduleHomeRefresh(): void {
    clearTimeout(this.#homeRefreshTimer);
    this.#homeRefreshTimer = setTimeout(() => {
      this.#homeRefreshTimer = undefined;
      void this.publishHome().catch((error) => console.error("OMP App Home update failed", error));
    }, 500);
    this.#homeRefreshTimer.unref();
  }

  async postTranscript(record: ActiveSession, role: "user" | "assistant", text: string): Promise<void> {
    const chunks = splitText(text, 2_800);
    for (const [index, chunk] of chunks.entries()) {
      const result = await this.#app.client.chat.postMessage({
        channel: record.binding.channelId,
        thread_ts: record.binding.threadTs,
        text: role === "user" ? `Local instruction: ${chunk}` : chunk,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: role === "user" ? `*Local instruction*\n${escapeMrkdwn(chunk)}` : escapeMrkdwn(chunk),
            },
          },
        ],
        metadata: buildTranscriptMetadata({
          sessionId: record.session.id,
          bindingId: record.binding.bindingId,
          role,
          chunk: index,
          chunks: chunks.length,
        }),
      });
      if (result.ts) {
        const permalink = await this.#getThreadPermalink(record.binding);
        const key = `${record.binding.channelId}:${record.binding.threadTs}`;
        this.#threadPermalinks.set(
          key,
          buildThreadReplyPermalink(
            permalink,
            record.binding.channelId,
            record.binding.threadTs,
            result.ts,
          ),
        );
        this.scheduleHomeRefresh();
      }
    }
  }
  async postBtwStart(record: ActiveSession, requestId: string, question: string): Promise<void> {
    const request = startBtwRequest(record, requestId, question);
    if (!request) return;

    try {
      const result = await this.#app.client.chat.postMessage({
        channel: request.channelId,
        thread_ts: request.threadTs,
        text: buildBtwText(request),
        blocks: buildBtwBlocks(request),
        metadata: this.#btwMetadata(record, request),
      });
      if (!result.ts) throw new Error("Slack did not return a BTW message timestamp");
      request.messageTs = result.ts;
      if (request.outcome) await this.#settleTerminalBtwRequest(record, request);
    } catch (error) {
      if (!request.messageTs) {
        if (request.outcome) completeBtwRequest(record, request);
        else record.btwRequests.delete(requestId);
      }
      throw error;
    }
  }

  postBtwUpdate(record: ActiveSession, requestId: string, delta: string): void {
    const request = appendBtwDelta(record, requestId, delta);
    if (!request?.messageTs) return;
    const key = this.#btwTimerKey(record.session.id, requestId);
    if (this.#btwUpdateTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.#btwUpdateTimers.delete(key);
      const currentRecord = this.#registry.getBySessionId(record.session.id);
      const currentRequest = currentRecord?.btwRequests.get(requestId);
      if (!currentRecord || !currentRequest?.messageTs || currentRequest.outcome) return;
      void this.#queueBtwCardUpdate(currentRecord, currentRequest).catch((error) =>
        console.error("OMP BTW update failed", error),
      );
    }, 350);
    timer.unref();
    this.#btwUpdateTimers.set(key, timer);
  }

  async postBtwEnd(
    record: ActiveSession,
    end: {
      requestId: string;
      question: string;
      outcome: "completed" | "aborted" | "error";
      answer?: string | undefined;
      error?: string | undefined;
    },
  ): Promise<void> {
    const request = finishBtwRequest(record, end.requestId, end);
    if (!request) return;
    this.#clearBtwTimer(record.session.id, end.requestId);
    await this.#settleTerminalBtwRequest(record, request);
  }

  async abortBtwRequests(record: ActiveSession): Promise<void> {
    const aborted = abortActiveBtwRequests(record);
    await Promise.all(
      aborted.map(async (request) => {
        this.#clearBtwTimer(record.session.id, request.requestId);
        await this.#settleTerminalBtwRequest(record, request);
      }),
    );
  }
  async #settleTerminalBtwRequest(record: ActiveSession, request: BtwRequest): Promise<void> {
    if (!request.messageTs) return;
    try {
      await this.#queueBtwCardUpdate(record, request);
    } finally {
      completeBtwRequest(record, request);
    }
  }

  #queueBtwCardUpdate(record: ActiveSession, request: BtwRequest): Promise<void> {
    const key = this.#btwTimerKey(record.session.id, request.requestId);
    const prior = this.#btwUpdateChains.get(key) ?? Promise.resolve();
    const update = prior.catch(() => undefined).then(() => this.#updateBtwCard(record, request));
    this.#btwUpdateChains.set(key, update);
    return update.finally(() => {
      if (this.#btwUpdateChains.get(key) === update) this.#btwUpdateChains.delete(key);
    });
  }


  async #updateBtwCard(record: ActiveSession, request: BtwRequest): Promise<void> {
    if (!request.messageTs) return;
    await this.#app.client.chat.update({
      channel: request.channelId,
      ts: request.messageTs,
      text: buildBtwText(request),
      blocks: buildBtwBlocks(request),
      metadata: this.#btwMetadata(record, request),
    });
  }

  #btwMetadata(record: ActiveSession, request: BtwRequest): MessageMetadata {
    return buildBtwMetadata({
      sessionId: record.session.id,
      bindingId: request.bindingId,
      requestId: request.requestId,
      question: clipBtwText(request.question, 2_000),
      state: request.outcome ?? "working",
    });
  }

  #btwTimerKey(sessionId: string, requestId: string): string {
    return `${sessionId.length}:${sessionId}${requestId}`;
  }

  #clearBtwTimer(sessionId: string, requestId: string): void {
    const key = this.#btwTimerKey(sessionId, requestId);
    clearTimeout(this.#btwUpdateTimers.get(key));
    this.#btwUpdateTimers.delete(key);
  }



  async postQuestion(record: ActiveSession, question: QuestionRequest): Promise<void> {
    if (!record.socket) throw new Error("OMP session is offline");
    if (record.pendingQuestion) throw new Error("OMP session is already waiting for an answer");

    const result = await this.#app.client.chat.postMessage({
      channel: record.binding.channelId,
      thread_ts: record.binding.threadTs,
      text: `Question: ${question.prompt}`,
      blocks: buildQuestionBlocks(question.prompt, question.options, question.multi, "waiting"),
      metadata: buildQuestionMetadata({
        sessionId: record.session.id,
        bindingId: record.binding.bindingId,
        questionId: question.questionId,
        multi: question.multi,
        state: "waiting",
        options: question.options,
      }),
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
      metadata: buildQuestionMetadata({
        sessionId: record.session.id,
        bindingId: record.binding.bindingId,
        questionId: pending.questionId,
        multi: pending.multi,
        state: nextStatus === "offline" || nextStatus === "disabled" ? "offline" : "cancelled",
        options: pending.options.map((label) => ({ label })),
      }),
    });
    record.status = nextStatus;
    record.activity = nextStatus === "working" ? "Question cancelled" : undefined;
    await this.refreshRoot(record);
  }

  #registerHandlers(): void {
    this.#app.event("app_home_opened", async ({ event }) => {
      if (event.user !== this.#config.userId || event.tab !== "home") return;
      await this.publishHome();
    });

    this.#app.action(HOME_NEW_SESSION_ACTION, async ({ ack, body }) => {
      await ack();
      const parsed = HomeActionBodySchema.safeParse(body);
      if (!parsed.success || parsed.data.user.id !== this.#config.userId) return;
      await this.#app.client.views.open({
        trigger_id: parsed.data.trigger_id,
        view: buildLaunchModal(homedir()),
      });
    });

    this.#app.action(HOME_ATTACH_ACTION, async ({ ack, body }) => {
      await ack();
      const parsed = HomeActionBodySchema.safeParse(body);
      if (!parsed.success || parsed.data.user.id !== this.#config.userId) return;
      const sessions = await this.#availableOmpTmuxSessions();
      await this.#app.client.views.open({
        trigger_id: parsed.data.trigger_id,
        view: buildAttachSessionModal(sessions),
      });
    });

    this.#app.view(HOME_ATTACH_VIEW, async ({ ack, body, view }) => {
      const parsedBody = HomeLaunchBodySchema.safeParse(body);
      if (!parsedBody.success || parsedBody.data.user.id !== this.#config.userId) {
        await ack();
        return;
      }
      const parsedState = HomeAttachStateSchema.safeParse(view.state.values);
      if (!parsedState.success) {
        await ack({
          response_action: "errors",
          errors: { [HOME_ATTACH_BLOCK]: "Select an OMP tmux session." },
        });
        return;
      }
      try {
        const paneId = parsedState.data[HOME_ATTACH_BLOCK][HOME_ATTACH_INPUT].selected_option.value;
        const selected = (await this.#launcher.listOmpSessions()).find((session) => session.paneId === paneId);
        if (!selected) throw new Error("The selected OMP tmux pane is no longer available");
        const attachment = this.#tmuxAttachments.begin(selected.name);
        try {
          await this.#launcher.enableSlackoff(paneId);
        } catch (error) {
          attachment.cancel();
          throw error;
        }
        void attachment.promise.then(
          () => {
            this.#homeNotice = `Connected tmux session \`${selected.name}\` to Slackoff.`;
            this.scheduleHomeRefresh();
          },
          (error: unknown) => {
            this.#homeNotice = `Attach failed: ${error instanceof Error ? error.message : String(error)}`;
            this.scheduleHomeRefresh();
          },
        );
        this.#homeNotice = `Enabling Slackoff in tmux session \`${selected.name}\`.`;
        await ack();
        await this.publishHome();
      } catch (error) {
        await ack({
          response_action: "errors",
          errors: {
            [HOME_ATTACH_BLOCK]: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });

    this.#app.view(HOME_LAUNCH_VIEW, async ({ ack, body, view }) => {
      const parsedBody = HomeLaunchBodySchema.safeParse(body);
      if (!parsedBody.success || parsedBody.data.user.id !== this.#config.userId) {
        await ack();
        return;
      }
      const parsedState = HomeLaunchStateSchema.safeParse(view.state.values);
      if (!parsedState.success) {
        await ack({
          response_action: "errors",
          errors: { [HOME_NAME_BLOCK]: "The launch form is incomplete. Reopen it and try again." },
        });
        return;
      }

      const name = parsedState.data[HOME_NAME_BLOCK][HOME_NAME_INPUT].value;
      const cwd = parsedState.data[HOME_CWD_BLOCK][HOME_CWD_INPUT].value;
      const prompt = parsedState.data[HOME_PROMPT_BLOCK][HOME_PROMPT_INPUT].value ?? undefined;
      const attachment = this.#tmuxAttachments.begin(name.trim());
      try {
        const launched = await this.#launcher.launch({ name, cwd, ...(prompt ? { prompt } : {}) });
        this.#homeNotice = `Starting tmux session \`${launched.name}\` in \`${launched.cwd}\`…`;
        await ack();
        await this.publishHome();
        void attachment.promise.then(
          () => {
            this.#homeNotice = `Started tmux session \`${launched.name}\` in \`${launched.cwd}\` and connected it to Slackoff.`;
            this.scheduleHomeRefresh();
          },
          (error: unknown) => {
            this.#homeNotice = `Launch failed: ${error instanceof Error ? error.message : String(error)}`;
            this.scheduleHomeRefresh();
          },
        );
      } catch (error) {
        attachment.cancel();
        const message = error instanceof Error ? error.message : String(error);
        const block = message.startsWith("Working directory") ? HOME_CWD_BLOCK : HOME_NAME_BLOCK;
        await ack({ response_action: "errors", errors: { [block]: message } });
      }
    });

    this.#app.event("message", async ({ event, body }) => {
      const eventId = "event_id" in body && typeof body.event_id === "string" ? body.event_id : undefined;
      if (eventId && this.#isDuplicateEvent(eventId)) return;
      const parsed = DmMessageSchema.safeParse(event);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.bot_id || (message.subtype && message.subtype !== "file_share")) return;
      if (message.user !== this.#config.userId) {
        console.warn(`Slackoff ignored a DM from unauthorized user ${message.user}`);
        return;
      }

      const launchText = message.text.trim();
      if (!message.thread_ts && launchText.startsWith(SESSION_LAUNCH_REQUEST_PREFIX)) {
        let resultText: string;
        try {
          const launchRequest = parseSessionLaunchRequest(launchText);
          if (!launchRequest) throw new Error("Invalid Slackoff launch request");
          const attachment = this.#tmuxAttachments.begin(launchRequest.name);
          try {
            const launched = await this.#launcher.launch(launchRequest);
            await attachment.promise;
            resultText = `${SESSION_LAUNCH_SUCCESS_PREFIX}${launched.name}`;
          } catch (error) {
            attachment.cancel();
            throw error;
          }
        } catch (error) {
          resultText = `${SESSION_LAUNCH_FAILURE_PREFIX}${error instanceof Error ? error.message : String(error)}`;
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await this.#app.client.chat.postMessage({
              channel: message.channel,
              thread_ts: message.ts,
              text: resultText,
            });
            break;
          } catch {
            if (attempt === 2) console.error("Slackoff could not post a session launch result");
          }
        }
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
      const { images, rejected } = await downloadSlackImages(message.files, this.#config.botToken);
      if (rejected.length > 0) {
        await this.#app.client.chat.postMessage({
          channel: record.binding.channelId,
          thread_ts: record.binding.threadTs,
          text: `Skipped attachment${rejected.length === 1 ? "" : "s"}: ${rejected
            .map(({ name, reason }) => `${escapeMrkdwn(name)} (${escapeMrkdwn(reason)})`)
            .join(", ")}`,
        });
      }
      const text = message.text.trim();
      if (!text && images.length === 0) return;
      const command = images.length === 0 ? parseThreadCommand(text) : undefined;
      if (command) {
        switch (command.kind) {
          case "stop":
            await this.stopTurn(record);
            return;
          case "close":
            if (command.closeTmux) {
              try {
                await this.#killOmpTmuxSession(record);
              } catch (error) {
                await this.#app.client.chat.postMessage({
                  channel: record.binding.channelId,
                  thread_ts: record.binding.threadTs,
                  text: `Could not close tmux session: ${error instanceof Error ? error.message : String(error)}`,
                });
                return;
              }
              await this.closeSession(record, false);
              return;
            }
            await this.closeSession(record);
            return;
          case "model": {
            if (!record.socket || record.collapsed) return;
            if (
              !record.session.modelState.available.some(
                (model) => `${model.provider}/${model.id}` === command.selector,
              )
            ) {
              await this.#app.client.chat.postMessage({
                channel: record.binding.channelId,
                thread_ts: record.binding.threadTs,
                text: `Unknown model selector: ${command.selector}`,
              });
              return;
            }
            record.socket.write(
              encodeMessage({
                type: "set_model",
                sessionId: record.session.id,
                commandId: randomUUID(),
                selector: command.selector,
              }),
            );
            return;
          }
          case "effort": {
            if (!record.socket || record.collapsed) return;
            const available = record.session.modelState.effort?.available ?? [];
            if (!available.includes(command.effort)) {
              await this.#app.client.chat.postMessage({
                channel: record.binding.channelId,
                thread_ts: record.binding.threadTs,
                text: `Could not change model: effort "${command.effort}" is not available`,
              });
              return;
            }
            record.socket.write(
              encodeMessage({
                type: "set_effort",
                sessionId: record.session.id,
                commandId: randomUUID(),
                effort: command.effort,
              }),
            );
            return;
          }
          case "omp":
            await this.routeSlashCommand(record, command.command);
            return;
        }
      }
      if (images.length === 0 && text && (await this.#routeQuestionAnswer(record, text))) return;
      await this.routeInstruction(record, text, images);
    });

    this.#app.action(MODEL_ACTION, async ({ ack, body, action }) => {
      await ack();
      const parsedBody = ActionBodySchema.safeParse(body);
      const parsedAction = ModelActionSchema.safeParse(action);
      if (!parsedBody.success || !parsedAction.success || parsedBody.data.user.id !== this.#config.userId) return;
      const record = this.#registry.getByBindingId(parsedAction.data.block_id);
      if (!record?.socket || record.collapsed) return;
      if (
        !record.session.modelState.available.some(
          (model) => `${model.provider}/${model.id}` === parsedAction.data.selected_option.value,
        )
      ) {
        await this.refreshRoot(record);
        return;
      }
      record.socket.write(
        encodeMessage({
          type: "set_model",
          sessionId: record.session.id,
          commandId: randomUUID(),
          selector: parsedAction.data.selected_option.value,
        }),
      );
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
      const parsedBody = HomeActionBodySchema.safeParse(body);
      const parsedAction = ActionValueSchema.safeParse(action);
      if (!parsedBody.success || !parsedAction.success || parsedBody.data.user.id !== this.#config.userId) return;
      const record = this.#registry.getByBindingId(parsedAction.data.value);
      if (!record) return;
      const tmuxSessionName = await this.#resolveOmpTmuxSessionName(record);
      await this.#app.client.views.open({
        trigger_id: parsedBody.data.trigger_id,
        view: buildCloseSessionModal(record.binding.bindingId, tmuxSessionName),
      });
    });

    this.#app.view(CLOSE_SESSION_VIEW, async ({ ack, body, view }) => {
      const parsedBody = HomeLaunchBodySchema.safeParse(body);
      const parsedState = CloseSessionStateSchema.safeParse(view.state.values);
      const binding = ActionValueSchema.safeParse({ value: view.private_metadata });
      if (
        !parsedBody.success ||
        parsedBody.data.user.id !== this.#config.userId ||
        !parsedState.success ||
        !binding.success
      ) {
        await ack();
        return;
      }
      const record = this.#registry.getByBindingId(binding.data.value);
      if (!record) {
        await ack({
          response_action: "errors",
          errors: { [CLOSE_SESSION_BLOCK]: "This Slackoff session is no longer active." },
        });
        return;
      }
      const choice = parsedState.data[CLOSE_SESSION_BLOCK][CLOSE_SESSION_INPUT].selected_option.value;
      if (choice === CLOSE_AND_DELETE_TMUX) {
        try {
          await this.#killOmpTmuxSession(record);
        } catch (error) {
          await ack({
            response_action: "errors",
            errors: {
              [CLOSE_SESSION_BLOCK]: error instanceof Error ? error.message : String(error),
            },
          });
          return;
        }
        await ack();
        await this.closeSession(record, false);
        return;
      }
      await ack();
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
      metadata: buildQuestionMetadata({
        sessionId: record.session.id,
        bindingId: record.binding.bindingId,
        questionId: pending.questionId,
        multi: pending.multi,
        state: "answered",
        options: pending.options.map((label) => ({ label })),
      }),
    });
    record.status = "working";
    record.activity = "Reply received";
    await this.refreshRoot(record);
    return true;
  }

  async routeInstruction(record: ActiveSession, text: string, images: readonly ImageInput[] = []): Promise<void> {
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
    record.activity = images.length > 0 ? "Image instruction queued" : "Instruction queued";
    this.scheduleRootRefresh(record);
    record.socket.write(
      encodeMessage({
        type: "instruction",
        sessionId: record.session.id,
        commandId: randomUUID(),
        text,
        images: [...images],
      }),
    );
  }

  async routeSlashCommand(record: ActiveSession, command: string): Promise<void> {
    if (record.collapsed || record.status === "disabled") return;
    if (!record.socket) {
      await this.#app.client.chat.postMessage({
        channel: record.binding.channelId,
        thread_ts: record.binding.threadTs,
        text: "Session offline; OMP command was not delivered.",
      });
      return;
    }

    record.socket.write(
      encodeMessage({
        type: "execute_slash_command",
        sessionId: record.session.id,
        commandId: randomUUID(),
        command,
      }),
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

  async #availableOmpTmuxSessions() {
    const connected = new Set<string>();
    for (const record of this.#registry.values()) {
      if (!record.socket || record.collapsed) continue;
      connected.add(record.session.tmuxSessionName ?? record.session.project);
    }
    return (await this.#launcher.listOmpSessions()).filter((session) => !connected.has(session.name));
  }

  async #resolveOmpTmuxSessionName(record: ActiveSession): Promise<string | undefined> {
    const expected = record.session.tmuxSessionName ?? record.session.project;
    return (await this.#launcher.listOmpSessions()).find((session) => session.name === expected)?.name;
  }

  async #killOmpTmuxSession(record: ActiveSession): Promise<void> {
    const tmuxSessionName = await this.#resolveOmpTmuxSessionName(record);
    if (!tmuxSessionName) throw new Error("The OMP tmux session is no longer available.");
    await this.#launcher.killOmpSession(tmuxSessionName);
  }

  async closeSession(record: ActiveSession, notifyClient = true): Promise<void> {
    await this.abortBtwRequests(record);
    record.collapsed = true;
    record.status = "disabled";
    record.activity = undefined;
    this.#closedBindings.add(record.binding.bindingId);
    if (notifyClient && record.socket) {
      record.socket.write(
        encodeMessage({ type: "stop", sessionId: record.session.id, commandId: randomUUID() }),
      );
      record.socket.write(
        encodeMessage({ type: "replaced", sessionId: record.session.id, reason: "closed" }),
      );
    }
    await this.refreshRoot(record);
    this.scheduleHomeRefresh();
  }

  async postModelError(record: ActiveSession, error: string): Promise<void> {
    await this.#app.client.chat.postMessage({
      channel: record.binding.channelId,
      thread_ts: record.binding.threadTs,
      text: `Could not change model: ${error}`,
    });
  }

  async postCommandError(record: ActiveSession, error: string): Promise<void> {
    await this.#app.client.chat.postMessage({
      channel: record.binding.channelId,
      thread_ts: record.binding.threadTs,
      text: `Could not execute OMP command: ${error}`,
    });
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
type BtwState = "working" | "completed" | "aborted" | "error";

const BTW_STATE_LABEL: Record<BtwState, string> = {
  working: "Working",
  completed: "Completed",
  aborted: "Aborted",
  error: "Error",
};

export function buildBtwText(request: BtwRequest): string {
  const state = request.outcome ?? "working";
  const detail = request.outcome === "error" ? request.error : request.answer;
  return clipBtwText(`BTW ${BTW_STATE_LABEL[state]}: ${request.question}${detail ? `\n${detail}` : ""}`, 3_000);
}

export function buildBtwBlocks(request: BtwRequest): KnownBlock[] {
  const state = request.outcome ?? "working";
  const detail =
    state === "error"
      ? `*Error:* ${escapeMrkdwn(clipBtwText(request.error ?? "Unknown error", 2_700))}`
      : request.answer
        ? escapeMrkdwn(clipBtwText(request.answer, 2_800))
        : state === "working"
          ? "_Waiting for a response…_"
          : state === "aborted"
            ? "_No response was returned._"
            : "_The response was empty._";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*BTW · ${BTW_STATE_LABEL[state]}*\n${escapeMrkdwn(clipBtwText(request.question, 2_800))}`,
      },
    },
    { type: "section", text: { type: "mrkdwn", text: detail } },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "Side-channel response · Not saved to the OMP transcript" }],
    },
  ];
}

function clipBtwText(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum - 1)}…`;
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
