import { z } from "zod";

import { SESSION_METADATA_EVENT } from "../../../src/metadata.js";
import type { Platform, SlackCredential, SlackParams } from "../platform.js";
import type { ImageUpload } from "../types.js";

/**
 * Slack Web API access, expressed against a Platform rather than a concrete transport, so the same
 * calls serve the MV3 build (fetch from the service worker, since a content script cannot reach a
 * sibling *.slack.com origin) and the userscript build (same-origin fetch or GM_xmlhttpRequest).
 */

export function callSlack<T>(
  platform: Platform,
  credential: SlackCredential,
  method: string,
  params: SlackParams = {},
): Promise<T> {
  return platform.call<T>(credential, method, params);
}

/* ---------- shapes we actually read ---------- */

export interface SlackMessage {
  ts: string;
  thread_ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  blocks?: unknown[];
  metadata?: unknown;
  reply_count?: number;
  latest_reply?: string;
}

export interface SlackHistoryResult {
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackConversation {
  id: string;
  is_im?: boolean;
  /** Peer user id, present on IM conversations. */
  user?: string;
}

export interface SlackConversationsListResult {
  channels?: SlackConversation[];
  response_metadata?: { next_cursor?: string };
}

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
}

export interface SlackPostResult {
  channel: string;
  ts: string;
  message?: SlackMessage;
}

export interface SlackAuthResult {
  user_id: string;
  user?: string;
  team_id: string;
  team?: string;
  url?: string;
}

const UploadUrlResultSchema = z.object({
  upload_url: z.string().url(),
  file_id: z.string().min(1),
});

export interface SlackImageUpload {
  channelId: string;
  threadTs: string;
  text: string;
  images: readonly ImageUpload[];
}

/**
 * Slack's external upload protocol: reserve one URL per file, upload raw bytes, then atomically
 * attach every staged file to the selected session thread.
 */
export async function uploadSlackImages(
  platform: Platform,
  credential: SlackCredential,
  request: SlackImageUpload,
): Promise<void> {
  const files: { id: string; title: string }[] = [];
  for (const image of request.images) {
    const raw = await callSlack<unknown>(platform, credential, "files.getUploadURLExternal", {
      filename: image.name,
      length: image.bytes.byteLength,
    });
    const upload = UploadUrlResultSchema.safeParse(raw);
    if (!upload.success) throw new Error("invalid_upload_response");
    await platform.upload(upload.data.upload_url, image.bytes, image.mimeType);
    files.push({ id: upload.data.file_id, title: image.name });
  }

  const text = request.text.trim();
  await callSlack(platform, credential, "files.completeUploadExternal", {
    files: JSON.stringify(files),
    channel_id: request.channelId,
    thread_ts: request.threadTs,
    ...(text ? { initial_comment: text } : {}),
  });
}

/* ---------- narrow wrappers ---------- */

/** Message metadata is opt-in on read, and every reader here depends on it. */
const READ_METADATA = { include_all_metadata: true } as const;

export function conversationsHistory(
  platform: Platform,
  credential: SlackCredential,
  params: SlackParams,
): Promise<SlackHistoryResult> {
  return callSlack<SlackHistoryResult>(platform, credential, "conversations.history", {
    ...params,
    ...READ_METADATA,
  });
}

export function conversationsReplies(
  platform: Platform,
  credential: SlackCredential,
  params: SlackParams,
): Promise<SlackHistoryResult> {
  return callSlack<SlackHistoryResult>(platform, credential, "conversations.replies", {
    ...params,
    ...READ_METADATA,
  });
}

export function chatPostMessage(
  platform: Platform,
  credential: SlackCredential,
  params: SlackParams,
): Promise<SlackPostResult> {
  return callSlack<SlackPostResult>(platform, credential, "chat.postMessage", params);
}

export function conversationsList(
  platform: Platform,
  credential: SlackCredential,
  params: SlackParams = {},
): Promise<SlackConversationsListResult> {
  return callSlack<SlackConversationsListResult>(platform, credential, "conversations.list", {
    ...params,
    ...READ_METADATA,
  });
}

export function usersInfo(
  platform: Platform,
  credential: SlackCredential,
  userId: string,
): Promise<{ user?: SlackUser }> {
  return callSlack<{ user?: SlackUser }>(platform, credential, "users.info", { user: userId });
}

export function authTest(platform: Platform, credential: SlackCredential): Promise<SlackAuthResult> {
  return callSlack<SlackAuthResult>(platform, credential, "auth.test", {});
}

/* ---------- discovery ---------- */

const SLACKOFF_ACTION_PREFIX = "slackoff_";
const SLACKOFF_BOT_NAME = "slackoff";
const IM_PAGE_LIMIT = 200;
const IM_PAGE_BUDGET = 5;

const ProbeMessageSchema = z.object({
  metadata: z.object({ event_type: z.string().optional() }).nullish(),
  blocks: z
    .array(
      z.object({
        block_id: z.string().nullish(),
        elements: z.array(z.object({ action_id: z.string().nullish() })).nullish(),
      }),
    )
    .nullish(),
});

/**
 * Probe candidates for the Slackoff DM by looking for the daemon's own fingerprints: session
 * metadata, or a card whose actions block carries a `slackoff_` action. Returns the first match.
 */
export async function findSlackoffChannel(
  platform: Platform,
  credential: SlackCredential,
  candidateChannelIds: readonly string[],
): Promise<string | undefined> {
  for (const channelId of candidateChannelIds) {
    let result: SlackHistoryResult;
    try {
      result = await conversationsHistory(platform, credential, { channel: channelId, limit: 5 });
    } catch {
      // A channel we cannot read is simply not the one we are looking for.
      continue;
    }
    if ((result.messages ?? []).some(isSlackoffMessage)) return channelId;
  }
  return undefined;
}

/**
 * Resolve the Slackoff DM. Listing IMs and identifying the Slackoff bot by name costs one call
 * plus one per peer, which is cheaper than reading history for every DM; the history probe stays
 * as the fallback for when the bot is named differently.
 */
export async function discoverSlackoffChannel(
  platform: Platform,
  credential: SlackCredential,
): Promise<string | undefined> {
  const ims = await listDirectMessages(platform, credential);

  for (const im of ims) {
    if (!im.user) continue;
    let user: SlackUser | undefined;
    try {
      user = (await usersInfo(platform, credential, im.user)).user;
    } catch {
      continue;
    }
    if (user && isSlackoffBot(user)) return im.id;
  }

  return findSlackoffChannel(
    platform,
    credential,
    ims.map((im) => im.id),
  );
}

function isSlackoffBot(user: SlackUser): boolean {
  if (user.is_bot !== true || user.deleted === true) return false;
  const names = [user.name, user.real_name];
  return names.some((name) => name?.trim().toLowerCase() === SLACKOFF_BOT_NAME);
}

async function listDirectMessages(
  platform: Platform,
  credential: SlackCredential,
): Promise<SlackConversation[]> {
  const conversations: SlackConversation[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < IM_PAGE_BUDGET; page += 1) {
    const result = await conversationsList(platform, credential, {
      types: "im",
      limit: IM_PAGE_LIMIT,
      exclude_archived: true,
      ...(cursor ? { cursor } : {}),
    });
    for (const channel of result.channels ?? []) {
      if (channel.id) conversations.push(channel);
    }
    cursor = result.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  return conversations;
}

function isSlackoffMessage(raw: SlackMessage): boolean {
  const probe = ProbeMessageSchema.safeParse(raw);
  if (!probe.success) return false;

  if (probe.data.metadata?.event_type === SESSION_METADATA_EVENT) return true;

  return (probe.data.blocks ?? []).some(
    (block) =>
      Boolean(block.block_id) &&
      (block.elements ?? []).some((element) =>
        element.action_id?.startsWith(SLACKOFF_ACTION_PREFIX),
      ),
  );
}
