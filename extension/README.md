# Slackoff Console

A coding-agent console rendered over your Slackoff DM, shipped two ways from one codebase: a
Tampermonkey userscript and a Chrome MV3 extension. Both read and write that DM through Slack's own
Web API using the credentials already in your signed-in Slack tab, so there is no separate service
to run and nothing to authorise.

It is additive. Slack mobile, the Slack desktop app, a browser without it, and any automation
driving Slack all keep working exactly as before, because every control is a normal message posted
into a session thread.

## Install as a userscript

Use this when policy forbids loading unpacked extensions. Tampermonkey needs **Allow User Scripts**
enabled on its own `chrome://extensions` details page; Chrome 138 and later replaced the old
developer-mode requirement with that per-extension toggle.

1. `npm install && npm run build:userscript`, which emits
   `extension/dist/slackoff-console.user.js`.
2. Open the Tampermonkey dashboard and create a new script.
3. Replace the template with the contents of `extension/dist/slackoff-console.user.js`, then save.

The userscript is only a Slack Web UI enhancement. After installation it runs entirely in the
signed-in Slack tab; it does not require a local server, tunnel, companion extension, or separate
authentication.

## Install as an extension

1. `npm install && npm run build` in the repository root. This emits `extension/dist`.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the
   `extension` directory.

## Either way

Open the Slackoff DM in Slack. The console detects that conversation and takes over the message
pane. Any other channel renders as stock Slack.

`Alt+Shift+O` (`Command+Shift+O` on macOS) toggles the takeover, as does the toolbar icon in the
extension build. Chrome reserves `Ctrl+Shift+O` for the bookmark manager, which is why the default
differs. The userscript's settings surface is the Tampermonkey menu: **Toggle takeover**,
**Re-detect Slackoff DM**, and **Toggle notifications**. The extension build uses its options page
instead.

## What it shows

Sessions are grouped by what they need from you: **Needs you**, **Working**, **Ready**, **Done**,
**Closed**. Each row carries the status, project, model, relative time, and an unread count.

State comes from the structured metadata the daemon attaches to each message. Messages posted
before that existed are parsed from their Block Kit blocks instead, which recovers everything except
the full session id, the untruncated title, and the model list. Those cards therefore show a short
id and no model picker until the session next updates its card.

## Controls

| Action | What it posts |
| --- | --- |
| Send an instruction | your text |
| Answer a question | the option labels, comma-separated when multi-select |
| Stop | `!stop` |
| Switch model | `!model <provider>/<id>` |
| Run an OMP slash command | `!omp <command> [arguments]` |
| Close thread | `!close` |

The `!` controls are recognised by the daemon (`src/daemon/commands.ts`). Use `!omp compact`,
`!omp model <provider>/<id>`, or `!omp skill:<name> [arguments]`; omit the slash that OMP normally
expects. A command must be a single line on its own. Any other text, including a multi-line message
that merely starts with `!stop`, is delivered as an instruction exactly as before.

## Keyboard

`j` / `k` or arrows move between sessions. `Enter` focuses the composer, `Shift+Enter` inserts a
newline, `Cmd/Ctrl+Enter` also sends. `1`–`9` answer a pending question. `Cmd/Ctrl+K` opens the
command palette, which is the fastest way to switch model when a session offers dozens. `g` then `a`
jumps to the first session waiting on you. `Escape` leaves the composer, then offers to stop.
`?` lists every shortcut.

## What it never does

It only reads messages and posts new ones. It never edits or deletes a Slack message, and it never
changes your Slack settings. Inside the page it adds one host element and sets one
`data-slackoff-hidden` attribute on the pane it covers; both are removed when you toggle the
takeover off, navigate elsewhere, or disable the extension.

Session tokens are read from the Slack tab, kept in memory, and never written to storage or a log.
Only the resolved DM channel id and your preferences persist, in `chrome.storage.local` for the
extension and under the single `GM_setValue` key `slackoff-console:settings` for the userscript.

## Known fragility

Positioning the console over Slack's message pane depends on Slack's internal DOM, tried in order:
`[data-qa="message_pane"]`, then `.p-workspace__primary_view`. A Slack release can change these. The
failure mode is degraded, not broken. If neither matches, the console falls back to a full-viewport
overlay inset past the sidebar and leaves Slack's pane untouched. If one matches but is implausibly
short, which is what a mis-matched inner wrapper looks like, the console fills down to the viewport
bottom rather than rendering a sliver.

## Development

```
npm run typecheck:extension   # tsc over extension/
npm run build:userscript      # extension/dist/slackoff-console.user.js only
npm run build:extension       # all bundles, minified, sidecar source maps
npm run watch:extension       # unminified, inline maps
npm test                      # includes the reducer, controller, and platform suites
```

`extension/app.html` hosts the console against in-memory fixtures with no Slack access, which is the
quickest way to work on the UI. Serve `extension/` and open that file.
