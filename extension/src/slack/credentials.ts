import { z } from "zod";

import type { SlackCredential } from "../platform.js";

/**
 * The Slack web client keeps a per-team session token in the page's own localStorage. A content
 * script shares that origin, so the extension can act as the signed-in user without a second
 * auth flow. Tokens are held in memory only: never logged, never put in an error message, never
 * written to chrome.storage.
 */

const LOCAL_CONFIG_KEYS = ["localConfig_v2", "localConfig"] as const;

const TeamSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  domain: z.string().optional(),
  token: z.string().optional(),
  user_id: z.string().optional(),
});

/** Unknown fields are stripped rather than rejected: Slack reshapes this blob without notice. */
const LocalConfigSchema = z.object({
  teams: z.record(z.string(), TeamSchema),
});

const TEAM_ID = /^[TE][A-Z0-9]+$/i;
const CHANNEL_ID = /^[CDG][A-Z0-9]+$/i;

/**
 * Credentials for every team the page has a token for. When the current URL names a team, only
 * that team is returned; otherwise the caller gets all of them and can probe each in turn.
 */
export function readCredentials(): SlackCredential[] {
  const config = readLocalConfig();
  if (!config) return [];

  const all: SlackCredential[] = [];
  for (const [key, team] of Object.entries(config.teams)) {
    const token = team.token?.trim();
    if (!token) continue;
    const teamId = team.id || key;
    const domain = team.domain?.trim();
    all.push({
      teamId,
      teamName: team.name?.trim() || teamId,
      token,
      ...(team.user_id ? { userId: team.user_id } : {}),
      origin: domain ? `https://${domain}.slack.com` : location.origin,
    });
  }

  const current = parseClientUrl(location.href).teamId;
  const matching = current ? all.filter((credential) => credential.teamId === current) : [];
  return matching.length > 0 ? matching : all;
}

/** Splits `https://app.slack.com/client/<TEAM>/<CHANNEL>` and its deeper-path variants. */
export function parseClientUrl(url: string): { teamId?: string; channelId?: string } {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return {};
  }

  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments[0] !== "client") return {};
  const teamId = segments[1];
  const channelId = segments[2];

  return {
    ...(teamId && TEAM_ID.test(teamId) ? { teamId } : {}),
    ...(channelId && CHANNEL_ID.test(channelId) ? { channelId } : {}),
  };
}

function readLocalConfig(): z.infer<typeof LocalConfigSchema> | undefined {
  for (const key of LOCAL_CONFIG_KEYS) {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      // Slack can wipe storage mid-session; treat that as "no credentials yet".
      return undefined;
    }
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const config = LocalConfigSchema.safeParse(parsed);
    if (config.success) return config.data;
  }
  return undefined;
}
