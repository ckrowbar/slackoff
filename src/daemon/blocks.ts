import type { KnownBlock, ModalView } from "@slack/types";

import type { SessionDescriptor, SessionStatus } from "../protocol.js";

export const SEND_INSTRUCTION_ACTION = "slackoff_send_instruction";
export const STOP_ACTION = "slackoff_stop";
export const INSTRUCTION_VIEW = "slackoff_instruction";
export const INSTRUCTION_BLOCK = "instruction";
export const INSTRUCTION_INPUT = "text";

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "Idle",
  working: "Working",
  waiting: "Waiting for input",
  error: "Error",
  offline: "Offline",
  disabled: "Disabled",
};

export function buildSessionBlocks(
  session: SessionDescriptor,
  bindingId: string,
  status: SessionStatus,
  activity: string | undefined,
  lastActivity: string,
): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Slackoff · ${truncate(session.title, 130)}`, emoji: false },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Status*\n${STATUS_LABELS[status]}` },
        { type: "mrkdwn", text: `*Project*\n${escapeMrkdwn(session.project || "Unknown")}` },
        { type: "mrkdwn", text: `*Last activity*\n${escapeMrkdwn(lastActivity)}` },
        ...(activity ? [{ type: "mrkdwn" as const, text: `*Current activity*\n${escapeMrkdwn(activity)}` }] : []),
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `OMP session \`${escapeMrkdwn(session.id.slice(0, 12))}\`` }],
    },
  ];

  if (status !== "offline" && status !== "disabled") {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SEND_INSTRUCTION_ACTION,
          text: { type: "plain_text", text: "Send instruction", emoji: false },
          value: bindingId,
          style: "primary",
        },
        {
          type: "button",
          action_id: STOP_ACTION,
          text: { type: "plain_text", text: "Stop", emoji: false },
          value: bindingId,
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

export function buildInstructionModal(bindingId: string, sessionTitle: string): ModalView {
  return {
    type: "modal",
    callback_id: INSTRUCTION_VIEW,
    private_metadata: bindingId,
    title: { type: "plain_text", text: "Send to OMP", emoji: false },
    submit: { type: "plain_text", text: "Send", emoji: false },
    close: { type: "plain_text", text: "Cancel", emoji: false },
    blocks: [
      {
        type: "input",
        block_id: INSTRUCTION_BLOCK,
        label: { type: "plain_text", text: truncate(sessionTitle, 200), emoji: false },
        element: {
          type: "plain_text_input",
          action_id: INSTRUCTION_INPUT,
          multiline: true,
          placeholder: { type: "plain_text", text: "Instruction for this OMP session", emoji: false },
        },
      },
    ],
  };
}

export function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function truncate(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum - 1)}…`;
}
