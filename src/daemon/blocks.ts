import type { Button, KnownBlock } from "@slack/types";

import type { SessionDescriptor, SessionStatus } from "../protocol.js";

export const STOP_ACTION = "slackoff_stop";
export const CLOSE_THREAD_ACTION = "slackoff_close_thread";

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "⚪ Ready",
  working: "🔵 Working",
  waiting: "🟡 Waiting for you",
  stopping: "🟠 Stopping",
  done: "🟢 Done",
  error: "🔴 Error",
  offline: "⚫ Offline",
  disabled: "⚫ Disabled",
};

const STATUS_ICONS: Record<SessionStatus, string> = {
  idle: "⚪",
  working: "🔵",
  waiting: "🟡",
  stopping: "🟠",
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

  if (status !== "offline" && status !== "disabled") {
    const elements: Button[] = [];
    if (status === "working" || status === "waiting") {
      elements.push({
        type: "button",
        action_id: STOP_ACTION,
        text: { type: "plain_text", text: "Stop turn", emoji: false },
        value: bindingId,
        confirm: {
          title: { type: "plain_text", text: "Stop the active OMP turn?", emoji: false },
          text: { type: "mrkdwn", text: "The Slack thread stays connected for your next instruction." },
          confirm: { type: "plain_text", text: "Stop turn", emoji: false },
          deny: { type: "plain_text", text: "Keep running", emoji: false },
        },
      });
    }
    elements.push({
      type: "button",
      action_id: CLOSE_THREAD_ACTION,
      text: { type: "plain_text", text: "Close thread", emoji: false },
      value: bindingId,
      style: "danger",
      confirm: {
        title: { type: "plain_text", text: "Close this Slack thread?", emoji: false },
        text: { type: "mrkdwn", text: "Slackoff will be disabled for this OMP session until you turn it on again." },
        confirm: { type: "plain_text", text: "Close thread", emoji: false },
        deny: { type: "plain_text", text: "Keep open", emoji: false },
      },
    });
    blocks.push({ type: "actions", elements });
  }

  return blocks;
}

export function buildCollapsedSessionBlocks(session: SessionDescriptor): KnownBlock[] {
  const title = escapeMrkdwn(truncate(session.title, 150));
  const project = escapeMrkdwn(truncate(session.project || "Unknown", 150));
  return [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `⚫ *${title}* · Closed · ${project}` }],
    },
  ];
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
