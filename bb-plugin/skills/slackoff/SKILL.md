---
name: slackoff
description: Mirror a BB thread into the user's Slack DMs with the `bb slackoff` CLI. Use when the user asks to follow, continue or control a thread from Slack, to stop mirroring, or to check whether Slackoff is connected.
---

# Slackoff

Slackoff mirrors BB threads into a Slack direct message with the Slackoff app.
Each mirrored thread gets one Slack thread with a live status card, the
agent's replies, a progress card for tool activity, and buttons for questions
and approvals. The user can reply in Slack to steer the agent.

## Commands

| Command | Effect |
| --- | --- |
| `bb slackoff on [--thread <id>]` | Start mirroring. Defaults to the thread running the command. |
| `bb slackoff off [--thread <id>]` | Stop mirroring. The BB thread keeps running. |
| `bb slackoff status [--thread <id>] [--json]` | Show the Slack connection and whether the thread is mirrored. |
| `bb slackoff list [--json]` | List mirrored thread IDs. |

## Procedure

1. Run `bb slackoff status` first. If it says "not configured", tell the user
   to set the Slack tokens with `bb plugin config slackoff`; do not ask for
   the token values in chat.
2. Turn mirroring on only when the user asks for it. Mirroring posts to the
   user's Slack.
3. After `bb slackoff on`, share the Slack link it prints.

## What the user can do in Slack

- Reply in the thread to send a message to the agent. Files and images are
  attached to the message.
- Use the card's controls to stop the turn, switch model or effort, or stop
  mirroring.
- Answer questions and approve or deny tool requests with buttons.
- Send `!help` in the thread for text commands: `!stop`, `!model <id>`,
  `!effort <level>`, `!compact`, `!status`, `!close`.
- Send a new direct message to the app to start a new BB thread.

Agent replies are converted from Markdown to Slack formatting, so write normal
Markdown. Tables, nested lists, code blocks and links render natively.
