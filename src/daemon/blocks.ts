import type { Button, HomeView, KnownBlock, ModalView, PlainTextOption, StaticSelect } from "@slack/types";

import type { SessionDescriptor, SessionStatus } from "../protocol.js";

export const STOP_ACTION = "slackoff_stop";
export const CLOSE_THREAD_ACTION = "slackoff_close_thread";
export const MODEL_ACTION = "slackoff_model";
export const HOME_NEW_SESSION_ACTION = "slackoff_home_new_session";
export const HOME_LAUNCH_VIEW = "slackoff_home_launch";
export const HOME_NAME_BLOCK = "slackoff_home_name";
export const HOME_NAME_INPUT = "slackoff_home_name_input";
export const HOME_CWD_BLOCK = "slackoff_home_cwd";
export const HOME_CWD_INPUT = "slackoff_home_cwd_input";
export const HOME_PROMPT_BLOCK = "slackoff_home_prompt";
export const HOME_PROMPT_INPUT = "slackoff_home_prompt_input";
export const CLOSE_SESSION_VIEW = "slackoff_close_session";
export const CLOSE_SESSION_BLOCK = "slackoff_close_choice";
export const CLOSE_SESSION_INPUT = "slackoff_close_choice_input";
export const CLOSE_THREAD_ONLY = "thread";
export const CLOSE_AND_DELETE_TMUX = "thread_and_tmux";
export const HOME_ATTACH_ACTION = "slackoff_home_attach";
export const HOME_ATTACH_VIEW = "slackoff_home_attach_view";
export const HOME_ATTACH_BLOCK = "slackoff_home_attach_session";
export const HOME_ATTACH_INPUT = "slackoff_home_attach_session_input";

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
        {
          type: "mrkdwn",
          text: `*Model*\n${formatModel(session)}`,
        },
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `OMP session \`${escapeMrkdwn(session.id.slice(0, 12))}\`` }],
    },
  ];

  if (status !== "offline" && status !== "disabled") {
    const elements: Array<Button | StaticSelect> = [];
    const modelOptions = buildModelOptions(session);
    if (modelOptions.length > 0) {
      const currentSelector = session.modelState.current ? modelSelector(session.modelState.current) : undefined;
      const initialOption = modelOptions.find((option) => option.value === currentSelector);
      elements.push({
        type: "static_select",
        action_id: MODEL_ACTION,
        placeholder: { type: "plain_text", text: "Select model", emoji: false },
        options: modelOptions,
        ...(initialOption ? { initial_option: initialOption } : {}),
      });
    }
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
    });
    blocks.push({ type: "actions", block_id: bindingId, elements });
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
  permalink: string;
}

export function buildThreadReplyPermalink(
  permalink: string,
  channelId: string,
  threadTs: string,
  replyTs: string,
): string {
  const url = new URL(permalink);
  url.pathname = `/archives/${channelId}/p${replyTs.replace(".", "")}`;
  url.search = "";
  url.searchParams.set("thread_ts", threadTs);
  url.searchParams.set("cid", channelId);
  return url.toString();
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
        {
          type: "button",
          action_id: HOME_ATTACH_ACTION,
          text: { type: "plain_text", text: "Attach existing", emoji: false },
          value: "attach",
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
    for (const session of sessions.slice(-20).reverse()) {
      const status = session.activity ? statusIndicator(session.status, session.activity) : STATUS_LABELS[session.status];
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*<${escapeMrkdwn(session.permalink)}|${escapeMrkdwn(session.title)}>*\n${escapeMrkdwn(status)} · ${escapeMrkdwn(session.project)}`,
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

export function buildCloseSessionModal(bindingId: string, tmuxSessionName?: string): ModalView {
  const threadOnly: PlainTextOption = {
    text: { type: "plain_text", text: "Close Slack thread only", emoji: false },
    value: CLOSE_THREAD_ONLY,
  };
  const options: PlainTextOption[] = [threadOnly];
  if (tmuxSessionName) {
    options.push({
      text: {
        type: "plain_text",
        text: truncate(`Close thread and delete ${tmuxSessionName}`, 75),
        emoji: false,
      },
      value: CLOSE_AND_DELETE_TMUX,
    });
  }
  return {
    type: "modal",
    callback_id: CLOSE_SESSION_VIEW,
    private_metadata: bindingId,
    title: { type: "plain_text", text: "Close OMP session", emoji: false },
    submit: { type: "plain_text", text: "Continue", emoji: false },
    close: { type: "plain_text", text: "Cancel", emoji: false },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: tmuxSessionName
            ? `Choose whether to keep or delete tmux session \`${escapeMrkdwn(tmuxSessionName)}\`.`
            : "No active OMP tmux session was found. Only the Slack thread can be closed.",
        },
      },
      {
        type: "input",
        block_id: CLOSE_SESSION_BLOCK,
        label: { type: "plain_text", text: "Close behavior", emoji: false },
        element: {
          type: "radio_buttons",
          action_id: CLOSE_SESSION_INPUT,
          options,
          initial_option: threadOnly,
        },
      },
    ],
  };
}

export function buildAttachSessionModal(
  sessions: readonly { name: string; paneId: string }[],
): ModalView {
  const blocks: KnownBlock[] =
    sessions.length === 0
      ? [
          {
            type: "section",
            text: { type: "mrkdwn", text: "Every running OMP tmux session is already connected to Slackoff." },
          },
        ]
      : [
          {
            type: "input",
            block_id: HOME_ATTACH_BLOCK,
            label: { type: "plain_text", text: "OMP tmux session", emoji: false },
            element: {
              type: "static_select",
              action_id: HOME_ATTACH_INPUT,
              placeholder: { type: "plain_text", text: "Select a session", emoji: false },
              options: sessions.slice(0, 100).map((session) => ({
                text: { type: "plain_text", text: truncate(session.name, 75), emoji: false },
                value: session.paneId,
              })),
            },
          },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: "Slackoff will send `/slackoff on` to the selected OMP pane." }],
          },
        ];
  return {
    type: "modal",
    callback_id: HOME_ATTACH_VIEW,
    title: { type: "plain_text", text: "Attach existing OMP", emoji: false },
    ...(sessions.length > 0
      ? { submit: { type: "plain_text" as const, text: "Attach", emoji: false } }
      : {}),
    close: { type: "plain_text", text: "Cancel", emoji: false },
    blocks,
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
function formatModel(session: SessionDescriptor): string {
  const model = session.modelState.current;
  if (!model) return "Unknown";
  return `${escapeMrkdwn(model.name)}\n\`${escapeMrkdwn(modelSelector(model))}\``;
}

function buildModelOptions(session: SessionDescriptor): PlainTextOption[] {
  const current = session.modelState.current;
  const candidates = current
    ? [current, ...session.modelState.available.filter((model) => modelSelector(model) !== modelSelector(current))]
    : session.modelState.available;
  const seen = new Set<string>();
  const options: PlainTextOption[] = [];
  for (const model of candidates) {
    const selector = modelSelector(model);
    if (seen.has(selector) || selector.length > 150) continue;
    seen.add(selector);
    options.push({
      text: { type: "plain_text", text: truncate(`${model.name} · ${model.provider}`, 75), emoji: false },
      value: selector,
    });
    if (options.length === 100) break;
  }
  return options;
}

function modelSelector(model: SessionDescriptor["modelState"]["available"][number]): string {
  return `${model.provider}/${model.id}`;
}
