import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const SessionStatusSchema = z.enum(["idle", "working", "waiting", "error", "offline", "disabled"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SlackBindingSchema = z.object({
  bindingId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
});
export type SlackBinding = z.infer<typeof SlackBindingSchema>;

export const SessionDescriptorSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  project: z.string(),
});
export type SessionDescriptor = z.infer<typeof SessionDescriptorSchema>;

const RegisterRequestSchema = z.object({
  type: z.literal("register"),
  requestId: z.string().min(1),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  session: SessionDescriptorSchema,
  binding: SlackBindingSchema.optional(),
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
  occurredAt: z.iso.datetime(),
});

const TranscriptMessageSchema = z.object({
  type: z.literal("transcript"),
  sessionId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1),
  messageId: z.string().optional(),
});

const CommandAcknowledgementSchema = z.object({
  type: z.literal("command_ack"),
  sessionId: z.string().min(1),
  commandId: z.string().min(1),
  state: z.enum(["delivered", "queued", "stopped", "ignored", "failed"]),
  detail: z.string().optional(),
});

const PingMessageSchema = z.object({
  type: z.literal("ping"),
  requestId: z.string().min(1),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  RegisterRequestSchema,
  UnregisterMessageSchema,
  StatusMessageSchema,
  TranscriptMessageSchema,
  CommandAcknowledgementSchema,
  PingMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type UnregisterMessage = z.infer<typeof UnregisterMessageSchema>;
export type StatusMessage = z.infer<typeof StatusMessageSchema>;
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;
export type CommandAcknowledgement = z.infer<typeof CommandAcknowledgementSchema>;

const ResponseMessageSchema = z.object({
  type: z.literal("response"),
  requestId: z.string().min(1),
  ok: z.boolean(),
  binding: SlackBindingSchema.optional(),
  error: z.string().optional(),
});

const InstructionMessageSchema = z.object({
  type: z.literal("instruction"),
  sessionId: z.string().min(1),
  commandId: z.string().min(1),
  text: z.string().min(1),
});

const StopMessageSchema = z.object({
  type: z.literal("stop"),
  sessionId: z.string().min(1),
  commandId: z.string().min(1),
});

const ReplacedMessageSchema = z.object({
  type: z.literal("replaced"),
  sessionId: z.string().min(1),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  ResponseMessageSchema,
  InstructionMessageSchema,
  StopMessageSchema,
  ReplacedMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ResponseMessage = z.infer<typeof ResponseMessageSchema>;
export type InstructionMessage = z.infer<typeof InstructionMessageSchema>;
export type StopMessage = z.infer<typeof StopMessageSchema>;

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}
