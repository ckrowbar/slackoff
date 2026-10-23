# Slackoff for BB

Slackoff for BB mirrors [BB](https://getbb.app) agent threads into Slack. Each mirrored thread gets its own thread in your direct messages with the Slackoff app. From Slack you can follow progress, reply to the agent, answer its questions, approve tool requests, stop a turn, switch the model or effort, and start new threads.

It is a BB plugin, so it replaces both the OMP extension and the daemon in the rest of this repository. It needs no browser extension: Slackoff converts the agent's Markdown into native Slack formatting itself.

## What you get in Slack

- **A status card** at the top of each thread: title, project, status and current activity, model and effort. It has controls to switch model or effort, stop the turn, show the thread in BB, and stop mirroring.
- **Agent replies with real formatting.** Headings, bold, italics, strikethrough, inline code, links, nested and numbered lists, task lists, quotes, code blocks, tables and dividers become Slack rich text, table and divider blocks. Long replies split across messages at block boundaries.
- **A progress card per turn** that lists the agent's recent commands, edits, reads and searches, and its plan. It updates in place and closes when the agent replies, so the thread reads in order.
- **Questions and approvals as buttons.** A question with a few options shows one button per option. Other questions open a form. You can also reply with an option number or your own answer. Approvals show the command, plan or permission with Allow once, Allow for session and Deny.
- **Messages you send from BB** appear as "You", so the Slack thread has the whole conversation.
- **Replies from Slack go to the agent.** Slackoff turns your Slack formatting, including code blocks, lists and links, back into Markdown. Attached files and images are uploaded to the thread. A 👀 reaction confirms delivery, and ⏳ means the message is queued behind the running turn.
- **New threads from Slack.** Send the app a direct message to start a BB thread in your default project. The App Home tab lists mirrored threads and has New thread and Mirror a thread buttons.

## Set up the Slack app

1. Open [Your Apps](https://api.slack.com/apps) and create an app from [`slack-manifest.json`](slack-manifest.json). Use a separate app from the OMP version: Slack spreads events across every Socket Mode connection of an app.
2. Under **Basic Information**, create an app-level token with the `connections:write` scope. This is the `xapp-…` token.
3. Install the app to your workspace and copy the bot token (`xoxb-…`).
4. Copy your Slack member ID from your profile (⋯ → Copy member ID).

## Install

```sh
cd bb-plugin
npm ci
bb plugin install . --yes
bb plugin config slackoff set botToken xoxb-…
bb plugin config slackoff set appToken xapp-…
bb plugin config slackoff set userId U0123456789
```

The plugin connects as soon as all three are set. Tokens are stored as BB secret settings, which are files with mode `0600`, and never reach the browser.

Optional settings:

| Setting | Effect |
| --- | --- |
| `defaultProjectId` | Project for threads started by a direct message. Without it, Slack asks you to choose. |
| `mirrorNewThreads` | Mirror every new visible top-level thread automatically. Off by default. |
| `showActivity` | Post progress cards for tool activity. On by default. |
| `appUrl` | BB web address for Open in BB links. Without it, Show in BB focuses the thread in your open BB window. |

## Use it

- In BB, use the message icon in a thread's header to start or stop mirroring.
- From a terminal or an agent: `bb slackoff on`, `bb slackoff off`, `bb slackoff status` and `bb slackoff list`. `on` and `off` default to the current thread; pass `--thread <id>` for another.
- In a Slack thread, send `!help` for text commands: `!stop`, `!model <id>`, `!effort <level>`, `!compact`, `!status` and `!close`.

Only the configured Slack user can control threads. Slackoff ignores messages and button clicks from anyone else.

## How it works

```text
BB server
  └─ Slackoff plugin
       ├─ Socket Mode service (outbound WebSocket to Slack; no public URL)
       ├─ BB events: thread lifecycle, event sequence, pending interactions
       └─ kv store: one binding per mirrored thread (Slack thread, last event seq, open cards)
```

- [`server.ts`](server.ts) wires settings, the Slack service, BB events, RPC and the CLI.
- [`src/bridge.ts`](src/bridge.ts) mirrors BB events to Slack and routes Slack messages, buttons and forms back to BB. It reads the thread's event log from the last mirrored sequence, so a restart or dropped connection catches up without duplicates.
- [`src/format/markdown.ts`](src/format/markdown.ts) converts Markdown to Block Kit. [`src/format/mrkdwn.ts`](src/format/mrkdwn.ts) converts Slack messages back to Markdown, and builds a plain mrkdwn version used when Slack rejects a rich message.
- [`src/slack/`](src/slack) has a small Web API client and a Socket Mode client with reconnects and a silent-link watchdog.
- [`app.tsx`](app.tsx) adds the mirror toggle to the thread header.

## Development

```sh
npm ci
npm test
npm run typecheck
bb plugin build
```

`bb plugin dev` rebuilds and reloads the installed plugin on every save. `bb plugin logs slackoff -f` follows its log.
