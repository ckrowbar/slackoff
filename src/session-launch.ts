import { z } from "zod";

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
  try {
    const parsed = SessionLaunchRequestSchema.safeParse(
      JSON.parse(text.slice(SESSION_LAUNCH_REQUEST_PREFIX.length)),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
