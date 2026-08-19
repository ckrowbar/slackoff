import { z } from "zod";

import { ModelEffortSchema } from "./protocol.js";
import type { ModelDescriptor, ModelEffort, SessionStatus } from "./protocol.js";

/**
 * Structured Slack message metadata attached to every message the daemon posts.
 *
 * Slack renders metadata nowhere and no other client reads it, so this is additive: existing
 * Slack, mobile, and desktop behaviour is unchanged. It exists so a reader (the Chrome
 * extension) recovers exact session state instead of parsing status emoji out of mrkdwn.
 *
 * Slack requires `event_type` to match /^[a-z0-9_]+$/ and restricts `event_payload` to a flat
 * object of primitives, so composite values (model lists, question options) travel as JSON
 * strings and are decoded by the parsers below.
 */
export const METADATA_VERSION = 1 as const;

export const SESSION_METADATA_EVENT = "slackoff_session";
export const TRANSCRIPT_METADATA_EVENT = "slackoff_transcript";
export const QUESTION_METADATA_EVENT = "slackoff_question";
export const BTW_METADATA_EVENT = "slackoff_btw";


/** Lifecycle of a posted question, tracked so a reader knows whether input is still wanted. */
export const QuestionMetadataStateSchema = z.enum(["waiting", "answered", "cancelled", "offline"]);
export type QuestionMetadataState = z.infer<typeof QuestionMetadataStateSchema>;
export const BtwMetadataStateSchema = z.enum(["working", "completed", "aborted", "error"]);
export type BtwMetadataState = z.infer<typeof BtwMetadataStateSchema>;


const JsonArrayString = <T>(schema: z.ZodType<T>) =>
  z.string().transform((raw, ctx): T => {
    try {
      return schema.parse(JSON.parse(raw));
    } catch {
      ctx.addIssue({ code: "custom", message: "Malformed JSON payload field" });
      return z.NEVER;
    }
  });

const ModelDescriptorPayloadSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
});

const QuestionOptionPayloadSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1).optional(),
});

export const SessionMetadataPayloadSchema = z.object({
  v: z.literal(METADATA_VERSION),
  sessionId: z.string().min(1),
  bindingId: z.string().min(1),
  title: z.string(),
  project: z.string(),
  status: z.string().min(1),
  activity: z.string().default(""),
  collapsed: z.boolean(),
  /** Whether the daemon currently has a live IPC connection for this session. */
  connected: z.boolean().optional(),
  /** Current model selector, "provider/id", or "" when unknown. */
  model: z.string().default(""),
  /** Current model effort, when the selected model exposes a controllable effort surface. */
  effort: ModelEffortSchema.optional(),
  /** JSON array of model efforts accepted by the selected model. */
  efforts: JsonArrayString(z.array(ModelEffortSchema)).optional(),
  /** JSON array of ModelDescriptor. */
  models: JsonArrayString(z.array(ModelDescriptorPayloadSchema)),
});
export type SessionMetadataPayload = z.infer<typeof SessionMetadataPayloadSchema>;

export const TranscriptMetadataPayloadSchema = z.object({
  v: z.literal(METADATA_VERSION),
  sessionId: z.string().min(1),
  bindingId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  /** Index of this chunk when one transcript entry was split across messages. */
  chunk: z.number().int().nonnegative().default(0),
  chunks: z.number().int().positive().default(1),
});
export type TranscriptMetadataPayload = z.infer<typeof TranscriptMetadataPayloadSchema>;

export const QuestionMetadataPayloadSchema = z.object({
  v: z.literal(METADATA_VERSION),
  sessionId: z.string().min(1),
  bindingId: z.string().min(1),
  questionId: z.string().min(1),
  multi: z.boolean(),
  state: QuestionMetadataStateSchema,
  /** JSON array of { label, description? }. */
  options: JsonArrayString(z.array(QuestionOptionPayloadSchema)),
});
export type QuestionMetadataPayload = z.infer<typeof QuestionMetadataPayloadSchema>;
export const BtwMetadataPayloadSchema = z.object({
  v: z.literal(METADATA_VERSION),
  sessionId: z.string().min(1),
  bindingId: z.string().min(1),
  requestId: z.string().min(1),
  question: z.string().min(1),
  state: BtwMetadataStateSchema,
});
export type BtwMetadataPayload = z.infer<typeof BtwMetadataPayloadSchema>;


/** Shape accepted by chat.postMessage and chat.update. */
export interface MessageMetadata {
  event_type: string;
  event_payload: Record<string, string | number | boolean>;
}

export interface SessionMetadataInput {
  sessionId: string;
  bindingId: string;
  title: string;
  project: string;
  status: SessionStatus;
  activity?: string | undefined;
  collapsed: boolean;
  connected: boolean;
  model?: ModelDescriptor | undefined;
  models: readonly ModelDescriptor[];
  efforts?: readonly ModelEffort[] | undefined;
  effort?: ModelEffort | undefined;
}

export function buildSessionMetadata(input: SessionMetadataInput): MessageMetadata {
  return {
    event_type: SESSION_METADATA_EVENT,
    event_payload: {
      v: METADATA_VERSION,
      sessionId: input.sessionId,
      bindingId: input.bindingId,
      title: input.title,
      project: input.project,
      status: input.status,
      activity: input.activity ?? "",
      collapsed: input.collapsed,
      connected: input.connected,
      model: input.model ? `${input.model.provider}/${input.model.id}` : "",
      ...(input.effort ? { effort: input.effort } : {}),
      models: JSON.stringify(
        input.models.map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
      ),
      ...(input.efforts !== undefined ? { efforts: JSON.stringify(input.efforts) } : {}),
    },
  };
}

export interface TranscriptMetadataInput {
  sessionId: string;
  bindingId: string;
  role: "user" | "assistant";
  chunk: number;
  chunks: number;
}

export function buildTranscriptMetadata(input: TranscriptMetadataInput): MessageMetadata {
  return {
    event_type: TRANSCRIPT_METADATA_EVENT,
    event_payload: { v: METADATA_VERSION, ...input },
  };
}

export interface QuestionMetadataInput {
  sessionId: string;
  bindingId: string;
  questionId: string;
  multi: boolean;
  state: QuestionMetadataState;
  options: readonly { label: string; description?: string | undefined }[];
}

export function buildQuestionMetadata(input: QuestionMetadataInput): MessageMetadata {
  return {
    event_type: QUESTION_METADATA_EVENT,
    event_payload: {
      v: METADATA_VERSION,
      sessionId: input.sessionId,
      bindingId: input.bindingId,
      questionId: input.questionId,
      multi: input.multi,
      state: input.state,
      options: JSON.stringify(
        input.options.map((option) => ({
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
      ),
    },
  };
}
export interface BtwMetadataInput {
  sessionId: string;
  bindingId: string;
  requestId: string;
  question: string;
  state: BtwMetadataState;
}

export function buildBtwMetadata(input: BtwMetadataInput): MessageMetadata {
  return {
    event_type: BTW_METADATA_EVENT,
    event_payload: { v: METADATA_VERSION, ...input },
  };
}


/** Metadata as it comes back from conversations.history / conversations.replies. */
const RawMetadataSchema = z.object({
  event_type: z.string().optional(),
  event_payload: z.record(z.string(), z.unknown()).optional(),
});

export type ParsedMetadata =
  | { kind: "session"; payload: SessionMetadataPayload }
  | { kind: "transcript"; payload: TranscriptMetadataPayload }
  | { kind: "question"; payload: QuestionMetadataPayload }
  | { kind: "btw"; payload: BtwMetadataPayload };

/**
 * Decode metadata from a Slack message. Returns undefined for foreign, absent, malformed, or
 * future-versioned metadata so a reader can fall back to its block parser instead of throwing.
 */
export function parseMessageMetadata(raw: unknown): ParsedMetadata | undefined {
  const envelope = RawMetadataSchema.safeParse(raw);
  if (!envelope.success || !envelope.data.event_type || !envelope.data.event_payload) return undefined;
  const payload = envelope.data.event_payload;

  switch (envelope.data.event_type) {
    case SESSION_METADATA_EVENT: {
      const parsed = SessionMetadataPayloadSchema.safeParse(payload);
      return parsed.success ? { kind: "session", payload: parsed.data } : undefined;
    }
    case TRANSCRIPT_METADATA_EVENT: {
      const parsed = TranscriptMetadataPayloadSchema.safeParse(payload);
      return parsed.success ? { kind: "transcript", payload: parsed.data } : undefined;
    }
    case QUESTION_METADATA_EVENT: {
      const parsed = QuestionMetadataPayloadSchema.safeParse(payload);
      return parsed.success ? { kind: "question", payload: parsed.data } : undefined;
    }
    case BTW_METADATA_EVENT: {
      const parsed = BtwMetadataPayloadSchema.safeParse(payload);
      return parsed.success ? { kind: "btw", payload: parsed.data } : undefined;
    }
    default:
      return undefined;
  }
}
