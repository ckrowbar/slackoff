import type { KnownBlock } from "@slack/types";

import type { SessionDescriptor, SessionStatus } from "../protocol.js";

export const STOP_ACTION = "slackoff_stop";

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "⚪ Ready",
  working: "🔵 Working",
  waiting: "🟡 Waiting for you",
  done: "🟢 Done",
  error: "🔴 Error",
  offline: "⚫ Offline",
  disabled: "⚫ Disabled",
};

const STATUS_ICONS: Record<SessionStatus, string> = {
  idle: "⚪",
  working: "🔵",
  waiting: "🟡",
  done: "🟢",
  error: "🔴",
  offline: "⚫",
  disabled: "⚫",
};

export function buildSessionBlocks(
  session: SessionDescriptor,
  bindingId: string,
  status: SessionStatus,
  activity: string | undefined,
): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: truncate(session.title, 150), emoji: true },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Status*\n${escapeMrkdwn(activity ? statusIndicator(status, activity) : STATUS_LABELS[status])}`,
        },
        { type: "mrkdwn", text: `*Project*\n${escapeMrkdwn(session.project || "Unknown")}` },
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `OMP session \`${escapeMrkdwn(session.id.slice(0, 12))}\`` }],
    },
  ];

  if (status === "working" || status === "waiting") {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: STOP_ACTION,
          text: { type: "plain_text", text: "Stop", emoji: false },
          value: bindingId,
          style: "danger",
          confirm: {
            title: { type: "plain_text", text: "Stop this OMP turn?", emoji: false },
            text: { type: "mrkdwn", text: "This stops only the active turn for this OMP session." },
            confirm: { type: "plain_text", text: "Stop", emoji: false },
            deny: { type: "plain_text", text: "Keep running", emoji: false },
          },
        },
      ],
    });
  }

  return blocks;
}


export function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function statusIndicator(status: SessionStatus, activity: string): string {
  return `${STATUS_ICONS[status]} ${activity}`;
}

function truncate(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum - 1)}…`;
}
