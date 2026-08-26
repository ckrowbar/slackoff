import { z } from "zod";

export const PROTOCOL_VERSION = 7 as const;

export const SessionStatusSchema = z.enum([
  "idle",
  "working",
  "waiting",
  "stopping",
  "done",
  "error",
  "offline",
  "disabled",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SlackBindingSchema = z.object({
  bindingId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
});
export type SlackBinding = z.infer<typeof SlackBindingSchema>;
export const ModelDescriptorSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;
export const ModelEffortSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ModelEffort = z.infer<typeof ModelEffortSchema>;

export const SessionEffortStateSchema = z.object({
  current: ModelEffortSchema.optional(),
  available: z.array(ModelEffortSchema),
});
export type SessionEffortState = z.infer<typeof SessionEffortStateSchema>;

export const SessionModelStateSchema = z.object({
  current: ModelDescriptorSchema.optional(),
  available: z.array(ModelDescriptorSchema),
  effort: SessionEffortStateSchema.optional(),
});
export type SessionModelState = z.infer<typeof SessionModelStateSchema>;

export const ImageInputSchema = z.object({
  data: z.string().min(1),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
});
export type ImageInput = z.infer<typeof ImageInputSchema>;

export const SessionDescriptorSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  project: z.string(),
  tmuxSessionName: z.string().min(1).optional(),
  modelState: SessionModelStateSchema.default({ available: [] }),
});
export type SessionDescriptor = z.infer<typeof SessionDescriptorSchema>;

const RegisterRequestSchema = z.object({
  type: z.literal("register"),
  requestId: z.string().min(1),
  protocolVersion: z.number().int().min(1).max(PROTOCOL_VERSION),
  session: SessionDescriptorSchema,
  binding: SlackBindingSchema.optional(),
  status: SessionStatusSchema.default("idle"),
  activity: z.string().optional(),
});

const UnregisterMessageSchema = z.object({
  type: z.literal("unregister"),
  sessionId: z.string().min(1),
  reason: z.enum(["offline", "disabled", "switch"]),
});

const StatusMessageSchema = z.object({
  type: z.literal("status"),
  sessionId: z.string().min(1),
  status: SessionStatusSchema,
  activity: z.string().optional(),
});
const SessionTitleMessageSchema = z.object({
  type: z.literal("session_title"),
  sessionId: z.string().min(1),
  title: z.string().min(1),
});
const ModelStateMessageSchema = z.object({
  type: z.literal("model_state"),
  sessionId: z.string().min(1),
  modelState: SessionModelStateSchema,
  commandId: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});


const TranscriptMessageSchema = z.object({
  type: z.literal("transcript"),
  sessionId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1),
  messageId: z.string().optional(),
});
const BtwStartMessageSchema = z.object({
  type: z.literal("btw_start"),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  question: z.string().min(1),
});

const BtwUpdateMessageSchema = z.object({
  type: z.literal("btw_update"),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  delta: z.string(),
});

const BtwEndMessageSchema = z
  .object({
    type: z.literal("btw_end"),
    sessionId: z.string().min(1),
    requestId: z.string().min(1),
    question: z.string().min(1),
    outcome: z.enum(["completed", "aborted", "error"]),
    answer: z.string().optional(),
    error: z.string().optional(),
  })
  .superRefine((message, ctx) => {
    const valid =
      (message.outcome === "completed" && message.answer !== undefined && message.error === undefined) ||
      (message.outcome === "error" && message.error !== undefined && message.answer === undefined) ||
      (message.outcome === "aborted" && message.answer === undefined && message.error === undefined);
    if (!valid) ctx.addIssue({ code: "custom", message: `Invalid ${message.outcome} BTW result` });
  });


const CommandAcknowledgementSchema = z.object({
  type: z.literal("command_ack"),
  sessionId: z.string().min(1),
  commandId: z.string().min(1),
  state: z.enum(["delivered", "queued", "stopped", "ignored", "failed"]),
  detail: z.string().optional(),
});

const QuestionOptionSchema = z.object({
  label: z.string().min(1).max(75),
  description: z.string().min(1).max(150).optional(),
});

const QuestionRequestSchema = z.object({
  type: z.literal("question"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  questionId: z.string().min(1),
  prompt: z.string().min(1).max(3_000),
  options: z.array(QuestionOptionSchema).min(2).max(5),
  multi: z.boolean(),
});

const CancelQuestionMessageSchema = z.object({
  type: z.literal("cancel_question"),
  sessionId: z.string().min(1),
  questionId: z.string().min(1),
});

const PingMessageSchema = z.object({
  type: z.literal("ping"),
  requestId: z.string().min(1),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  RegisterRequestSchema,
  UnregisterMessageSchema,
  StatusMessageSchema,
  SessionTitleMessageSchema,
  ModelStateMessageSchema,
  TranscriptMessageSchema,
  BtwStartMessageSchema,
  BtwUpdateMessageSchema,
  BtwEndMessageSchema,
  CommandAcknowledgementSchema,
  QuestionRequestSchema,
  CancelQuestionMessageSchema,
  PingMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type UnregisterMessage = z.infer<typeof UnregisterMessageSchema>;
export type StatusMessage = z.infer<typeof StatusMessageSchema>;
export type SessionTitleMessage = z.infer<typeof SessionTitleMessageSchema>;
export type ModelStateMessage = z.infer<typeof ModelStateMessageSchema>;
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;
export type BtwStartMessage = z.infer<typeof BtwStartMessageSchema>;
export type BtwUpdateMessage = z.infer<typeof BtwUpdateMessageSchema>;
export type BtwEndMessage = z.infer<typeof BtwEndMessageSchema>;
export type CommandAcknowledgement = z.infer<typeof CommandAcknowledgementSchema>;
export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;
export type CancelQuestionMessage = z.infer<typeof CancelQuestionMessageSchema>;

const ResponseMessageSchema = z.object({
  type: z.literal("response"),
  requestId: z.string().min(1),
  ok: z.boolean(),
  binding: SlackBindingSchema.optional(),
  error: z.string().optional(),
});

const InstructionMessageSchema = z
  .object({
    type: z.literal("instruction"),
    sessionId: z.string().min(1),
    commandId: z.string().min(1),
    text: z.string().default(""),
    images: z.array(ImageInputSchema).max(10).default([]),
  })
  .refine((message) => message.text.trim().length > 0 || message.images.length > 0, {
    message: "Instruction must include text or at least one image",
  });

const StopMessageSchema = z.object({
  type: z.literal("stop"),
  sessionId: z.string().min(1),
  commandId: z.string().min(1),
});
const SetModelMessageSchema = z.object({
  type: z.literal("set_model"),
  sessionId: z.string().min(1),
  commandId: z.string().min(1),
  selector: z.string().min(1),
});
const SetEffortMessageSchema = z.object({
  type: z.literal("set_effort"),
  sessionId: z.string().min(1),
  commandId: z.string().min(1),
  effort: ModelEffortSchema,
});
const ExecuteSlashCommandMessageSchema = z.object({
  type: z.literal("execute_slash_command"),
  sessionId: z.string().min(1),
  commandId: z.string().min(1),
  command: z.string().regex(/^\/\S+(?:[ \t]+.*)?$/),
});

const ReplacedMessageSchema = z.object({
  type: z.literal("replaced"),
  sessionId: z.string().min(1),
  reason: z.enum(["lease", "closed"]).optional(),
});

const QuestionAnswerMessageSchema = z.object({
  type: z.literal("question_answer"),
  sessionId: z.string().min(1),
  questionId: z.string().min(1),
  answer: z.string().min(1),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  ResponseMessageSchema,
  InstructionMessageSchema,
  StopMessageSchema,
  SetModelMessageSchema,
  SetEffortMessageSchema,
  ExecuteSlashCommandMessageSchema,
  ReplacedMessageSchema,
  QuestionAnswerMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ResponseMessage = z.infer<typeof ResponseMessageSchema>;
export type InstructionMessage = z.infer<typeof InstructionMessageSchema>;
export type SetEffortMessage = z.infer<typeof SetEffortMessageSchema>;
export type StopMessage = z.infer<typeof StopMessageSchema>;
export type SetModelMessage = z.infer<typeof SetModelMessageSchema>;
export type ExecuteSlashCommandMessage = z.infer<typeof ExecuteSlashCommandMessageSchema>;
export type QuestionAnswerMessage = z.infer<typeof QuestionAnswerMessageSchema>;

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}
