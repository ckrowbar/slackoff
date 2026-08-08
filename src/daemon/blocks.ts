import type { Button, HomeView, KnownBlock, ModalView } from "@slack/types";

import type { SessionDescriptor, SessionStatus } from "../protocol.js";

export const STOP_ACTION = "slackoff_stop";
export const CLOSE_THREAD_ACTION = "slackoff_close_thread";
export const HOME_NEW_SESSION_ACTION = "slackoff_home_new_session";
export const HOME_LAUNCH_VIEW = "slackoff_home_launch";
export const HOME_NAME_BLOCK = "slackoff_home_name";
export const HOME_NAME_INPUT = "slackoff_home_name_input";
export const HOME_CWD_BLOCK = "slackoff_home_cwd";
export const HOME_CWD_INPUT = "slackoff_home_cwd_input";
export const HOME_PROMPT_BLOCK = "slackoff_home_prompt";
export const HOME_PROMPT_INPUT = "slackoff_home_prompt_input";

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

export interface HomeSession {
  title: string;
  project: string;
  status: SessionStatus;
  activity?: string | undefined;
}

export function buildHomeView(sessions: readonly HomeSession[], notice?: string): HomeView {
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "OMP sessions", emoji: false },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Start OMP in a new tmux session. Slackoff will create a separate Slack thread automatically.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: HOME_NEW_SESSION_ACTION,
          text: { type: "plain_text", text: "New session", emoji: false },
          value: "new",
          style: "primary",
        },
      ],
    },
  ];

  if (notice) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Last launch*\n${escapeMrkdwn(notice)}` } });
  }
  blocks.push({ type: "divider" });
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `Connected sessions (${sessions.length})`, emoji: false },
  });
  if (sessions.length === 0) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "No OMP sessions are connected." }] });
  } else {
    for (const session of sessions.slice(0, 20)) {
      const status = session.activity ? statusIndicator(session.status, session.activity) : STATUS_LABELS[session.status];
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${escapeMrkdwn(session.title)}*\n${escapeMrkdwn(status)} · ${escapeMrkdwn(session.project)}`,
        },
      });
    }
  }
  return { type: "home", blocks };
}

export function buildLaunchModal(defaultCwd: string): ModalView {
  return {
    type: "modal",
    callback_id: HOME_LAUNCH_VIEW,
    title: { type: "plain_text", text: "New OMP session", emoji: false },
    submit: { type: "plain_text", text: "Launch", emoji: false },
    close: { type: "plain_text", text: "Cancel", emoji: false },
    blocks: [
      {
        type: "input",
        block_id: HOME_NAME_BLOCK,
        label: { type: "plain_text", text: "tmux session name", emoji: false },
        element: {
          type: "plain_text_input",
          action_id: HOME_NAME_INPUT,
          placeholder: { type: "plain_text", text: "parser-fix", emoji: false },
          max_length: 64,
        },
      },
      {
        type: "input",
        block_id: HOME_CWD_BLOCK,
        label: { type: "plain_text", text: "Working directory", emoji: false },
        element: {
          type: "plain_text_input",
          action_id: HOME_CWD_INPUT,
          initial_value: defaultCwd,
        },
      },
      {
        type: "input",
        block_id: HOME_PROMPT_BLOCK,
        optional: true,
        label: { type: "plain_text", text: "Initial prompt", emoji: false },
        element: {
          type: "plain_text_input",
          action_id: HOME_PROMPT_INPUT,
          multiline: true,
          max_length: 3_000,
        },
      },
    ],
  };
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
