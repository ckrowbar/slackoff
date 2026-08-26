import type { ModelEffort, SessionStatus } from "../../src/protocol.js";
import type { BtwMetadataState } from "../../src/metadata.js";
export type { ModelEffort };
import type { SupportedImageMimeType } from "../../src/image-inputs.js";
import type { SessionLaunchRequest } from "../../src/session-launch.js";

/**
 * Contract between the three extension layers.
 *
 *   slack/*   talks to Slack and produces SessionView + ThreadEvent
 *   app/*     implements Controller over that data
 *   ui/*      renders AppState and calls Controller, and knows nothing about Slack
 *
 * The UI depends only on Controller and AppState, so it can be driven from fixtures.
 */

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  questionId: string;
  /** Slack ts of the question message, used to reply in place. */
  ts: string;
  prompt: string;
  options: QuestionOption[];
  multi: boolean;
  askedAt: number;
}

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  /** "provider/id", the selector the daemon expects. */
  selector: string;
}

export interface ImageUpload {
  name: string;
  mimeType: SupportedImageMimeType;
  bytes: ArrayBuffer;
}

export interface SessionView {
  /** OMP session id. Stable across reconnects. */
  sessionId: string;
  /** Slack binding id; also the actions block_id on the root card. */
  bindingId: string;
  channelId: string;
  /** Slack ts of the root card, which is the thread parent. */
  threadTs: string;
  title: string;
  project: string;
  status: SessionStatus;
  /** Short phrase for current work, empty when unknown. */
  activity: string;
  model?: ModelOption;
  effort?: ModelEffort;
  models: ModelOption[];
  efforts: ModelEffort[];
  /** Closed threads render as a single collapsed row and accept no input. */
  collapsed: boolean;
  /** True when the daemon currently has a live IPC connection for this session. */
  connected: boolean;
  /** Epoch ms of the root card, i.e. when the session bound to Slack. */
  startedAt: number;
  /** Epoch ms of the newest thread activity we have seen. */
  updatedAt: number;
  /** Unread thread messages since the user last focused this session. */
  unread: number;
  pendingQuestion?: PendingQuestion;
  /** True when the session can accept input: bound, not collapsed, not offline. */
  controllable: boolean;
}

export type ThreadEventKind =
  | "user"
  | "assistant"
  | "btw"
  | "question"
  | "answered"
  | "cancelled"
  | "notice"
  | "unknown";

export interface ThreadEvent {
  /** Slack message ts, unique within the thread and monotonic. */
  ts: string;
  at: number;
  kind: ThreadEventKind;
  text: string;
  /** Lifecycle state for a BTW side-channel card. */
  btwState?: BtwMetadataState;
  /** Populated for question events. */
  question?: PendingQuestion;
  /** Set when this event is a local optimistic echo not yet confirmed by Slack. */
  pending?: boolean;
  /** Set when a local send failed, so the UI can offer a retry. */
  failed?: string;
}

export interface ThreadState {
  sessionId: string;
  events: ThreadEvent[];
  loading: boolean;
  /** Oldest ts fetched, for paging further back. */
  oldestTs?: string;
  hasMore: boolean;
}

export type ConnectionState =
  | { phase: "connecting" }
  | { phase: "ready"; team: string; lastSyncAt: number }
  | { phase: "error"; message: string; recoverable: boolean };

export type StatusFilter = "all" | "attention" | "active";

export interface AppState {
  connection: ConnectionState;
  sessions: SessionView[];
  selectedSessionId?: string;
  thread?: ThreadState;
  filter: StatusFilter;
  query: string;
  /** Sessions waiting on the user, newest first. Drives the inbox and the badge. */
  attention: SessionView[];
  /** Transient banner, e.g. a rate-limit notice. */
  notice?: string;
  busy: boolean;
}

export interface Controller {
  getState(): AppState;
  subscribe(listener: (state: AppState) => void): () => void;
  /** Start polling. Returns a teardown that stops all timers and aborts in-flight calls. */
  start(): void;
  stop(): void;
  select(sessionId: string | undefined): void;
  setFilter(filter: StatusFilter): void;
  setQuery(query: string): void;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  sendInstruction(sessionId: string, text: string): Promise<void>;
  sendImages(sessionId: string, text: string, images: readonly ImageUpload[]): Promise<void>;
  createSession(request: SessionLaunchRequest): Promise<void>;
  /** `answers` are option labels for a choice question, or one free-text string. */
  answerQuestion(sessionId: string, answers: readonly string[]): Promise<void>;
  stopTurn(sessionId: string): Promise<void>;
  setModel(sessionId: string, selector: string): Promise<void>;
  setEffort(sessionId: string, effort: ModelEffort): Promise<void>;
  closeThread(sessionId: string, closeTmux?: boolean): Promise<void>;
}

export interface AppPreferences {
  theme: Theme;
  setTheme(theme: Theme): Promise<void>;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  setSidebar(width: number, collapsed: boolean): Promise<void>;
}

/** Mounts the UI. Returns a teardown that removes every node and listener it added. */
export type MountApp = (root: HTMLElement, controller: Controller, preferences: AppPreferences) => () => void;

/* ---------- content script <-> background service worker ---------- */

export interface SlackCallRequest {
  type: "slack.call";
  /** Full API origin, e.g. "https://dd.enterprise.slack.com". */
  origin: string;
  method: string;
  token: string;
  params: Record<string, string | number | boolean>;
}

export interface SlackUploadRequest {
  type: "slack.upload";
  url: string;
  contentType: SupportedImageMimeType;
  body: string;
}

export interface NotifyRequest {
  type: "notify";
  sessionId: string;
  title: string;
  body: string;
}

export interface BadgeRequest {
  type: "badge";
  count: number;
}

export interface FocusRequest {
  type: "focus";
  sessionId: string;
}

export type BackgroundRequest =
  | SlackCallRequest
  | SlackUploadRequest
  | NotifyRequest
  | BadgeRequest
  | FocusRequest;

export type BackgroundResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number; retryAfterMs?: number };

export type Theme = "codex" | "slack" | "light";

/** Persisted in chrome.storage.local. */
export interface StoredSettings {
  /** Slack API origin the DM lives on. */
  origin?: string;
  /** Cached Slackoff DM channel id, so discovery runs once. */
  channelId?: string;
  /** Slack user id the DM belongs to. */
  userId?: string;
  enabled: boolean;
  notifications: boolean;
  /** Whether the console replaces the Slackoff DM view. */
  takeover: boolean;
  theme: Theme;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}

export const DEFAULT_SETTINGS: StoredSettings = {
  enabled: true,
  notifications: true,
  takeover: true,
  theme: "codex",
  sidebarWidth: 360,
  sidebarCollapsed: false,
};
