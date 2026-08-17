import { z } from "zod";
import type { SupportedImageMimeType } from "../../src/image-inputs.js";

import type { StoredSettings } from "./types.js";

/**
 * Transport contract. Everything above this line (slack/*, app/*, ui/*) is written once and runs
 * both as an MV3 extension and as a Tampermonkey userscript; each of those supplies a Platform.
 *
 * The wire helpers at the bottom are shared by both implementations on purpose: the rate-limit and
 * error-envelope rules are a Slack contract, not a transport detail, and duplicating them is how
 * the two builds would quietly drift apart.
 */

export type SlackParams = Record<string, string | number | boolean>;

/**
 * What it takes to make a Slack call as the signed-in user. Lives here rather than beside the
 * page-scraping discovery code so that a transport can be typechecked and tested without the DOM.
 */
export interface SlackCredential {
  teamId: string;
  teamName: string;
  token: string;
  userId?: string;
  /** Slack API origin, e.g. "https://acme.slack.com". */
  origin: string;
}

export interface Platform {
  call<T>(credential: SlackCredential, method: string, params: SlackParams): Promise<T>;
  /** Uploads raw bytes to a credential-free, one-time Slack upload URL. */
  upload(url: string, bytes: ArrayBuffer, contentType: SupportedImageMimeType): Promise<void>;
  getSettings(): Promise<StoredSettings>;
  setSettings(patch: Partial<StoredSettings>): Promise<void>;
  /** Returns an unsubscribe. The listener receives the full settings, not a diff. */
  onSettingsChanged(listener: (settings: StoredSettings) => void): () => void;
  notify(sessionId: string, title: string, body: string): void;
  setBadge(count: number): void;
  /** Adds a user-visible command where the host has somewhere to put one. */
  registerCommand(label: string, run: () => void): void;
}

/* ---------- Slack wire rules, shared by every transport ---------- */

/** Error thrown for a Slack `{ ok: false }`; `message` is the raw Slack error code. */
export interface SlackCallError extends Error {
  status?: number;
  /** Present for rate limits so the caller can back off instead of hammering. */
  retryAfterMs?: number;
}

export interface SlackFailure {
  error: string;
  status?: number;
  retryAfterMs?: number;
}

export const SLACK_RATE_LIMIT_FALLBACK_MS = 30_000;

const SlackEnvelopeSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

/** Url-encoded request body. The token is a body field so it never appears in a URL or a log. */
export function encodeSlackBody(params: SlackParams, token: string): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) body.set(key, String(value));
  body.set("token", token);
  return body.toString();
}

export function readRetryAfterMs(header: string | null | undefined): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : SLACK_RATE_LIMIT_FALLBACK_MS;
}

/** Decodes a raw Slack HTTP reply into the payload or a failure descriptor. */
export function interpretSlackReply(
  status: number,
  retryAfterHeader: string | null | undefined,
  bodyText: string,
): { ok: true; payload: unknown } | { ok: false; failure: SlackFailure } {
  if (status === 429) {
    return {
      ok: false,
      failure: { error: "ratelimited", status, retryAfterMs: readRetryAfterMs(retryAfterHeader) },
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return { ok: false, failure: { error: "invalid_response", status } };
  }

  const envelope = SlackEnvelopeSchema.safeParse(payload);
  if (!envelope.success) return { ok: false, failure: { error: "invalid_response", status } };
  if (envelope.data.ok) return { ok: true, payload };

  const error = envelope.data.error ?? "unknown_error";
  return error === "ratelimited"
    ? { ok: false, failure: { error, status, retryAfterMs: readRetryAfterMs(retryAfterHeader) } }
    : { ok: false, failure: { error, status } };
}

export function slackCallError(failure: SlackFailure): SlackCallError {
  const error = new Error(failure.error) as SlackCallError;
  if (failure.status !== undefined) error.status = failure.status;
  if (failure.retryAfterMs !== undefined) error.retryAfterMs = failure.retryAfterMs;
  return error;
}
