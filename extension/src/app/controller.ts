import { z } from "zod";
import {
  encodeSessionLaunchRequest,
  SESSION_LAUNCH_FAILURE_PREFIX,
  SESSION_LAUNCH_SUCCESS_PREFIX,
} from "../../../src/session-launch.js";
import type { SessionLaunchRequest } from "../../../src/session-launch.js";

import { mergeSessions, needsAttention, parseSessionRoot, reduceThread } from "../slack/sessions.js";
import type {
  AppState,
  ConnectionState,
  Controller,
  ImageUpload,
  ModelEffort,
  PendingQuestion,
  SessionView,
  StatusFilter,
  ThreadEvent,
  ThreadState,
} from "../types.js";

/**
 * Controller over the Slack DM. Every capability it needs is injected, so it runs unchanged in the
 * content script, in the fixture harness, and under node:test: no chrome, no fetch, no wall clock,
 * and no ambient timers.
 */
export interface ControllerDeps {
  call<T>(method: string, params: Record<string, string | number | boolean>): Promise<T>;
  uploadImages(threadTs: string, text: string, images: readonly ImageUpload[]): Promise<void>;
  channelId: string;
  /** Workspace name for the connection banner; blank when the caller has not resolved one. */
  team?: string;
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
  isVisible(): boolean;
  onNotify?(session: SessionView): void;
}

const SESSION_POLL_MS = 5_000;
const THREAD_POLL_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
const HISTORY_LIMIT = 50;
const THREAD_PAGE = 200;
const MAX_THREAD_LIMIT = 1_000;
/** deps has no visibilitychange hook, so a hidden tick re-checks soon and polls the moment it can. */
const HIDDEN_PROBE_MS = 1_000;
const READ_MARK_DELAY_MS = 3_000;

/** Slack failures that no amount of retrying fixes; the user has to re-authenticate. */
const FATAL_CODES: Record<string, true> = {
  invalid_auth: true,
  not_authed: true,
  token_revoked: true,
  account_inactive: true,
  missing_scope: true,
  channel_not_found: true,
};

const ConversationsResponseSchema = z.looseObject({
  messages: z.array(z.unknown()).default([]),
  has_more: z.boolean().optional(),
});

const LaunchPostResponseSchema = z.object({ ts: z.string().min(1) });
const LaunchReplyResponseSchema = z.object({
  messages: z.array(z.object({
    text: z.string().default(""),
    bot_id: z.string().optional(),
  })).default([]),
});
const ReadCursorMessageSchema = z.looseObject({
  ts: z.string().regex(/^\d+\.\d+$/),
  latest_reply: z.string().regex(/^\d+\.\d+$/).optional(),
});
const LAUNCH_RESULT_POLLS = 20;
const LAUNCH_RESULT_POLL_MS = 2_000;

type PollScope = "sessions" | "thread";

class SlackController implements Controller {

  readonly #deps: ControllerDeps;
  readonly #listeners = new Set<(state: AppState) => void>();
  /** Every session we know about. AppState.sessions publishes the filtered view of this. */
  #sessions: SessionView[] = [];
  #thread: ThreadState | undefined;
  /** Optimistic echoes appended after the fetched thread until Slack confirms or the post fails. */
  #local: ThreadEvent[] = [];
  #selected: string | undefined;
  #filter: StatusFilter = "all";
  #query = "";
  #notice: string | undefined;
  #connection: ConnectionState = { phase: "connecting" };
  #state: AppState;
  #running = false;
  /** Bumped by start/stop so results from an abandoned poll are dropped. */
  #generation = 0;
  #sessionTimer: number | undefined;
  #threadTimer: number | undefined;
  #sessionDelay = SESSION_POLL_MS;
  #threadDelay = THREAD_POLL_MS;
  #threadLimit = THREAD_PAGE;
  #inflight = 0;
  #echoSeq = 0;
  /** Sessions already announced, keyed by session and question, so notices never repeat. */
  #notified = new Set<string>();
  #launchWaiters = new Map<number, (reason?: unknown) => void>();
  #readMarkTimer: number | undefined;
  #pendingReadTs: string | undefined;
  #lastReadAttemptTs: string | undefined;
  /**
   * Bindings whose accepted close command has not appeared in Slack's root metadata yet. Session
   * polling must not resurrect these rows while the daemon updates the root asynchronously.
   */
  readonly #closingBindings = new Set<string>();

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
    this.#state = {
      connection: this.#connection,
      sessions: [],
      filter: "all",
      query: "",
      attention: [],
      busy: false,
    };
  }

  getState(): AppState {
    return this.#state;
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#generation += 1;
    this.#sessionDelay = SESSION_POLL_MS;
    this.#threadDelay = THREAD_POLL_MS;
    void this.#pollSessions();
    void this.#pollThread();
  }

  stop(): void {
    this.#running = false;
    this.#generation += 1;
    if (this.#sessionTimer !== undefined) this.#deps.clearTimer(this.#sessionTimer);
    if (this.#threadTimer !== undefined) this.#deps.clearTimer(this.#threadTimer);
    if (this.#readMarkTimer !== undefined) this.#deps.clearTimer(this.#readMarkTimer);
    for (const [timer, reject] of this.#launchWaiters) {
      this.#deps.clearTimer(timer);
      reject(new Error("Session creation cancelled"));
    }
    this.#launchWaiters.clear();
    this.#sessionTimer = undefined;
    this.#threadTimer = undefined;
    this.#readMarkTimer = undefined;
    this.#pendingReadTs = undefined;
  }

  select(sessionId: string | undefined): void {
    if (sessionId === this.#selected) return;
    this.#selected = sessionId;
    this.#local = [];
    this.#threadLimit = THREAD_PAGE;
    this.#threadDelay = THREAD_POLL_MS;
    if (sessionId === undefined) {
      this.#thread = undefined;
    } else {
      this.#thread = { sessionId, events: [], loading: true, hasMore: false };
      this.#sessions = this.#sessions.map((session) =>
        session.sessionId === sessionId ? { ...session, unread: 0 } : session,
      );
    }
    this.#publish();
    if (sessionId !== undefined) void this.#pollThread(true);
  }

  setFilter(filter: StatusFilter): void {
    if (filter === this.#filter) return;
    this.#filter = filter;
    this.#publish();
  }

  setQuery(query: string): void {
    if (query === this.#query) return;
    this.#query = query;
    this.#publish();
  }

  async refresh(): Promise<void> {
    await Promise.all([this.#pollSessions(true), this.#pollThread(true)]);
  }

  async loadMore(): Promise<void> {
    if (!this.#thread?.hasMore || this.#threadLimit >= MAX_THREAD_LIMIT) return;
    this.#threadLimit = Math.min(this.#threadLimit + THREAD_PAGE, MAX_THREAD_LIMIT);
    await this.#pollThread(true);
  }

  async sendInstruction(sessionId: string, text: string): Promise<void> {
    const session = this.#requireControllable(sessionId);
    const body = text.trim();
    if (!body) throw new Error("Cannot send an empty instruction");
    await this.#postEcho(session, body);
  }

  async sendImages(sessionId: string, text: string, images: readonly ImageUpload[]): Promise<void> {
    const session = this.#requireControllable(sessionId);
    if (images.length === 0) throw new Error("Attach at least one image");
    this.#inflight += 1;
    this.#publish();
    try {
      await this.#deps.uploadImages(session.threadTs, text, images);
      this.#notice = undefined;
      await this.#pollThread(true);
    } catch (error) {
      this.#notice = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.#inflight -= 1;
      this.#publish();
    }
  }

  async createSession(request: SessionLaunchRequest): Promise<void> {
    if (!this.#running) throw new Error("Controller is stopped");
    const generation = this.#generation;
    this.#inflight += 1;
    this.#publish();
    try {
      const raw = await this.#deps.call<unknown>("chat.postMessage", {
        channel: this.#deps.channelId,
        text: encodeSessionLaunchRequest(request),
        parse: "none",
        mrkdwn: false,
      });
      if (generation !== this.#generation) throw new Error("Session creation cancelled");
      const posted = LaunchPostResponseSchema.safeParse(raw);
      if (!posted.success) throw new Error("Unexpected launch request response");

      for (let attempt = 0; attempt < LAUNCH_RESULT_POLLS; attempt += 1) {
        await this.#delay(LAUNCH_RESULT_POLL_MS);
        if (generation !== this.#generation) throw new Error("Session creation cancelled");
        const rawReplies = await this.#deps.call<unknown>("conversations.replies", {
          channel: this.#deps.channelId,
          ts: posted.data.ts,
          limit: 20,
        });
        if (generation !== this.#generation) throw new Error("Session creation cancelled");
        const replies = LaunchReplyResponseSchema.safeParse(rawReplies);
        if (!replies.success) throw new Error("Unexpected launch result response");
        const response = replies.data.messages.find((message) =>
          message.bot_id &&
          (
            message.text.startsWith(SESSION_LAUNCH_SUCCESS_PREFIX) ||
            message.text.startsWith(SESSION_LAUNCH_FAILURE_PREFIX)
          )
        );
        if (!response) continue;
        if (response.text.startsWith(SESSION_LAUNCH_FAILURE_PREFIX)) {
          throw new Error(response.text.slice(SESSION_LAUNCH_FAILURE_PREFIX.length));
        }
        this.#notice = undefined;
        await this.#pollSessions(true);
        return;
      }
      throw new Error("Timed out waiting for Slackoff to launch the session");
    } catch (error) {
      this.#notice = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.#inflight -= 1;
      this.#publish();
    }
  }

  async answerQuestion(sessionId: string, answers: readonly string[]): Promise<void> {
    const session = this.#requireControllable(sessionId);
    const question: PendingQuestion | undefined = session.pendingQuestion;
    if (!question) throw new Error(`No question is waiting in "${session.title}"`);
    const chosen = answers.map((answer) => answer.trim()).filter((answer) => answer.length > 0);
    if (chosen.length === 0) throw new Error("Pick at least one answer");
    await this.#postEcho(session, question.multi ? chosen.join(", ") : (chosen[0] ?? ""));
  }

  async stopTurn(sessionId: string): Promise<void> {
    await this.#postCommand(sessionId, "!stop");
  }

  async setModel(sessionId: string, selector: string): Promise<void> {
    const trimmed = selector.trim();
    if (!trimmed.includes("/")) throw new Error(`Model selector must be "provider/id", got "${selector}"`);
    await this.#postCommand(sessionId, `!model ${trimmed}`);
  }

  async setEffort(sessionId: string, effort: ModelEffort): Promise<void> {
    const session = this.#requireControllable(sessionId);
    if (!session.efforts.includes(effort)) {
      throw new Error(`Effort "${effort}" is not available for "${session.title}"`);
    }
    await this.#postCommand(sessionId, `!effort ${effort}`);
  }

  async closeThread(sessionId: string): Promise<void> {
    const session = this.#requireControllable(sessionId);
    await this.#postCommand(sessionId, "!close");
    this.#closingBindings.add(session.bindingId);
    this.#sessions = this.#sessions.filter((candidate) => candidate.sessionId !== sessionId);
    if (this.#selected === sessionId) {
      this.#selected = undefined;
      this.#thread = undefined;
      this.#local = [];
    }
    this.#publish();
  }

  /* ---------- polling ---------- */

  async #pollSessions(force = false): Promise<void> {
    if (!this.#running && !force) return;
    if (!force && !this.#deps.isVisible()) {
      this.#schedule("sessions", HIDDEN_PROBE_MS);
      return;
    }
    const generation = this.#generation;
    try {
      const response = await this.#deps.call<unknown>("conversations.history", {
        channel: this.#deps.channelId,
        limit: HISTORY_LIMIT,
        include_all_metadata: true,
      });
      if (generation !== this.#generation) return;
      const parsed = ConversationsResponseSchema.safeParse(response);
      if (!parsed.success) throw new Error("Unexpected conversations.history response");
      const newestReadTs = latestMessageTimestamp(parsed.data.messages);
      if (newestReadTs && this.#deps.isVisible()) this.#scheduleReadMark(newestReadTs);
      const fresh: SessionView[] = [];
      for (const message of parsed.data.messages) {
        const session = parseSessionRoot(message, this.#deps.channelId);
        if (session) fresh.push(session);
      }
      for (const session of fresh) {
        if (session.collapsed || !session.connected) this.#closingBindings.delete(session.bindingId);
      }
      const merged = mergeSessions(
        this.#sessions,
        fresh.filter((session) => !this.#closingBindings.has(session.bindingId)),
        {
          now: () => this.#deps.now(),
          selectedSessionId: this.#selected,
        },
      );
      this.#sessions = merged.filter((session) => session.connected && !session.collapsed);
      if (this.#selected && !this.#sessions.some((session) => session.sessionId === this.#selected)) {
        this.#selected = undefined;
        this.#thread = undefined;
        this.#local = [];
      }
      this.#sessionDelay = SESSION_POLL_MS;
      this.#connection = { phase: "ready", team: this.#deps.team ?? "", lastSyncAt: this.#deps.now() };
      this.#notice = undefined;
      this.#publish();
      this.#schedule("sessions", SESSION_POLL_MS);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#fail("sessions", error);
    }
  }

  async #pollThread(force = false): Promise<void> {
    if (!this.#running && !force) return;
    const sessionId = this.#selected;
    const session = this.#sessions.find((candidate) => candidate.sessionId === sessionId);
    if (sessionId === undefined || !session) {
      this.#schedule("thread", THREAD_POLL_MS);
      return;
    }
    if (!force && !this.#deps.isVisible()) {
      this.#schedule("thread", HIDDEN_PROBE_MS);
      return;
    }
    const generation = this.#generation;
    try {
      const response = await this.#deps.call<unknown>("conversations.replies", {
        channel: this.#deps.channelId,
        ts: session.threadTs,
        limit: this.#threadLimit,
        include_all_metadata: true,
      });
      if (generation !== this.#generation || this.#selected !== sessionId) return;
      const parsed = ConversationsResponseSchema.safeParse(response);
      if (!parsed.success) throw new Error("Unexpected conversations.replies response");
      const { events, pendingQuestion } = reduceThread(parsed.data.messages, session.threadTs);
      this.#local = this.#local.filter(
        (echo) =>
          echo.failed !== undefined ||
          !events.some((event) => event.kind === "user" && event.text === echo.text),
      );
      const oldest = events[0]?.ts;
      this.#thread = {
        sessionId,
        events,
        loading: false,
        ...(oldest ? { oldestTs: oldest } : {}),
        hasMore: parsed.data.has_more ?? false,
      };
      this.#sessions = this.#sessions.map((candidate) => {
        if (candidate.sessionId !== sessionId) return candidate;
        const updated: SessionView = { ...candidate, unread: 0 };
        // The thread is authoritative here: an answered question must stop demanding attention.
        if (pendingQuestion) updated.pendingQuestion = pendingQuestion;
        else delete updated.pendingQuestion;
        return updated;
      });
      this.#threadDelay = THREAD_POLL_MS;
      this.#publish();
      this.#schedule("thread", THREAD_POLL_MS);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#fail("thread", error);
    }
  }

  #schedule(scope: PollScope, delay: number): void {
    if (!this.#running) return;
    const timer = scope === "sessions" ? this.#sessionTimer : this.#threadTimer;
    if (timer !== undefined) this.#deps.clearTimer(timer);
    const handle = this.#deps.setTimer(() => {
      if (scope === "sessions") {
        this.#sessionTimer = undefined;
        void this.#pollSessions();
      } else {
        this.#threadTimer = undefined;
        void this.#pollThread();
      }
    }, delay);
    if (scope === "sessions") this.#sessionTimer = handle;
    else this.#threadTimer = handle;
  }

  #scheduleReadMark(ts: string): void {
    if (this.#lastReadAttemptTs && compareSlackTimestamps(ts, this.#lastReadAttemptTs) <= 0) return;
    if (this.#pendingReadTs && compareSlackTimestamps(ts, this.#pendingReadTs) <= 0) return;
    this.#pendingReadTs = ts;
    if (this.#readMarkTimer !== undefined) return;

    this.#readMarkTimer = this.#deps.setTimer(() => {
      this.#readMarkTimer = undefined;
      const pending = this.#pendingReadTs;
      this.#pendingReadTs = undefined;
      if (!this.#running || !pending) return;

      const generation = this.#generation;
      this.#lastReadAttemptTs = pending;
      void this.#deps.call("conversations.mark", {
        channel: this.#deps.channelId,
        ts: pending,
      }).catch((error: unknown) => {
        if (generation !== this.#generation) return;
        const message = error instanceof Error ? error.message : String(error);
        this.#notice = `Could not mark Slackoff as read: ${message}`;
        this.#publish();
      });
    }, READ_MARK_DELAY_MS);
  }

  #delay(ms: number): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const handle = this.#deps.setTimer(() => {
      this.#launchWaiters.delete(handle);
      resolve();
    }, ms);
    this.#launchWaiters.set(handle, reject);
    return promise;
  }

  #fail(scope: PollScope, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const detail = error as { retryAfterMs?: unknown };
    const retryAfterMs =
      typeof detail.retryAfterMs === "number" && detail.retryAfterMs > 0 ? detail.retryAfterMs : undefined;
    const fatal = Object.keys(FATAL_CODES).some((code) => message.includes(code));
    this.#connection = { phase: "error", message, recoverable: !fatal };
    this.#notice = retryAfterMs
      ? `Slack rate limit; retrying in ${Math.ceil(retryAfterMs / 1000)}s.`
      : `Could not sync ${scope === "thread" ? "the transcript" : "sessions"}: ${message}`;
    this.#publish();

    const base = scope === "sessions" ? SESSION_POLL_MS : THREAD_POLL_MS;
    const previous = scope === "sessions" ? this.#sessionDelay : this.#threadDelay;
    const delay = fatal
      ? MAX_BACKOFF_MS
      : retryAfterMs !== undefined
        ? Math.max(retryAfterMs, base)
        : Math.min(previous * 2, MAX_BACKOFF_MS);
    if (scope === "sessions") this.#sessionDelay = delay;
    else this.#threadDelay = delay;
    this.#schedule(scope, delay);
  }

  /* ---------- posting ---------- */

  #requireControllable(sessionId: string): SessionView {
    const session = this.#sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    if (!session.controllable) {
      const reason = session.collapsed ? "the thread is closed" : `the session is ${session.status}`;
      throw new Error(`Cannot send to "${session.title}": ${reason}`);
    }
    return session;
  }

  /**
   * Post into the session thread and show the message straight away. A rejection is reported on the
   * event rather than thrown, so a fire-and-forget caller cannot produce an unhandled rejection.
   */
  async #postEcho(session: SessionView, text: string): Promise<void> {
    this.#echoSeq += 1;
    const echo: ThreadEvent = {
      ts: `local-${this.#echoSeq}`,
      at: this.#deps.now(),
      kind: "user",
      text,
      pending: true,
    };
    if (this.#thread?.sessionId === session.sessionId) this.#local = [...this.#local, echo];
    this.#inflight += 1;
    this.#publish();
    try {
      await this.#deps.call("chat.postMessage", {
        channel: this.#deps.channelId,
        thread_ts: session.threadTs,
        text,
      });
      this.#inflight -= 1;
      this.#publish();
      await this.#pollThread(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#local = this.#local.map((candidate) =>
        candidate.ts === echo.ts
          ? { ts: candidate.ts, at: candidate.at, kind: candidate.kind, text: candidate.text, failed: message }
          : candidate,
      );
      this.#notice = message;
      this.#inflight -= 1;
      this.#publish();
    }
  }

  async #postCommand(sessionId: string, text: string): Promise<void> {
    const session = this.#requireControllable(sessionId);
    this.#inflight += 1;
    this.#publish();
    try {
      await this.#deps.call("chat.postMessage", {
        channel: this.#deps.channelId,
        thread_ts: session.threadTs,
        text,
      });
      this.#notice = undefined;
    } catch (error) {
      this.#notice = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.#inflight -= 1;
      this.#publish();
    }
  }

  /* ---------- state ---------- */

  #publish(): void {
    const query = this.#query.trim().toLowerCase();
    const visible = this.#sessions.filter((session) => {
      const finished =
        session.collapsed ||
        session.status === "offline" ||
        session.status === "disabled" ||
        session.status === "done";
      if (this.#filter === "attention" && !needsAttention(session)) return false;
      if (this.#filter === "active" && finished) return false;
      if (!query) return true;
      return (
        session.title.toLowerCase().includes(query) ||
        session.project.toLowerCase().includes(query) ||
        session.activity.toLowerCase().includes(query)
      );
    });
    // Attention spans every session, filtered or not, because it drives the badge.
    const attention = this.#sessions
      .filter((session) => needsAttention(session))
      .sort((left, right) => right.updatedAt - left.updatedAt);

    const announced = new Set<string>();
    for (const session of attention) {
      const key = `${session.sessionId}:${session.pendingQuestion?.questionId ?? "waiting"}`;
      announced.add(key);
      if (!this.#notified.has(key)) this.#deps.onNotify?.(session);
    }
    this.#notified = announced;

    const thread = this.#thread
      ? { ...this.#thread, events: [...this.#thread.events, ...this.#local] }
      : undefined;
    this.#state = {
      connection: this.#connection,
      sessions: visible,
      ...(this.#selected !== undefined ? { selectedSessionId: this.#selected } : {}),
      ...(thread ? { thread } : {}),
      filter: this.#filter,
      query: this.#query,
      attention,
      ...(this.#notice ? { notice: this.#notice } : {}),
      busy: this.#inflight > 0,
    };
    for (const listener of this.#listeners) listener(this.#state);
  }
}

export function createSlackController(deps: ControllerDeps): Controller {
  return new SlackController(deps);
}

function latestMessageTimestamp(messages: readonly unknown[]): string | undefined {
  let latest: string | undefined;
  for (const message of messages) {
    const parsed = ReadCursorMessageSchema.safeParse(message);
    if (!parsed.success) continue;
    const candidate = parsed.data.latest_reply ?? parsed.data.ts;
    if (!latest || compareSlackTimestamps(candidate, latest) > 0) latest = candidate;
  }
  return latest;
}

function compareSlackTimestamps(left: string, right: string): number {
  const [leftSeconds = "", leftFraction = ""] = left.split(".");
  const [rightSeconds = "", rightFraction = ""] = right.split(".");
  if (leftSeconds.length !== rightSeconds.length) return leftSeconds.length - rightSeconds.length;
  const seconds = leftSeconds.localeCompare(rightSeconds);
  if (seconds !== 0) return seconds;
  return leftFraction.padEnd(6, "0").localeCompare(rightFraction.padEnd(6, "0"));
}
