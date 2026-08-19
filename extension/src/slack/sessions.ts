import { z } from "zod";

import { parseMessageMetadata, type QuestionMetadataState } from "../../../src/metadata.js";
import { SessionStatusSchema, type SessionStatus } from "../../../src/protocol.js";
import { flattenSlackLinks, unescapeMrkdwn } from "../../../src/slack-text.js";
import type {
  ModelEffort,
  ModelOption,
  PendingQuestion,
  QuestionOption,
  SessionView,
  ThreadEvent,
  ThreadEventKind,
} from "../types.js";

/**
 * Pure reducers from raw Slack messages to the view model in ../types.js.
 *
 * Message metadata is the primary source. Every message already in the DM predates the metadata
 * change and comes back with `metadata: null`, so the block parser below is the live path rather
 * than a legacy nicety. Slack also normalises the unicode status emoji the daemon posts into
 * shortcodes, so both spellings are accepted.
 */

const STATUS_ORDER: readonly SessionStatus[] = [
  "idle",
  "working",
  "waiting",
  "stopping",
  "done",
  "error",
  "offline",
  "disabled",
];

const STATUS_ICONS: Record<SessionStatus, string> = {
  idle: "⚪",
  working: "🔵",
  waiting: "🟡",
  stopping: "🟠",
  done: "🟢",
  error: "🔴",
  offline: "⚫",
  disabled: "⚫",
};

const STATUS_SHORTCODES: Record<SessionStatus, string> = {
  idle: ":white_circle:",
  working: ":large_blue_circle:",
  waiting: ":large_yellow_circle:",
  stopping: ":large_orange_circle:",
  done: ":large_green_circle:",
  error: ":red_circle:",
  offline: ":black_circle:",
  disabled: ":black_circle:",
};

/** Remainder of each STATUS_LABELS entry in src/daemon/blocks.ts, after the leading emoji. */
const STATUS_WORDS: Record<SessionStatus, string> = {
  idle: "Ready",
  working: "Working",
  waiting: "Waiting for you",
  stopping: "Stopping",
  done: "Done",
  error: "Error",
  offline: "Offline",
  disabled: "Disabled",
};

const QUESTION_HEADING = "*OMP needs your input*";
const USER_BLOCK_PREFIX = "*Local instruction*\n";
const USER_TEXT_PREFIX = "Local instruction: ";

const NOTICE_TEXTS: readonly string[] = [
  "Session offline; answer was not delivered.",
  "Session offline; instruction was not delivered.",
  "Reply inside an OMP session thread, or enable a session from OMP with /slackoff on.",
];

const NOTICE_PREFIXES: readonly string[] = ["Could not change model: ", "Skipped attachment"];

const QUESTION_STATE_LINES: Record<string, "question" | "answered" | "cancelled"> = {
  "Reply in this thread with your choice.": "question",
  "Reply in this thread with one or more choices.": "question",
  "Answered in this thread.": "answered",
  "Question cancelled.": "cancelled",
};

/* ---------- raw Slack shapes ---------- */

const TextObjectSchema = z.looseObject({
  type: z.string().optional(),
  text: z.string().default(""),
});

/** Context elements carry a bare string in some renderings; interactive elements never do. */
const ElementTextSchema = z.union([z.string(), TextObjectSchema]);

const OptionSchema = z.looseObject({
  text: ElementTextSchema.optional(),
  value: z.string().optional(),
});

const BlockElementSchema = z.looseObject({
  type: z.string().optional(),
  action_id: z.string().optional(),
  value: z.string().optional(),
  text: ElementTextSchema.optional(),
  options: z.array(OptionSchema).optional(),
  initial_option: OptionSchema.optional(),
});

const BlockSchema = z.looseObject({
  type: z.string().optional(),
  block_id: z.string().optional(),
  text: ElementTextSchema.optional(),
  fields: z.array(TextObjectSchema).optional(),
  elements: z.array(BlockElementSchema).optional(),
});

const FileSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  mimetype: z.string().optional(),
});

export const RawSlackMessageSchema = z.looseObject({
  ts: z.string().min(1),
  text: z.string().default(""),
  thread_ts: z.string().optional(),
  bot_id: z.string().optional(),
  user: z.string().optional(),
  blocks: z.array(BlockSchema).optional(),
  metadata: z.unknown().optional(),
  latest_reply: z.string().optional(),
  reply_count: z.number().optional(),
  subtype: z.string().optional(),
  files: z.array(FileSchema).optional(),
});
export type RawSlackMessage = z.infer<typeof RawSlackMessageSchema>;

/* ---------- text helpers ---------- */

function readable(text: string): string {
  return unescapeMrkdwn(flattenSlackLinks(text));
}

function textOf(value: string | { text?: string } | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : (value.text ?? "");
}

/** Slack ts is "<seconds>.<microseconds>". */
export function tsToMillis(ts: string): number {
  const value = Number(ts);
  return Number.isFinite(value) ? Math.round(value * 1000) : 0;
}

function compareTs(left: string, right: string): number {
  const difference = Number(left) - Number(right);
  if (Number.isFinite(difference) && difference !== 0) return difference;
  return left < right ? -1 : left > right ? 1 : 0;
}

function fieldValue(text: string, label: string): string | undefined {
  const heading = `*${label}*`;
  if (text === heading) return "";
  return text.startsWith(`${heading}\n`) ? text.slice(heading.length + 1) : undefined;
}

/* ---------- status ---------- */

export interface ParsedStatus {
  status: SessionStatus;
  activity: string;
}

/**
 * Accept the label form (":large_yellow_circle: Waiting for you") and the icon+activity form
 * (":large_blue_circle: Thinking"), in shortcode or unicode spelling. Offline and disabled share
 * the black circle, so only their label text separates them; a bare activity resolves to offline.
 */
export function parseStatusText(raw: string): ParsedStatus {
  const value = raw.trim();
  for (const status of STATUS_ORDER) {
    for (const icon of [STATUS_SHORTCODES[status], STATUS_ICONS[status]]) {
      if (!value.startsWith(icon)) continue;
      const remainder = value.slice(icon.length).trim();
      for (const candidate of STATUS_ORDER) {
        if (STATUS_ICONS[candidate] !== STATUS_ICONS[status]) continue;
        if (remainder === STATUS_WORDS[candidate]) return { status: candidate, activity: "" };
      }
      return { status, activity: remainder };
    }
  }
  return { status: "idle", activity: value };
}

/* ---------- model helpers ---------- */

function modelFromSelector(selector: string, name?: string): ModelOption | undefined {
  const separator = selector.indexOf("/");
  if (separator <= 0 || separator === selector.length - 1) return undefined;
  const provider = selector.slice(0, separator);
  const id = selector.slice(separator + 1);
  return { provider, id, name: name ?? id, selector };
}

/** Option labels are `${name} · ${provider}`, so the provider suffix marks where the name ends. */
function modelFromOption(option: z.infer<typeof OptionSchema>): ModelOption | undefined {
  if (!option.value) return undefined;
  const label = unescapeMrkdwn(textOf(option.text));
  const separator = label.lastIndexOf(" · ");
  const name = separator > 0 ? label.slice(0, separator) : label;
  return modelFromSelector(option.value, name || undefined);
}

/* ---------- session card ---------- */

interface CardBlocks {
  collapsed: boolean;
  title: string;
  project: string;
  status: SessionStatus;
  activity: string;
  shortSessionId: string;
  bindingId: string;
  models: ModelOption[];
  efforts: ModelEffort[];
  model?: ModelOption;
  effort?: ModelEffort;
}

type RawBlock = z.infer<typeof BlockSchema>;

function readCollapsedCard(blocks: readonly RawBlock[]): CardBlocks | undefined {
  if (blocks.length !== 1) return undefined;
  const only = blocks[0];
  if (!only || only.type !== "context") return undefined;
  const text = textOf(only.elements?.[0]?.text);
  const match = /^(?::black_circle:|⚫)\s*\*(.*)\*\s+·\s+Closed\s+·\s+(.*)$/.exec(text);
  if (!match) return undefined;
  return {
    collapsed: true,
    title: unescapeMrkdwn(match[1] ?? ""),
    project: unescapeMrkdwn(match[2] ?? ""),
    status: "disabled",
    activity: "",
    shortSessionId: "",
    bindingId: "",
    models: [],
    efforts: [],
  };
}

function readCardBlocks(blocks: readonly RawBlock[]): CardBlocks | undefined {
  const collapsed = readCollapsedCard(blocks);
  if (collapsed) return collapsed;

  const header = blocks.find((block) => block.type === "header");
  const fields = blocks.find((block) => block.type === "section" && block.fields)?.fields ?? [];
  let statusText: string | undefined;
  let projectText: string | undefined;
  let modelText: string | undefined;
  for (const field of fields) {
    statusText ??= fieldValue(field.text, "Status");
    projectText ??= fieldValue(field.text, "Project");
    modelText ??= fieldValue(field.text, "Model");
  }
  if (!header || statusText === undefined || projectText === undefined) return undefined;

  let shortSessionId = "";
  for (const block of blocks) {
    if (block.type !== "context") continue;
    const match = /^OMP session `(.+)`$/.exec(textOf(block.elements?.[0]?.text));
    if (match?.[1]) shortSessionId = unescapeMrkdwn(match[1]);
  }

  // Only the actions block carries our own id; every other block_id is Slack-generated.
  const actions = blocks.find((block) => block.type === "actions");
  const select = actions?.elements?.find((element) => element.type === "static_select");
  const models: ModelOption[] = [];
  for (const option of select?.options ?? []) {
    const model = modelFromOption(option);
    if (model) models.push(model);
  }
  const initial = select?.initial_option ? modelFromOption(select.initial_option) : undefined;
  const fromField = readModelField(modelText);

  const { status, activity } = parseStatusText(unescapeMrkdwn(statusText));
  return {
    collapsed: false,
    // Card fields are daemon-escaped mrkdwn or plain_text, never Slack link syntax.
    title: unescapeMrkdwn(textOf(header.text)),
    project: unescapeMrkdwn(projectText),
    status,
    activity,
    shortSessionId,
    bindingId: actions?.block_id ?? "",
    models,
    efforts: [],
    ...(initial ?? fromField ? { model: (initial ?? fromField) as ModelOption } : {}),
  };
}

function readModelField(text: string | undefined): ModelOption | undefined {
  if (!text || text === "Unknown") return undefined;
  const lines = text.split("\n");
  const name = unescapeMrkdwn(lines[0] ?? "");
  const selector = unescapeMrkdwn((lines[1] ?? "").replaceAll("`", ""));
  return selector ? modelFromSelector(selector, name || undefined) : undefined;
}

/**
 * Turn a DM message into a session view, or undefined when it is not a Slackoff session card.
 */
export function parseSessionRoot(message: unknown, channelId: string): SessionView | undefined {
  const parsed = RawSlackMessageSchema.safeParse(message);
  if (!parsed.success) return undefined;
  const raw = parsed.data;
  if (raw.thread_ts !== undefined && raw.thread_ts !== raw.ts) return undefined;

  const metadata = parseMessageMetadata(raw.metadata);
  const payload = metadata?.kind === "session" ? metadata.payload : undefined;
  const card = readCardBlocks(raw.blocks ?? []);
  if (!payload && !card) return undefined;

  const collapsed = payload ? payload.collapsed : (card?.collapsed ?? false);
  const metadataStatus = payload ? SessionStatusSchema.safeParse(payload.status) : undefined;
  const status =
    (metadataStatus?.success ? metadataStatus.data : undefined) ??
    card?.status ??
    (collapsed ? "disabled" : "idle");
  const activity = payload ? payload.activity : (card?.activity ?? "");
  const connected = payload?.connected ?? (!collapsed && status !== "offline" && status !== "disabled");

  const models: ModelOption[] = payload
    ? payload.models.map((model) => ({ ...model, selector: `${model.provider}/${model.id}` }))
    : (card?.models ?? []);
  const efforts = payload?.efforts ?? card?.efforts ?? [];
  const selected = payload?.model
    ? (models.find((model) => model.selector === payload.model) ?? modelFromSelector(payload.model))
    : card?.model;

  const bindingId = payload?.bindingId ?? card?.bindingId ?? "";
  const sessionId = payload?.sessionId ?? (card?.shortSessionId || `slack-${raw.ts}`);
  const title = payload ? payload.title : (card?.title ?? "");

  return {
    sessionId,
    bindingId,
    channelId,
    threadTs: raw.ts,
    title,
    project: payload ? payload.project : (card?.project ?? ""),
    status,
    activity,
    ...(selected ? { model: selected } : {}),
    ...(payload?.effort ? { effort: payload.effort } : {}),
    models,
    efforts,
    collapsed,
    connected,
    startedAt: tsToMillis(raw.ts),
    updatedAt: tsToMillis(raw.latest_reply ?? raw.ts),
    unread: 0,
    controllable: bindingId !== "" && !collapsed && status !== "offline" && status !== "disabled",
  };
}

/* ---------- thread messages ---------- */

function parseOptionLines(text: string): QuestionOption[] {
  const options: QuestionOption[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*\d+\.\s+\*(.+?)\*(?:\s+—\s+(.*))?$/.exec(line);
    if (!match?.[1]) continue;
    const description = match[2]?.trim();
    options.push({
      label: readable(match[1]),
      ...(description ? { description: readable(description) } : {}),
    });
  }
  return options;
}

const QUESTION_KIND_BY_STATE: Record<QuestionMetadataState, ThreadEventKind> = {
  waiting: "question",
  answered: "answered",
  cancelled: "cancelled",
  offline: "cancelled",
};

/** Classify one thread reply. Roots are dropped by reduceThread, not here. */
export function parseThreadMessage(message: unknown): ThreadEvent {
  const parsed = RawSlackMessageSchema.safeParse(message);
  if (!parsed.success) return { ts: "0", at: 0, kind: "unknown", text: "" };
  const raw = parsed.data;
  const at = tsToMillis(raw.ts);
  const blocks = raw.blocks ?? [];
  const sections = blocks.filter((block) => block.type === "section");
  const metadata = parseMessageMetadata(raw.metadata);

  // Anything the user typed in Slack arrives without a bot_id, whatever blocks Slack attached.
  if (!raw.bot_id && metadata?.kind !== "question") {
    return { ts: raw.ts, at, kind: "user", text: readable(raw.text).trim() };
  }

  const question = metadata?.kind === "question" ? metadata.payload : undefined;
  const heading = textOf(sections[0]?.text);
  const isQuestionCard = question !== undefined || heading.startsWith(QUESTION_HEADING);
  if (isQuestionCard) {
    const contextLine = textOf(
      blocks.find((block) => block.type === "context")?.elements?.[0]?.text,
    ).trim();
    const kind = question
      ? QUESTION_KIND_BY_STATE[question.state]
      : (QUESTION_STATE_LINES[contextLine] ?? "question");
    const prompt = readable(heading.slice(QUESTION_HEADING.length).trim());
    const options = question
      ? question.options.map((option) => ({
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        }))
      : parseOptionLines(textOf(sections[1]?.text));
    const pending: PendingQuestion = {
      questionId: question?.questionId ?? `question-${raw.ts}`,
      ts: raw.ts,
      prompt,
      options,
      multi: question?.multi ?? contextLine === "Reply in this thread with one or more choices.",
      askedAt: at,
    };
    return { ts: raw.ts, at, kind, text: prompt, question: pending };
  }

  if (metadata?.kind === "transcript") {
    const body = textOf(sections[0]?.text) || raw.text;
    const stripped = body.startsWith(USER_BLOCK_PREFIX) ? body.slice(USER_BLOCK_PREFIX.length) : body;
    return {
      ts: raw.ts,
      at,
      kind: metadata.payload.role === "user" ? "user" : "assistant",
      text: readable(stripped).trim(),
    };
  }

  const sectionText = textOf(sections[0]?.text);
  if (sectionText.startsWith(USER_BLOCK_PREFIX)) {
    return { ts: raw.ts, at, kind: "user", text: readable(sectionText.slice(USER_BLOCK_PREFIX.length)).trim() };
  }
  if (!sectionText && raw.text.startsWith(USER_TEXT_PREFIX)) {
    return { ts: raw.ts, at, kind: "user", text: readable(raw.text.slice(USER_TEXT_PREFIX.length)).trim() };
  }
  const notice = readable(raw.text);
  const isNotice =
    NOTICE_TEXTS.includes(notice) || NOTICE_PREFIXES.some((prefix) => notice.startsWith(prefix));
  if (blocks.length === 0 && isNotice) {
    return { ts: raw.ts, at, kind: "notice", text: notice };
  }
  const text = readable(sectionText || raw.text).trim();
  if (!text) return { ts: raw.ts, at, kind: "unknown", text: "" };
  return { ts: raw.ts, at, kind: "assistant", text };
}

export interface ReducedThread {
  events: ThreadEvent[];
  pendingQuestion?: PendingQuestion;
}

/** Order replies oldest first, drop the root card, and resolve the single live question. */
export function reduceThread(messages: readonly unknown[], expectedRootTs?: string): ReducedThread {
  const parsed = messages
    .map((message) => RawSlackMessageSchema.safeParse(message))
    .filter((result) => result.success)
    .map((result) => result.data);
  const inferredRoot =
    parsed.find((message) => message.thread_ts === message.ts) ??
    parsed.find((message) => message.thread_ts === undefined);
  const rootTs = expectedRootTs ?? inferredRoot?.ts;
  const replies = parsed.filter((message) => message.ts !== rootTs && message.thread_ts !== message.ts);
  replies.sort((left, right) => compareTs(left.ts, right.ts));
  const events = replies.map((reply) => parseThreadMessage(reply));

  let newest: ThreadEvent | undefined;
  for (const event of events) {
    if (event.kind === "question" || event.kind === "answered" || event.kind === "cancelled") newest = event;
  }
  const pendingQuestion = newest?.kind === "question" ? newest.question : undefined;
  return { events, ...(pendingQuestion ? { pendingQuestion } : {}) };
}

/* ---------- session list merge ---------- */

export interface MergeSessionsOptions {
  /** Injected so ordering is deterministic under test; the reducer never reads the wall clock. */
  now(): number;
  selectedSessionId?: string | undefined;
}

/** Shared with the controller so the inbox and the list ordering agree on what "waiting" means. */
export function needsAttention(session: SessionView): boolean {
  return session.pendingQuestion !== undefined || session.status === "waiting";
}

function rank(session: SessionView): number {
  if (needsAttention(session)) return 0;
  return session.status === "working" ? 1 : 2;
}

/**
 * Fold a fresh poll into the previous list, keeping the per-session bookkeeping the poll cannot
 * see: unread counts, the last time we observed a change, and the question the thread poll found.
 */
export function mergeSessions(
  previous: readonly SessionView[],
  next: readonly SessionView[],
  options: MergeSessionsOptions,
): SessionView[] {
  const before = new Map(previous.map((session) => [session.sessionId, session]));
  const merged = next.map((session) => {
    const prior = before.get(session.sessionId);
    const selected = options.selectedSessionId === session.sessionId;
    if (!prior) {
      return selected ? { ...session, unread: 0 } : session;
    }
    const advanced = session.updatedAt > prior.updatedAt;
    const changed =
      advanced ||
      session.status !== prior.status ||
      session.activity !== prior.activity ||
      session.model?.selector !== prior.model?.selector ||
      session.effort !== prior.effort;
    const pendingQuestion = session.pendingQuestion ?? prior.pendingQuestion;
    return {
      ...session,
      ...(pendingQuestion ? { pendingQuestion } : {}),
      updatedAt: advanced ? session.updatedAt : changed ? options.now() : prior.updatedAt,
      unread: selected ? 0 : advanced ? prior.unread + 1 : prior.unread,
    };
  });

  merged.sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) return byRank;
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
    return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
  });
  return merged;
}
