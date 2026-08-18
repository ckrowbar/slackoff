import { z } from "zod";

import { flattenSlackLinks, unescapeMrkdwn } from "./slack-text.js";

export const SESSION_LAUNCH_REQUEST_PREFIX = "!slackoff-launch ";
export const SESSION_LAUNCH_SUCCESS_PREFIX = "Slackoff launch succeeded: ";
export const SESSION_LAUNCH_FAILURE_PREFIX = "Slackoff launch failed: ";

const SessionLaunchRequestSchema = z.object({
  name: z.string().min(1),
  cwd: z.string().min(1),
  prompt: z.string().max(3_000).optional(),
});

export type SessionLaunchRequest = z.infer<typeof SessionLaunchRequestSchema>;

export function encodeSessionLaunchRequest(request: SessionLaunchRequest): string {
  return `${SESSION_LAUNCH_REQUEST_PREFIX}${JSON.stringify(request)}`;
}

export function parseSessionLaunchRequest(text: string): SessionLaunchRequest | undefined {
  if (!text.startsWith(SESSION_LAUNCH_REQUEST_PREFIX)) return undefined;
  const payload = unescapeMrkdwn(
    flattenSlackLinks(text.slice(SESSION_LAUNCH_REQUEST_PREFIX.length)),
  );
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error("Invalid Slackoff launch request");
  }
  const parsed = SessionLaunchRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid Slackoff launch request");
  return parsed.data;
}
