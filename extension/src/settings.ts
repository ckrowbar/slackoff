import { z } from "zod";

import { DEFAULT_SETTINGS } from "./types.js";
import type { StoredSettings } from "./types.js";

/** Everything the extension persists. Tokens are never among these keys. */
export const SETTINGS_KEYS = [
  "origin",
  "channelId",
  "userId",
  "closedBindings",
  "enabled",
  "notifications",
  "takeover",
  "theme",
  "sidebarWidth",
  "sidebarCollapsed",
] as const satisfies readonly (keyof StoredSettings)[];

/**
 * Every field tolerates a bad stored value on its own, so one corrupt key cannot reset the rest.
 * An empty string reads as absent, which is how a cached channel id is cleared through a settings
 * patch on hosts that have no delete primitive.
 */
const StoredSettingsSchema = z.object({
  origin: z.string().optional().catch(undefined),
  channelId: z.string().optional().catch(undefined),
  userId: z.string().optional().catch(undefined),
  closedBindings: z.array(z.string().min(1)).optional().catch(undefined),
  enabled: z.boolean().optional().catch(undefined),
  notifications: z.boolean().optional().catch(undefined),
  takeover: z.boolean().optional().catch(undefined),
  theme: z.enum(["codex", "slack", "light"]).optional().catch(undefined),
  sidebarWidth: z.number().int().min(220).max(560).optional().catch(undefined),
  sidebarCollapsed: z.boolean().optional().catch(undefined),
});

/**
 * Merge a stored snapshot over the defaults. Pure: every host reads its own storage and hands the
 * raw object here, so the two builds cannot disagree about what a setting means. Absent keys are
 * omitted rather than set to undefined, as `exactOptionalPropertyTypes` requires.
 */
export function parseSettings(raw: unknown): StoredSettings {
  const parsed = StoredSettingsSchema.safeParse(raw ?? {});
  const value = parsed.success ? parsed.data : {};
  const closedBindings = [...new Set(value.closedBindings ?? DEFAULT_SETTINGS.closedBindings)];

  return {
    ...DEFAULT_SETTINGS,
    closedBindings,
    ...(value.origin ? { origin: value.origin } : {}),
    ...(value.channelId ? { channelId: value.channelId } : {}),
    ...(value.userId ? { userId: value.userId } : {}),
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
    ...(value.notifications !== undefined ? { notifications: value.notifications } : {}),
    ...(value.takeover !== undefined ? { takeover: value.takeover } : {}),
    ...(value.theme !== undefined ? { theme: value.theme } : {}),
    ...(value.sidebarWidth !== undefined ? { sidebarWidth: value.sidebarWidth } : {}),
    ...(value.sidebarCollapsed !== undefined ? { sidebarCollapsed: value.sidebarCollapsed } : {}),
  };
}

/* ---------- options page <-> content script ---------- */

/**
 * The options page runs on the extension origin and therefore cannot see the Slack page's own
 * localStorage. It asks a live content script for this summary instead. No token is included.
 */
export const CONSOLE_DESCRIBE = "console.describe";

export interface ConsoleWorkspace {
  teamId: string;
  teamName: string;
}

export interface ConsoleDescription {
  workspaces: ConsoleWorkspace[];
  /** Slack channel the tab is currently showing, whether or not it is the Slackoff DM. */
  currentChannelId?: string;
  /** Resolved Slackoff DM, from cache or from discovery. */
  slackoffChannelId?: string;
  mounted: boolean;
}

const ConsoleDescriptionSchema = z.object({
  workspaces: z.array(z.object({ teamId: z.string(), teamName: z.string() })),
  currentChannelId: z.string().min(1).optional(),
  slackoffChannelId: z.string().min(1).optional(),
  mounted: z.boolean(),
});

/** Decodes a content script's reply. Returns undefined when the tab has no console in it. */
export function parseConsoleDescription(raw: unknown): ConsoleDescription | undefined {
  const parsed = ConsoleDescriptionSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data;

  return {
    workspaces: value.workspaces,
    ...(value.currentChannelId !== undefined ? { currentChannelId: value.currentChannelId } : {}),
    ...(value.slackoffChannelId !== undefined ? { slackoffChannelId: value.slackoffChannelId } : {}),
    mounted: value.mounted,
  };
}
