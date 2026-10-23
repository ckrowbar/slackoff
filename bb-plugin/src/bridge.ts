// The Slackoff bridge: BB thread events → Slack messages, and Slack messages,
// buttons and modals → BB thread operations.
//
// Durable state is a Binding per mirrored thread (see store.ts). Everything
// else here (live status, turn progress, echo suppression) is rebuilt from
// BB on restart.
import type { PluginBbSdk, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { isStep, planFromItem, stepLabel, stepState, type ActivityItem } from "./activity.ts";
import {
  ACTION,
  buildAnswerModal,
  buildHomeView,
  buildMirrorModal,
  buildNewThreadModal,
  buildProgressCard,
  buildThreadCard,
  MIRROR_FIELDS,
  NEW_THREAD_FIELDS,
  VIEW,
  type ApprovalDecision,
  type CardStatus,
  type ModelChoice,
  type PlanStep,
  type ProgressStep,
} from "./cards.ts";
import { COMMAND_HELP, parseThreadCommand, type ThreadCommand } from "./commands.ts";
import { markdownToSlackMessages } from "./format/markdown.ts";
import { escapeMrkdwn, slackMessageToMarkdown, toMrkdwnFallback, truncate } from "./format/mrkdwn.ts";
import {
  answerFromReply,
  answersFromModal,
  approvalResolution,
  cardKind,
  describeOutcome,
  interactionCard,
  questionsOf,
  type PendingInteraction,
  type Resolution,
} from "./interactions.ts";
import { isTrustedSlackFileUrl, SlackApiError, type SlackResponse } from "./slack/api.ts";
import type { SocketEnvelope } from "./slack/socket-mode.ts";
import type { ModalView, RichTextInline, SlackMessage } from "./slack/types.ts";
import type { Binding, BindingStore } from "./store.ts";

export type ThreadResponse = PluginThreadEventPayloads["thread.created"]["thread"];
type EventRow = Awaited<ReturnType<PluginBbSdk["threads"]["events"]["list"]>>[number];
type PromptInput = Parameters<PluginBbSdk["threads"]["send"]>[0]["input"][number];
type ReasoningLevel = NonNullable<Parameters<PluginBbSdk["threads"]["update"]>[0]["reasoningLevel"]>;

export interface SlackClient {
  call<T extends SlackResponse = SlackResponse>(method: string, body?: Record<string, unknown>): Promise<T>;
  download(url: string, maxBytes: number): Promise<Uint8Array>;
}

export interface BridgeSettings {
  userId: string;
  defaultProjectId: string | undefined;
  mirrorNewThreads: boolean;
  showActivity: boolean;
  appUrl: string | undefined;
}

export interface BridgeOptions {
  pluginId: string;
  sdk: PluginBbSdk;
  slack: SlackClient;
  store: BindingStore;
  settings: () => Promise<BridgeSettings>;
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  /** Tell open BB windows that mirror state changed. */
  publish?: (threadId: string) => void;
  now?: () => number;
  /** Debounce for status card refreshes. Tests set 0. */
  cardDelayMs?: number;
}

const SYNC_TYPES = [
  "client/turn/requested",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "turn/plan/updated",
  "thread/name/updated",
] as const;
const EVENT_PAGE = 100;
const MAX_PAGES_PER_SYNC = 20;
const MODEL_CACHE_MS = 10 * 60_000;
const PROGRESS_INTERVAL_MS = 3_000;
const MAX_FILES = 10;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const BLOCK_ERRORS = new Set(["invalid_blocks", "invalid_blocks_format", "msg_blocks_too_long", "msg_too_long", "invalid_attachments"]);

interface TurnState {
  turnId: string | undefined;
  startedAt: number;
  /** The progress card for the steps since the last assistant message. */
  segment: { ts: string | undefined; startedAt: number; steps: ProgressStep[]; dirty: boolean; flushedAt: number };
  plan: PlanStep[];
  /** Time of the latest event in the turn; progress durations use event time so catch-up stays accurate. */
  lastAt: number;
  stepItems: Map<string, ActivityItem>;
}

interface LiveState {
  status: CardStatus;
  activity: string | undefined;
}

const SlackFileSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  title: z.string().nullish(),
  mimetype: z.string().default("application/octet-stream"),
  size: z.number().default(0),
  url_private: z.string().optional(),
  url_private_download: z.string().optional(),
});
type SlackFile = z.infer<typeof SlackFileSchema>;

const MessageEventSchema = z.object({
  type: z.literal("message"),
  channel: z.string(),
  channel_type: z.string().optional(),
  user: z.string().optional(),
  text: z.string().default(""),
  ts: z.string(),
  thread_ts: z.string().optional(),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
  blocks: z.array(z.unknown()).optional(),
  files: z.array(SlackFileSchema).default([]),
});
type MessageEvent = z.infer<typeof MessageEventSchema>;

const ActionPayloadSchema = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string() }),
  trigger_id: z.string().optional(),
  channel: z.object({ id: z.string() }).optional(),
  container: z.object({ message_ts: z.string().optional(), thread_ts: z.string().optional() }).optional(),
  actions: z.array(
    z.object({
      action_id: z.string(),
      block_id: z.string().optional(),
      value: z.string().optional(),
      selected_option: z.object({ value: z.string() }).nullish(),
    }),
  ),
});

const ViewPayloadSchema = z.object({
  type: z.literal("view_submission"),
  user: z.object({ id: z.string() }),
  view: z.object({
    callback_id: z.string(),
    private_metadata: z.string().default(""),
    state: z.object({ values: z.record(z.string(), z.record(z.string(), z.any())) }),
  }),
});

export class SlackoffBridge {
  readonly #o: BridgeOptions;
  readonly #chains = new Map<string, Promise<void>>();
  readonly #background = new Set<Promise<void>>();
  readonly #syncQueued = new Set<string>();
  readonly #progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #turns = new Map<string, TurnState>();
  readonly #live = new Map<string, LiveState>();
  readonly #echo = new Map<string, string[]>();
  readonly #cardTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #execOverride = new Map<string, { model?: string; effort?: string }>();
  readonly #models = new Map<string, { at: number; models: ModelCatalogEntry[] }>();
  readonly #projects = new Map<string, { name: string; kind: string }>();
  readonly #permalinks = new Map<string, string>();
  readonly #seenEvents = new Map<string, number>();
  readonly #lastError = new Map<string, string>();
  readonly #pendingPrompts = new Map<string, { text: string; files: SlackFile[] }>();
  #homeTimer: ReturnType<typeof setTimeout> | undefined;
  #homeNotice: string | undefined;
  #disposed = false;

  constructor(options: BridgeOptions) {
    this.#o = options;
  }

  get #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#cardTimers.values()) clearTimeout(timer);
    this.#cardTimers.clear();
    for (const timer of this.#progressTimers.values()) clearTimeout(timer);
    this.#progressTimers.clear();
    clearTimeout(this.#homeTimer);
  }

  /** Wait for queued work on every thread; used by tests and shutdown. */
  async idle(): Promise<void> {
    while (this.#chains.size > 0 || this.#background.size > 0) {
      await Promise.allSettled([...this.#chains.values(), ...this.#background]);
    }
  }

  /** Keep a fire-and-forget task observable to idle(). */
  #track(task: Promise<unknown>): void {
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  // -------------------------------------------------------------------------
  // Mirroring lifecycle

  /**
   * Start (or resume) mirroring a thread. A new mirror starts at the current
   * end of the thread unless `fromStart` is set, and shows the latest reply
   * so the Slack thread has context.
   */
  async enable(threadId: string, options: { fromStart?: boolean; root?: { channelId: string; ts: string } } = {}): Promise<Binding> {
    return this.#serial(threadId, () => this.#enable(threadId, options));
  }

  async #enable(threadId: string, options: { fromStart?: boolean; root?: { channelId: string; ts: string } }): Promise<Binding> {
    const thread = await this.#o.sdk.threads.get({ threadId });
    const existing = await this.#o.store.get(threadId);
    if (existing?.enabled) return existing;
    const lastSeq = options.fromStart ? 0 : await this.#latestSeq(threadId);
    this.#live.set(threadId, liveFromThread(thread));

    if (existing) {
      const binding: Binding = { ...existing, enabled: true, lastSeq, projectId: thread.projectId };
      await this.#o.store.save(binding);
      await this.#refreshCard(binding, thread);
      await this.#post(binding, { text: "Mirroring resumed.", blocks: [contextBlock("▶️ Mirroring resumed. Messages from here on are mirrored.")] });
      await this.#syncInteractions(binding);
      this.#afterChange(threadId);
      return binding;
    }

    const settings = await this.#o.settings();
    const card = buildThreadCard(await this.#cardState(thread, true));
    let binding: Binding;
    if (options.root) {
      // Started from a DM: the user's message is the root, the card is the first reply.
      const posted = await this.#slackPost({ channel: options.root.channelId, thread_ts: options.root.ts, ...card });
      binding = baseBinding(thread, options.root.channelId, options.root.ts, posted.ts, lastSeq);
    } else {
      const posted = await this.#slackPost({ channel: settings.userId, ...card });
      binding = baseBinding(thread, posted.channel, posted.ts, posted.ts, lastSeq);
    }
    await this.#o.store.save(binding);

    if (!options.fromStart) {
      const { output } = await this.#o.sdk.threads.output({ threadId }).catch(() => ({ output: null }));
      if (output?.trim()) await this.#postMarkdown(binding, output, [{ type: "text", text: "Latest reply", style: { bold: true } }]);
    }
    await this.#syncInteractions(binding);
    this.#afterChange(threadId);
    return binding;
  }

  async disable(threadId: string): Promise<void> {
    await this.#serial(threadId, async () => {
      const binding = await this.#o.store.get(threadId);
      if (!binding?.enabled) return;
      const next = { ...binding, enabled: false };
      await this.#o.store.save(next);
      this.#turns.delete(threadId);
      await this.#refreshCard(next);
      this.#afterChange(threadId);
    });
  }

  async status(threadId: string): Promise<{ mirrored: boolean; permalink: string | undefined }> {
    const binding = await this.#o.store.get(threadId);
    if (!binding?.enabled) return { mirrored: false, permalink: undefined };
    return { mirrored: true, permalink: await this.#permalink(binding).catch(() => undefined) };
  }

  async list(): Promise<Binding[]> {
    return (await this.#o.store.list()).filter((binding) => binding.enabled);
  }

  /** Catch up every mirror after a restart or reconnect. */
  async reconcileAll(): Promise<void> {
    for (const binding of await this.list()) {
      void this.#serial(binding.threadId, async () => {
        let thread: ThreadResponse;
        try {
          thread = await this.#o.sdk.threads.get({ threadId: binding.threadId });
        } catch (error) {
          // Only a definite "not found" retires a mirror; anything else is retried on the next reconnect.
          if (isNotFound(error)) await this.#markDeleted(binding);
          else this.#o.log.warn(`could not reconcile ${binding.threadId}: ${errorText(error)}`);
          return;
        }
        if (thread.deletedAt !== null) {
          await this.#markDeleted(binding);
          return;
        }
        this.#live.set(thread.id, liveFromThread(thread));
        await this.#sync(binding.threadId);
        const current = await this.#o.store.get(binding.threadId);
        if (current) {
          await this.#syncInteractions(current);
          await this.#refreshCard(current, thread);
        }
      });
    }
    this.#scheduleHome();
  }

  // -------------------------------------------------------------------------
  // BB events

  onThreadEvents(thread: ThreadResponse): void {
    this.#queueSync(thread.id);
  }

  /** Queue one sync per thread; notifications that arrive while one is queued share it. */
  #queueSync(threadId: string): void {
    if (this.#syncQueued.has(threadId) || this.#disposed) return;
    this.#syncQueued.add(threadId);
    void this.#serial(threadId, async () => {
      this.#syncQueued.delete(threadId);
      await this.#sync(threadId);
    });
  }

  /** Flush a throttled progress card once its interval has passed. */
  #scheduleProgress(threadId: string, delayMs: number): void {
    if (this.#progressTimers.has(threadId) || this.#disposed) return;
    const timer = setTimeout(() => {
      this.#progressTimers.delete(threadId);
      void this.#serial(threadId, async () => {
        const binding = await this.#o.store.get(threadId);
        if (binding?.enabled) await this.#flushProgress(binding);
      });
    }, delayMs);
    timer.unref?.();
    this.#progressTimers.set(threadId, timer);
  }

  onThreadCreated(thread: ThreadResponse): void {
    this.#track((async () => {
      const settings = await this.#o.settings();
      if (!settings.mirrorNewThreads || !settings.userId) return;
      if (thread.visibility !== "visible" || thread.parentThreadId || thread.originKind === "fork") return;
      if (thread.originPluginId === this.#o.pluginId) return;
      await this.enable(thread.id, { fromStart: true });
    })().catch((error) => this.#o.log.warn(`auto-mirror failed for ${thread.id}: ${errorText(error)}`)));
  }

  onThreadStatus(thread: ThreadResponse, event: "active" | "idle" | "failed" | "archived" | "unarchived" | "deleted", error?: string | null): void {
    void this.#serial(thread.id, async () => {
      const binding = await this.#o.store.get(thread.id);
      if (!binding) return;
      if (event === "deleted") {
        await this.#markDeleted(binding);
        return;
      }
      if (!binding.enabled) return;
      if (event === "idle" || event === "failed") await this.#sync(thread.id);
      const live = this.#live.get(thread.id) ?? liveFromThread(thread);
      if (event === "active" && live.status !== "waiting") this.#live.set(thread.id, { status: "working", activity: live.activity ?? "Starting" });
      if (event === "idle" && live.status !== "done" && live.status !== "error") this.#live.set(thread.id, { status: "idle", activity: undefined });
      if (event === "failed") {
        this.#live.set(thread.id, { status: "error", activity: undefined });
        if (error && this.#lastError.get(thread.id) !== error) {
          this.#lastError.set(thread.id, error);
          await this.#post(binding, { text: `Error: ${error}`, blocks: [contextBlock(`🔴 ${escapeMrkdwn(truncate(error, 2_900))}`)] });
        }
      }
      if (event === "archived") this.#live.set(thread.id, { status: "archived", activity: undefined });
      if (event === "unarchived") this.#live.set(thread.id, liveFromThread(thread));
      const current = (await this.#o.store.get(thread.id)) ?? binding;
      await this.#syncInteractions(current);
      this.#scheduleCard(thread.id);
    });
  }

  onInteraction(thread: ThreadResponse, interaction: PendingInteraction): void {
    void this.#serial(thread.id, async () => {
      const binding = await this.#o.store.get(thread.id);
      if (!binding?.enabled || binding.cards[interaction.id]) return;
      await this.#postInteraction(binding, interaction);
      this.#live.set(thread.id, { status: "waiting", activity: cardKind(interaction) === "approval" ? "Needs approval" : "Has a question" });
      this.#scheduleCard(thread.id);
    });
  }

  // -------------------------------------------------------------------------
  // Event sync

  async #sync(threadId: string): Promise<void> {
    let binding = await this.#o.store.get(threadId);
    if (!binding?.enabled) return;
    for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
      const rows = await this.#o.sdk.threads.events.list({
        threadId,
        afterSeq: String(binding.lastSeq),
        limit: String(EVENT_PAGE),
        types: [...SYNC_TYPES],
      });
      for (const row of rows) {
        const posted = await this.#handleEvent(binding, row);
        binding.lastSeq = Math.max(binding.lastSeq, row.seq);
        // Persist after every Slack post so a crash never mirrors a message twice.
        if (posted) await this.#saveProgress(binding);
      }
      if (rows.length > 0) binding = await this.#saveProgress(binding);
      if (rows.length < EVENT_PAGE) break;
      // A long backlog continues in a later sync so other threads get a turn.
      if (page === MAX_PAGES_PER_SYNC - 1) this.#queueSync(threadId);
    }
    await this.#flushProgress(binding);
    await this.#syncInteractions(binding);
  }

  /** Save the mirrored sequence without clobbering cards added meanwhile. */
  async #saveProgress(binding: Binding): Promise<Binding> {
    const latest = await this.#o.store.get(binding.threadId);
    const next = { ...(latest ?? binding), lastSeq: Math.max(binding.lastSeq, latest?.lastSeq ?? 0) };
    await this.#o.store.save(next);
    binding.cards = next.cards;
    return next;
  }

  /** Handle one event row; true when it posted to Slack. */
  async #handleEvent(binding: Binding, row: EventRow): Promise<boolean> {
    const threadId = binding.threadId;
    const data = row.data as Record<string, unknown>;
    const active = this.#turns.get(threadId);
    if (active) active.lastAt = Math.max(active.lastAt, row.createdAt);
    switch (row.type) {
      case "client/turn/requested": {
        return this.#mirrorUserMessage(binding, data);
      }
      case "turn/started": {
        const turnId = row.scope.kind === "turn" ? row.scope.turnId : undefined;
        this.#turns.set(threadId, newTurn(turnId, row.createdAt));
        this.#execOverride.delete(threadId);
        this.#live.set(threadId, { status: "working", activity: "Thinking" });
        this.#scheduleCard(threadId);
        return false;
      }
      case "item/started":
      case "item/completed": {
        const item = data.item as ActivityItem & { text?: string };
        if (!item || item.parentToolCallId) return false;
        const done = row.type === "item/completed";
        if (item.type === "agentMessage") {
          if (done && item.text?.trim()) {
            await this.#closeSegment(binding);
            await this.#postMarkdown(binding, item.text);
            return true;
          }
          if (!done) this.#setActivity(threadId, "Writing");
          return false;
        }
        const plan = planFromItem(item);
        if (plan) {
          const turn = this.#turn(threadId, row.createdAt);
          turn.plan = plan;
          turn.segment.dirty = true;
          return false;
        }
        if (item.type === "reasoning" && !done) this.#setActivity(threadId, "Thinking");
        if (!isStep(item)) return false;
        this.#recordStep(binding, item, done, row.createdAt);
        return false;
      }
      case "turn/plan/updated": {
        const turn = this.#turn(threadId, row.createdAt);
        turn.plan = (data.plan as PlanStep[] | undefined) ?? [];
        turn.segment.dirty = true;
        return false;
      }
      case "turn/completed": {
        const status = data.status as "completed" | "failed" | "interrupted";
        await this.#finishTurn(binding, status, row.createdAt);
        const message = (data.error as { message?: string } | undefined)?.message;
        if (status === "failed" && message) {
          this.#lastError.set(threadId, message);
          await this.#post(binding, { text: `Turn failed: ${message}`, blocks: [contextBlock(`🔴 *Turn failed:* ${escapeMrkdwn(truncate(message, 2_800))}`)] });
        }
        this.#live.set(threadId, {
          status: status === "completed" ? "done" : status === "failed" ? "error" : "idle",
          activity: status === "interrupted" ? "Stopped" : undefined,
        });
        this.#scheduleCard(threadId);
        return true;
      }
      case "thread/name/updated":
        this.#scheduleCard(threadId);
        return false;
      default:
        return false;
    }
  }

  async #mirrorUserMessage(binding: Binding, data: Record<string, unknown>): Promise<boolean> {
    const initiator = data.initiator;
    if (initiator !== "user" && initiator !== "agent") return false;
    const input = Array.isArray(data.input) ? (data.input as PromptInput[]) : [];
    const text = input
      .filter((part): part is Extract<PromptInput, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n\n")
      .trim();
    if (initiator === "user" && this.#consumeEcho(binding.threadId, text)) return false;
    const attachments = input.length - input.filter((part) => part.type === "text").length;
    const label = initiator === "user" ? "You" : "Message from another thread";
    const lead: RichTextInline[] = [{ type: "text", text: `💬 ${label}`, style: { bold: true } }];
    const body = `${text}${attachments > 0 ? `\n\n_📎 ${attachments} attachment${attachments === 1 ? "" : "s"}_` : ""}`.trim();
    if (!body) return false;
    await this.#postMarkdown(binding, body, lead);
    return true;
  }

  #turn(threadId: string, at: number): TurnState {
    let turn = this.#turns.get(threadId);
    if (!turn) {
      turn = newTurn(undefined, at);
      this.#turns.set(threadId, turn);
    }
    return turn;
  }

  #recordStep(binding: Binding, item: ActivityItem, done: boolean, at: number): void {
    const turn = this.#turn(binding.threadId, at);
    turn.stepItems.set(item.id, item);
    const step: ProgressStep = { id: item.id, label: stepLabel(item, done), state: stepState(item, done) };
    const index = turn.segment.steps.findIndex((existing) => existing.id === item.id);
    if (index === -1) turn.segment.steps.push(step);
    else turn.segment.steps[index] = step;
    turn.segment.dirty = true;
    if (!done) this.#setActivity(binding.threadId, stepLabel(item, false));
  }

  #setActivity(threadId: string, activity: string): void {
    const live = this.#live.get(threadId);
    if (live?.status === "waiting") return;
    if (live?.activity === activity && live.status === "working") return;
    this.#live.set(threadId, { status: "working", activity });
    this.#scheduleCard(threadId);
  }

  /** Post or update the current progress card. */
  async #flushProgress(binding: Binding, finished?: "completed" | "failed" | "interrupted", at?: number): Promise<void> {
    const turn = this.#turns.get(binding.threadId);
    if (!turn || (!turn.segment.dirty && !finished)) return;
    // Live updates are throttled to respect Slack's chat.update rate limit; final ones always go out.
    const sinceLast = this.#now - turn.segment.flushedAt;
    if (!finished && turn.segment.ts && sinceLast < PROGRESS_INTERVAL_MS) {
      this.#scheduleProgress(binding.threadId, PROGRESS_INTERVAL_MS - sinceLast);
      return;
    }
    turn.segment.flushedAt = this.#now;
    const settings = await this.#o.settings();
    turn.segment.dirty = false;
    if (!settings.showActivity) return;
    if (turn.segment.steps.length === 0 && turn.plan.length === 0) return;
    const message = buildProgressCard({
      finished,
      startedAt: turn.segment.startedAt,
      now: at ?? turn.lastAt,
      steps: turn.segment.steps,
      plan: turn.plan,
    });
    if (turn.segment.ts) {
      await this.#update(binding, turn.segment.ts, message);
    } else {
      turn.segment.ts = await this.#post(binding, message);
    }
  }

  /** An assistant message closes the current progress card; later steps get a new one below it. */
  async #closeSegment(binding: Binding): Promise<void> {
    const turn = this.#turns.get(binding.threadId);
    if (!turn) return;
    if (turn.segment.steps.length > 0) await this.#flushProgress(binding, "completed");
    turn.segment = { ts: undefined, startedAt: turn.lastAt, steps: [], dirty: false, flushedAt: 0 };
    turn.plan = [];
  }

  async #finishTurn(binding: Binding, status: "completed" | "failed" | "interrupted", at: number): Promise<void> {
    const turn = this.#turns.get(binding.threadId);
    if (!turn) return;
    for (const step of turn.segment.steps) {
      if (step.state === "running") {
        step.state = status === "completed" ? "done" : "failed";
        const item = turn.stepItems.get(step.id);
        if (item) step.label = stepLabel(item, true);
      }
    }
    await this.#flushProgress(binding, status, at);
    this.#turns.delete(binding.threadId);
  }

  // -------------------------------------------------------------------------
  // Interaction cards

  async #postInteraction(binding: Binding, interaction: PendingInteraction): Promise<void> {
    const ts = await this.#post(binding, interactionCard(binding.threadId, interaction));
    if (!ts) return;
    const latest = (await this.#o.store.get(binding.threadId)) ?? binding;
    latest.cards[interaction.id] = { ts, kind: cardKind(interaction) };
    binding.cards = latest.cards;
    await this.#o.store.save({ ...latest, lastSeq: Math.max(latest.lastSeq, binding.lastSeq) });
  }

  /** Post cards for new pending interactions and close cards resolved elsewhere. */
  async #syncInteractions(binding: Binding): Promise<void> {
    if (!binding.enabled) return;
    let pending: PendingInteraction[];
    try {
      pending = (await this.#o.sdk.threads.interactions.list({ threadId: binding.threadId })) as PendingInteraction[];
    } catch (error) {
      this.#o.log.warn(`could not list interactions for ${binding.threadId}: ${errorText(error)}`);
      return;
    }
    const open = pending.filter((interaction) => interaction.status === "pending");
    const openIds = new Set(open.map((interaction) => interaction.id));
    let changed = false;
    for (const [interactionId, card] of Object.entries(binding.cards)) {
      if (openIds.has(interactionId)) continue;
      const interaction = await this.#o.sdk.threads.interactions
        .get({ threadId: binding.threadId, interactionId })
        .catch(() => undefined);
      const outcome = interaction ? describeOutcome(interaction as PendingInteraction) : "Resolved";
      if (interaction) await this.#update(binding, card.ts, interactionCard(binding.threadId, interaction as PendingInteraction, outcome));
      delete binding.cards[interactionId];
      changed = true;
    }
    if (changed) await this.#o.store.save(binding);
    for (const interaction of open) {
      if (!binding.cards[interaction.id]) await this.#postInteraction(binding, interaction);
    }
    const live = this.#live.get(binding.threadId);
    if (open.length > 0 && live?.status !== "waiting") {
      this.#live.set(binding.threadId, { status: "waiting", activity: open.some((item) => cardKind(item) === "approval") ? "Needs approval" : "Has a question" });
      this.#scheduleCard(binding.threadId);
    } else if (open.length === 0 && live?.status === "waiting") {
      this.#live.set(binding.threadId, { status: "working", activity: "Thinking" });
      this.#scheduleCard(binding.threadId);
    }
  }

  async #resolve(threadId: string, interactionId: string, resolution: Resolution, outcome: string): Promise<void> {
    const interaction = (await this.#o.sdk.threads.interactions.resolve({
      threadId,
      interactionId,
      resolution: resolution as Parameters<PluginBbSdk["threads"]["interactions"]["resolve"]>[0]["resolution"],
    })) as PendingInteraction;
    await this.#serial(threadId, async () => {
      const binding = await this.#o.store.get(threadId);
      const card = binding?.cards[interactionId];
      if (!binding || !card) return;
      await this.#update(binding, card.ts, interactionCard(threadId, interaction, `${outcome} in Slack`));
      delete binding.cards[interactionId];
      await this.#o.store.save(binding);
      this.#live.set(threadId, { status: "working", activity: "Thinking" });
      this.#scheduleCard(threadId);
    });
  }

  // -------------------------------------------------------------------------
  // Slack inbound

  /** Socket Mode envelope handler. Returns the acknowledgement payload, if any. */
  handleEnvelope(envelope: SocketEnvelope): unknown {
    if (this.#disposed) return undefined;
    if (envelope.type === "events_api") {
      const body = envelope.payload as { event_id?: string; event?: unknown } | undefined;
      if (body?.event_id && this.#isDuplicate(body.event_id)) return undefined;
      const event = body?.event as { type?: string; user?: string; tab?: string } | undefined;
      if (event?.type === "message") this.#track(this.#onMessage(event).catch((error) => this.#o.log.error(`Slack message failed: ${errorText(error)}`)));
      if (event?.type === "app_home_opened" && event.tab === "home") this.#scheduleHome(0);
      return undefined;
    }
    if (envelope.type === "interactive") {
      const payload = envelope.payload as { type?: string } | undefined;
      if (payload?.type === "block_actions") {
        this.#track(this.#onAction(payload).catch((error) => this.#o.log.error(`Slack action failed: ${errorText(error)}`)));
        return undefined;
      }
      if (payload?.type === "view_submission") return this.#onViewSubmission(payload);
    }
    return undefined;
  }

  async #onMessage(raw: unknown): Promise<void> {
    const parsed = MessageEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.bot_id || (message.subtype && message.subtype !== "file_share" && message.subtype !== "thread_broadcast")) return;
    if (message.channel_type && message.channel_type !== "im") return;
    const settings = await this.#o.settings();
    if (message.user !== settings.userId) {
      this.#o.log.warn(`ignored a Slack message from unauthorised user ${message.user ?? "unknown"}`);
      return;
    }
    const text = slackMessageToMarkdown(message.text, message.blocks);
    if (!message.thread_ts) {
      await this.#startFromDm(message, text, settings);
      return;
    }
    const binding = await this.#o.store.bySlackThread(message.channel, message.thread_ts);
    if (!binding) return;
    if (!binding.enabled) {
      await this.#post(binding, { text: "This thread is not mirrored. Use Resume mirroring on the card first.", blocks: [contextBlock("⚫ This thread is not mirrored. Use *Resume mirroring* on the card first.")] });
      return;
    }

    const command = message.files.length === 0 ? parseThreadCommand(text) : undefined;
    if (command) {
      await this.#runCommand(binding, command);
      return;
    }
    if (message.files.length === 0 && (await this.#answerFromReply(binding, text))) return;
    await this.#deliver(binding, message, text);
  }

  async #deliver(binding: Binding, message: MessageEvent, text: string): Promise<void> {
    const attachments = await this.#uploadFiles(binding, binding.projectId, message.files);
    if (!text && attachments.length === 0) return;
    const input: PromptInput[] = [];
    if (text) input.push({ type: "text", text, mentions: [] });
    input.push(...attachments);
    this.#rememberEcho(binding.threadId, text);
    try {
      const result = await this.#o.sdk.threads.send({ threadId: binding.threadId, mode: "auto", input });
      await this.#react(message.channel, message.ts, result.delivery === "queued" ? "hourglass_flowing_sand" : "eyes");
    } catch (error) {
      this.#consumeEcho(binding.threadId, text);
      await this.#post(binding, { text: `Could not send: ${errorText(error)}`, blocks: [contextBlock(`🔴 Could not send your message: ${escapeMrkdwn(errorText(error))}`)] });
    }
  }

  async #startFromDm(message: MessageEvent, text: string, settings: BridgeSettings): Promise<void> {
    if (!text && message.files.length === 0) return;
    const projects = await this.#listProjects();
    const projectId =
      settings.defaultProjectId && projects.some((project) => project.id === settings.defaultProjectId)
        ? settings.defaultProjectId
        : projects.length === 1
          ? projects[0]?.id
          : undefined;
    if (projectId) {
      await this.#spawn(projectId, text, message.files, { channelId: message.channel, ts: message.ts });
      return;
    }
    this.#pendingPrompts.set(message.ts, { text, files: message.files });
    await this.#slackPost({
      channel: message.channel,
      thread_ts: message.ts,
      text: "Choose a project to start a BB thread.",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Choose a project to start a BB thread with this message. Set a default project in the plugin settings to skip this step." } },
        { type: "actions", elements: [{ type: "button", action_id: ACTION.homeNew, text: { type: "plain_text", text: "Choose project" }, value: `${message.channel}|${message.ts}`, style: "primary" }] },
      ],
    });
  }

  async #spawn(projectId: string, text: string, files: readonly SlackFile[], root?: { channelId: string; ts: string }): Promise<Binding> {
    const placeholder: Binding = { threadId: "", projectId, channelId: root?.channelId ?? "", rootTs: root?.ts ?? "", cardTs: root?.ts ?? "", enabled: true, lastSeq: 0, createdAt: this.#now, cards: {} };
    const attachments = root ? await this.#uploadFiles(placeholder, projectId, files) : [];
    const input: PromptInput[] = [];
    if (text) input.push({ type: "text", text, mentions: [] });
    input.push(...attachments);
    const thread = await this.#o.sdk.threads.spawn({ projectId, environment: { type: "project-default" }, input });
    // A prompt typed in Slack is already visible there; one from a modal is not.
    if (root) this.#rememberEcho(thread.id, text);
    const binding = await this.enable(thread.id, { fromStart: true, ...(root ? { root } : {}) });
    if (root) await this.#react(root.channelId, root.ts, "eyes");
    this.#queueSync(thread.id);
    return binding;
  }

  async #runCommand(binding: Binding, command: ThreadCommand): Promise<void> {
    const threadId = binding.threadId;
    switch (command.kind) {
      case "stop":
        await this.#o.sdk.threads.stop({ threadId });
        this.#live.set(threadId, { status: "stopping", activity: undefined });
        this.#scheduleCard(threadId);
        return;
      case "close":
        await this.disable(threadId);
        return;
      case "compact":
        await this.#o.sdk.threads.compact({ threadId });
        await this.#post(binding, { text: "Compacting the conversation.", blocks: [contextBlock("🗜️ Compacting the conversation.")] });
        return;
      case "help":
        await this.#post(binding, { text: "Slackoff commands", blocks: [{ type: "section", text: { type: "mrkdwn", text: COMMAND_HELP } }] });
        return;
      case "status":
        await this.#serial(threadId, async () => {
          await this.#sync(threadId);
          await this.#refreshCard((await this.#o.store.get(threadId)) ?? binding);
        });
        return;
      case "model":
      case "effort": {
        const result = await this.#setExecution(threadId, command.kind === "model" ? { model: command.model } : { effort: command.level });
        if (result) await this.#post(binding, { text: result, blocks: [contextBlock(escapeMrkdwn(result))] });
        return;
      }
    }
  }

  async #answerFromReply(binding: Binding, text: string): Promise<boolean> {
    const questionCards = Object.entries(binding.cards).filter(([, card]) => card.kind === "question");
    if (questionCards.length === 0 || !text) return false;
    const [interactionId] = questionCards[0]!;
    const interaction = (await this.#o.sdk.threads.interactions.get({ threadId: binding.threadId, interactionId }).catch(() => undefined)) as
      | PendingInteraction
      | undefined;
    if (!interaction || interaction.status !== "pending") return false;
    const answer = answerFromReply(interaction, text);
    if (!answer.ok) {
      await this.#post(binding, { text: answer.message, blocks: [contextBlock(answer.message)] });
      return true;
    }
    await this.#resolve(binding.threadId, interactionId, { kind: "user_answer", answers: answer.answers }, `Answered: ${answer.summary}`);
    return true;
  }

  async #onAction(raw: unknown): Promise<void> {
    const parsed = ActionPayloadSchema.safeParse(raw);
    if (!parsed.success) return;
    const payload = parsed.data;
    const settings = await this.#o.settings();
    if (payload.user.id !== settings.userId) return;
    const action = payload.actions[0];
    if (!action) return;
    const value = action.value ?? "";
    const controlThread = action.block_id?.startsWith("ctl:") ? action.block_id.slice(4) : value;

    // Buttons that share a block carry a unique suffix: "slackoff_approve:deny".
    const actionId = action.action_id.split(":")[0];
    switch (actionId) {
      case ACTION.stop:
        await this.#o.sdk.threads.stop({ threadId: value });
        this.#live.set(value, { status: "stopping", activity: undefined });
        this.#scheduleCard(value);
        return;
      case ACTION.open: {
        const result = await this.#o.sdk.threads.open({ threadId: value, file: null });
        if (result.delivered === 0 && payload.channel) {
          await this.#o.slack.call("chat.postEphemeral", {
            channel: payload.channel.id,
            user: payload.user.id,
            ...(payload.container?.thread_ts ? { thread_ts: payload.container.thread_ts } : {}),
            text: "No BB window is open to show this thread.",
          });
        }
        return;
      }
      case ACTION.close:
        await this.disable(value);
        return;
      case ACTION.resume:
        await this.enable(value);
        return;
      case ACTION.model:
      case ACTION.effort: {
        const selected = action.selected_option?.value;
        if (!selected || !controlThread) return;
        await this.#setExecution(controlThread, actionId === ACTION.model ? { model: selected } : { effort: selected });
        return;
      }
      case ACTION.approve: {
        const [threadId = "", interactionId = "", decision = ""] = value.split("|");
        const interaction = (await this.#o.sdk.threads.interactions.get({ threadId, interactionId })) as PendingInteraction;
        if (interaction.status !== "pending") {
          await this.#serial(threadId, async () => {
            const binding = await this.#o.store.get(threadId);
            if (binding) await this.#syncInteractions(binding);
          });
          return;
        }
        const label = decision === "deny" ? "✗ Denied" : decision === "allow_for_session" ? "✓ Allowed for this session" : "✓ Allowed once";
        await this.#resolve(threadId, interactionId, approvalResolution(interaction, decision as ApprovalDecision), label);
        return;
      }
      case ACTION.answer: {
        const [threadId = "", interactionId = "", questionIndex = "0", optionIndex = "0"] = value.split("|");
        const interaction = (await this.#o.sdk.threads.interactions.get({ threadId, interactionId })) as PendingInteraction;
        const question = questionsOf(interaction)[Number.parseInt(questionIndex, 10)];
        const choice = question?.options[Number.parseInt(optionIndex, 10)];
        if (!question || !choice || interaction.status !== "pending") return;
        await this.#resolve(threadId, interactionId, { kind: "user_answer", answers: { [question.id]: { selected: [choice.value] } } }, `Answered: ${choice.label}`);
        return;
      }
      case ACTION.answerModal: {
        const [threadId = "", interactionId = ""] = value.split("|");
        const interaction = (await this.#o.sdk.threads.interactions.get({ threadId, interactionId })) as PendingInteraction;
        if (interaction.status !== "pending" || !payload.trigger_id) return;
        await this.#openModal(payload.trigger_id, buildAnswerModal(threadId, interactionId, questionsOf(interaction)));
        return;
      }
      case ACTION.homeNew: {
        if (!payload.trigger_id) return;
        const projects = await this.#listProjects();
        const pending = value.includes("|") ? this.#pendingPrompts.get(value.split("|")[1] ?? "") : undefined;
        const modal = buildNewThreadModal(projects, settings.defaultProjectId, pending?.text ?? "");
        await this.#openModal(payload.trigger_id, { ...modal, ...(value.includes("|") ? { private_metadata: value } : {}) });
        return;
      }
      case ACTION.homeMirror: {
        if (!payload.trigger_id) return;
        await this.#openModal(payload.trigger_id, buildMirrorModal(await this.#mirrorCandidates()));
        return;
      }
    }
  }

  #onViewSubmission(raw: unknown): unknown {
    const parsed = ViewPayloadSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const { view, user } = parsed.data;
    const values = view.state.values;
    const work = async (task: () => Promise<void>) => {
      const settings = await this.#o.settings();
      if (user.id !== settings.userId) return;
      await task();
    };

    if (view.callback_id === VIEW.newThread) {
      const projectId = values[NEW_THREAD_FIELDS.projectBlock]?.[NEW_THREAD_FIELDS.projectInput]?.selected_option?.value as string | undefined;
      const prompt = (values[NEW_THREAD_FIELDS.promptBlock]?.[NEW_THREAD_FIELDS.promptInput]?.value as string | undefined)?.trim() ?? "";
      if (!projectId) return { response_action: "errors", errors: { [NEW_THREAD_FIELDS.projectBlock]: "Choose a project." } };
      if (!prompt) return { response_action: "errors", errors: { [NEW_THREAD_FIELDS.promptBlock]: "Write a prompt." } };
      const [channelId, ts] = view.private_metadata.split("|");
      const root = channelId && ts ? { channelId, ts } : undefined;
      const files = ts ? (this.#pendingPrompts.get(ts)?.files ?? []) : [];
      if (ts) this.#pendingPrompts.delete(ts);
      this.#track(work(async () => {
        await this.#spawn(projectId, prompt, files, root);
        this.#homeNotice = "Started a new BB thread.";
        this.#scheduleHome();
      }).catch((error) => this.#notice(`Could not start the thread: ${errorText(error)}`)));
      return undefined;
    }

    if (view.callback_id === VIEW.mirror) {
      const threadId = values[MIRROR_FIELDS.block]?.[MIRROR_FIELDS.input]?.selected_option?.value as string | undefined;
      if (!threadId) return { response_action: "errors", errors: { [MIRROR_FIELDS.block]: "Choose a thread." } };
      this.#track(work(async () => {
        await this.enable(threadId);
        this.#homeNotice = "Mirroring started. Open the Messages tab to follow it.";
        this.#scheduleHome();
      }).catch((error) => this.#notice(`Could not mirror the thread: ${errorText(error)}`)));
      return undefined;
    }

    if (view.callback_id === VIEW.answer) {
      const [threadId = "", interactionId = ""] = view.private_metadata.split("|");
      return (async () => {
        const settings = await this.#o.settings();
        if (user.id !== settings.userId) return undefined;
        const interaction = (await this.#o.sdk.threads.interactions.get({ threadId, interactionId })) as PendingInteraction;
        if (interaction.status !== "pending") return undefined;
        const result = answersFromModal(questionsOf(interaction), values);
        if (!result.ok) return { response_action: "errors", errors: result.errors };
        this.#track(
          this.#resolve(threadId, interactionId, { kind: "user_answer", answers: result.answers }, "Answered").catch((error) =>
            this.#o.log.error(`answer failed: ${errorText(error)}`),
          ),
        );
        return undefined;
      })();
    }
    return undefined;
  }

  async #setExecution(threadId: string, change: { model?: string; effort?: string }): Promise<string | undefined> {
    const thread = await this.#o.sdk.threads.get({ threadId });
    const catalog = await this.#modelCatalog(thread);
    const options = await this.#o.sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null);
    const override = this.#execOverride.get(threadId) ?? {};
    if (change.model) {
      const model = catalog.find((entry) => entry.model === change.model || entry.id === change.model);
      if (!model) return `Unknown model \`${change.model}\`. Pick one from the card.`;
      await this.#o.sdk.threads.update({ threadId, model: model.model });
      override.model = model.model;
      const effort = override.effort ?? options?.reasoningLevel;
      if (effort && !model.supportedReasoningEfforts.some((level) => level.reasoningEffort === effort)) override.effort = model.defaultReasoningEffort;
    }
    if (change.effort) {
      const modelId = override.model ?? options?.model;
      const model = catalog.find((entry) => entry.model === modelId);
      const levels = model?.supportedReasoningEfforts.map((level) => level.reasoningEffort as string) ?? [];
      if (levels.length > 0 && !levels.includes(change.effort)) return `Effort \`${change.effort}\` is not available for this model.`;
      await this.#o.sdk.threads.update({ threadId, reasoningLevel: change.effort as ReasoningLevel });
      override.effort = change.effort;
    }
    this.#execOverride.set(threadId, override);
    this.#scheduleCard(threadId);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Status card and App Home

  #scheduleCard(threadId: string): void {
    if (this.#disposed) return;
    clearTimeout(this.#cardTimers.get(threadId));
    const timer = setTimeout(() => {
      this.#cardTimers.delete(threadId);
      void this.#serial(threadId, async () => {
        const binding = await this.#o.store.get(threadId);
        if (binding) await this.#refreshCard(binding);
      });
      this.#scheduleHome();
    }, this.#o.cardDelayMs ?? 1_000);
    timer.unref?.();
    this.#cardTimers.set(threadId, timer);
  }

  async #refreshCard(binding: Binding, known?: ThreadResponse): Promise<void> {
    const thread = known ?? (await this.#o.sdk.threads.get({ threadId: binding.threadId }).catch(() => undefined));
    if (!thread) return;
    await this.#update(binding, binding.cardTs, buildThreadCard(await this.#cardState(thread, binding.enabled)));
  }

  async #cardState(thread: ThreadResponse, enabled: boolean) {
    const settings = await this.#o.settings();
    const project = await this.#project(thread.projectId);
    const live = this.#live.get(thread.id) ?? liveFromThread(thread);
    const catalog = await this.#modelCatalog(thread);
    const options = await this.#o.sdk.threads.defaultExecutionOptions({ threadId: thread.id }).catch(() => null);
    const override = this.#execOverride.get(thread.id);
    const modelId = override?.model ?? options?.model;
    const current = catalog.find((entry) => entry.model === modelId);
    const effort = override?.effort ?? options?.reasoningLevel;
    const models: ModelChoice[] = catalog.map((entry) => ({ id: entry.model, name: entry.displayName }));
    return {
      threadId: thread.id,
      title: thread.title ?? thread.titleFallback ?? "",
      projectName: project.name,
      status: thread.archivedAt !== null ? ("archived" as const) : live.status,
      activity: live.activity,
      model: current ? { id: current.model, name: current.displayName } : modelId ? { id: modelId, name: modelId } : undefined,
      effort,
      models,
      efforts: current?.supportedReasoningEfforts.map((level) => level.reasoningEffort) ?? [],
      appLink: settings.appUrl ? threadLink(settings.appUrl, thread, project.kind) : undefined,
      enabled,
    };
  }

  #scheduleHome(delay = 1_500): void {
    if (this.#disposed) return;
    clearTimeout(this.#homeTimer);
    this.#homeTimer = setTimeout(() => {
      this.#homeTimer = undefined;
      void this.#publishHome().catch((error) => this.#o.log.warn(`App Home update failed: ${errorText(error)}`));
    }, delay);
    this.#homeTimer.unref?.();
  }

  async #publishHome(): Promise<void> {
    const settings = await this.#o.settings();
    if (!settings.userId) return;
    const bindings = await this.list();
    const threads = await Promise.all(
      bindings.map(async (binding) => {
        const thread = await this.#o.sdk.threads.get({ threadId: binding.threadId }).catch(() => undefined);
        const live = this.#live.get(binding.threadId) ?? (thread ? liveFromThread(thread) : { status: "idle" as const, activity: undefined });
        return {
          updatedAt: thread?.updatedAt ?? 0,
          title: thread?.title ?? thread?.titleFallback ?? "Untitled thread",
          projectName: thread ? (await this.#project(thread.projectId)).name : "",
          status: thread?.archivedAt ? ("archived" as const) : live.status,
          activity: live.activity,
          permalink: await this.#permalink(binding).catch(() => undefined),
        };
      }),
    );
    threads.sort((a, b) => b.updatedAt - a.updatedAt);
    await this.#o.slack.call("views.publish", {
      user_id: settings.userId,
      view: buildHomeView({ threads, notice: this.#homeNotice, canStartThreads: true }),
    });
  }

  #notice(message: string): void {
    this.#o.log.warn(message);
    this.#homeNotice = message;
    this.#scheduleHome(0);
  }

  // -------------------------------------------------------------------------
  // Slack output helpers

  async #postMarkdown(binding: Binding, markdown: string, lead?: RichTextInline[]): Promise<void> {
    const messages = markdownToSlackMessages(markdown, lead ? { lead } : {});
    for (const message of messages) await this.#post(binding, message);
  }

  /** Post a reply in the binding's Slack thread; returns its ts, or undefined if Slack refused it. */
  async #post(binding: Binding, message: SlackMessage): Promise<string | undefined> {
    try {
      const posted = await this.#slackPost({ channel: binding.channelId, thread_ts: binding.rootTs, ...message });
      return posted.ts;
    } catch (error) {
      if (error instanceof SlackApiError) {
        this.#o.log.warn(`dropped a Slack message for ${binding.threadId}: ${error.message}`);
        return undefined;
      }
      throw error;
    }
  }

  async #update(binding: Binding, ts: string, message: SlackMessage): Promise<void> {
    try {
      await this.#withFallback(message, (candidate) =>
        this.#o.slack.call("chat.update", { channel: binding.channelId, ts, text: candidate.text, blocks: candidate.blocks }),
      );
    } catch (error) {
      if (error instanceof SlackApiError) {
        this.#o.log.warn(`could not update a Slack message for ${binding.threadId}: ${error.message}`);
        return;
      }
      throw error;
    }
  }

  async #slackPost(body: { channel: string; thread_ts?: string } & SlackMessage): Promise<{ channel: string; ts: string }> {
    const result = await this.#withFallback(body, (candidate) =>
      this.#o.slack.call<SlackResponse & { channel?: string; ts?: string }>("chat.postMessage", {
        channel: body.channel,
        ...(body.thread_ts ? { thread_ts: body.thread_ts } : {}),
        text: candidate.text,
        blocks: candidate.blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    );
    if (!result.channel || !result.ts) throw new SlackApiError("chat.postMessage", "missing_ts");
    return { channel: result.channel, ts: result.ts };
  }

  /** Retry with plain mrkdwn sections when Slack rejects the rich blocks. */
  async #withFallback<T>(message: SlackMessage, send: (message: SlackMessage) => Promise<T>): Promise<T> {
    try {
      return await send(message);
    } catch (error) {
      if (!(error instanceof SlackApiError) || !BLOCK_ERRORS.has(error.code)) throw error;
      this.#o.log.warn(`Slack rejected rich blocks (${error.message}); sending plain formatting`);
      return send(toMrkdwnFallback(message));
    }
  }

  async #react(channel: string, ts: string, name: string): Promise<void> {
    await this.#o.slack.call("reactions.add", { channel, timestamp: ts, name }).catch(() => undefined);
  }

  async #openModal(triggerId: string, view: ModalView): Promise<void> {
    await this.#o.slack.call("views.open", { trigger_id: triggerId, view });
  }

  async #permalink(binding: Binding): Promise<string> {
    const cached = this.#permalinks.get(binding.threadId);
    if (cached) return cached;
    const result = await this.#o.slack.call<SlackResponse & { permalink?: string }>("chat.getPermalink", {
      channel: binding.channelId,
      message_ts: binding.rootTs,
    });
    if (!result.permalink) throw new Error("Slack returned no permalink");
    this.#permalinks.set(binding.threadId, result.permalink);
    return result.permalink;
  }

  // -------------------------------------------------------------------------
  // Files

  async #uploadFiles(binding: Binding, projectId: string, files: readonly SlackFile[]): Promise<PromptInput[]> {
    const inputs: PromptInput[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      const name = file.name || file.title || file.id;
      const image = file.mimetype.startsWith("image/");
      const limit = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      const url = file.url_private_download ?? file.url_private;
      if (inputs.length >= MAX_FILES) rejected.push(`${name} (only ${MAX_FILES} files per message)`);
      else if (file.size > limit) rejected.push(`${name} (larger than ${limit / 1024 / 1024} MB)`);
      else if (!url || !isTrustedSlackFileUrl(url)) rejected.push(`${name} (no Slack download URL)`);
      else {
        try {
          const bytes = await this.#o.slack.download(url, limit);
          const uploaded = await this.#o.sdk.projects.attachments.upload({ projectId, clientFile: bytes, filename: name, mimeType: file.mimetype });
          inputs.push(
            uploaded.type === "localImage"
              ? { type: "localImage", path: uploaded.path }
              : {
                  type: "localFile",
                  path: uploaded.path,
                  name: uploaded.name,
                  sizeBytes: uploaded.sizeBytes,
                  ...(uploaded.mimeType ? { mimeType: uploaded.mimeType } : {}),
                },
          );
        } catch (error) {
          rejected.push(`${name} (${errorText(error)})`);
        }
      }
    }
    if (rejected.length > 0 && binding.channelId) {
      const text = `Skipped ${rejected.length === 1 ? "an attachment" : "attachments"}: ${rejected.join(", ")}`;
      await this.#post(binding, { text, blocks: [contextBlock(`⚠️ ${escapeMrkdwn(text)}`)] });
    }
    return inputs;
  }

  // -------------------------------------------------------------------------
  // BB lookups

  async #latestSeq(threadId: string): Promise<number> {
    const rows = await this.#o.sdk.threads.events.list({ threadId, order: "desc", limit: "1" });
    return rows[0]?.seq ?? 0;
  }

  async #project(projectId: string): Promise<{ name: string; kind: string }> {
    const cached = this.#projects.get(projectId);
    if (cached) return cached;
    const project = await this.#o.sdk.projects.get({ projectId }).catch(() => undefined);
    const value = { name: project?.name ?? projectId, kind: project?.kind ?? "standard" };
    this.#projects.set(projectId, value);
    return value;
  }

  async #listProjects(): Promise<{ id: string; name: string }[]> {
    const projects = await this.#o.sdk.projects.list({ includePersonal: true });
    return projects.map((project) => ({ id: project.id, name: project.kind === "personal" ? "Personal" : project.name }));
  }

  async #modelCatalog(thread: ThreadResponse): Promise<ModelCatalogEntry[]> {
    const key = `${thread.providerId}:${thread.environmentId ?? ""}`;
    const cached = this.#models.get(key);
    if (cached && this.#now - cached.at < MODEL_CACHE_MS) return cached.models;
    try {
      const result = await this.#o.sdk.providers.models(
        thread.environmentId ? { providerId: thread.providerId, environmentId: thread.environmentId } : { providerId: thread.providerId },
      );
      const models = result.models as ModelCatalogEntry[];
      this.#models.set(key, { at: this.#now, models });
      return models;
    } catch (error) {
      this.#o.log.warn(`could not load models for ${thread.providerId}: ${errorText(error)}`);
      return cached?.models ?? [];
    }
  }

  async #mirrorCandidates(): Promise<{ id: string; title: string; projectName: string }[]> {
    const mirrored = new Set((await this.list()).map((binding) => binding.threadId));
    const threads = await this.#o.sdk.threads.list({ archived: false, hasParent: false, limit: 100 });
    const candidates = threads.filter((thread) => !mirrored.has(thread.id) && thread.visibility === "visible");
    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    return Promise.all(
      candidates.slice(0, 100).map(async (thread) => ({
        id: thread.id,
        title: thread.title ?? thread.titleFallback ?? "Untitled",
        projectName: (await this.#project(thread.projectId)).name,
      })),
    );
  }

  async #markDeleted(binding: Binding): Promise<void> {
    await this.#update(binding, binding.cardTs, {
      text: "Deleted in BB",
      blocks: [contextBlock(`🗑️ This BB thread was deleted. \`${escapeMrkdwn(binding.threadId)}\``)],
    });
    await this.#o.store.remove(binding);
    this.#turns.delete(binding.threadId);
    this.#live.delete(binding.threadId);
    this.#afterChange(binding.threadId);
  }

  // -------------------------------------------------------------------------
  // Plumbing

  /** Run work for one thread after everything already queued for it. */
  #serial<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.#chains.get(threadId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(task);
    const settled = next.then(
      () => undefined,
      (error: unknown) => this.#o.log.error(`Slackoff work for ${threadId} failed: ${errorText(error)}`),
    );
    this.#chains.set(threadId, settled);
    void settled.then(() => {
      if (this.#chains.get(threadId) === settled) this.#chains.delete(threadId);
    });
    return next;
  }

  #afterChange(threadId: string): void {
    this.#o.publish?.(threadId);
    this.#scheduleHome();
  }

  #rememberEcho(threadId: string, text: string): void {
    const list = this.#echo.get(threadId) ?? [];
    list.push(normalize(text));
    this.#echo.set(threadId, list.slice(-20));
  }

  #consumeEcho(threadId: string, text: string): boolean {
    const list = this.#echo.get(threadId);
    const index = list?.indexOf(normalize(text)) ?? -1;
    if (!list || index === -1) return false;
    list.splice(index, 1);
    return true;
  }

  #isDuplicate(eventId: string): boolean {
    const now = this.#now;
    for (const [id, expiry] of this.#seenEvents) if (expiry <= now) this.#seenEvents.delete(id);
    if (this.#seenEvents.has(eventId)) return true;
    this.#seenEvents.set(eventId, now + 30 * 60_000);
    return false;
  }
}

interface ModelCatalogEntry {
  id: string;
  model: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string }[];
}

function baseBinding(thread: ThreadResponse, channelId: string, rootTs: string, cardTs: string, lastSeq: number): Binding {
  return { threadId: thread.id, projectId: thread.projectId, channelId, rootTs, cardTs, enabled: true, lastSeq, createdAt: Date.now(), cards: {} };
}

function newTurn(turnId: string | undefined, at: number): TurnState {
  return { turnId, startedAt: at, segment: { ts: undefined, startedAt: at, steps: [], dirty: false, flushedAt: 0 }, plan: [], stepItems: new Map(), lastAt: at };
}

export function liveFromThread(thread: ThreadResponse): LiveState {
  if (thread.archivedAt !== null) return { status: "archived", activity: undefined };
  switch (thread.status) {
    case "active":
      return { status: "working", activity: undefined };
    case "starting":
    case "pending":
      return { status: "starting", activity: undefined };
    case "stopping":
      return { status: "stopping", activity: undefined };
    case "error":
      return { status: "error", activity: undefined };
    default:
      return { status: "idle", activity: undefined };
  }
}

export function threadLink(appUrl: string, thread: { id: string; projectId: string }, projectKind: string): string {
  const base = appUrl.replace(/\/+$/u, "");
  return projectKind === "personal" ? `${base}/threads/${thread.id}` : `${base}/projects/${thread.projectId}/threads/${thread.id}`;
}

function contextBlock(text: string) {
  return { type: "context" as const, elements: [{ type: "mrkdwn" as const, text }] };
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function isNotFound(error: unknown): boolean {
  const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status ?? (error as { statusCode?: unknown } | null)?.statusCode;
  return status === 404 || /\b404\b|not[ _-]?found/iu.test(errorText(error));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
