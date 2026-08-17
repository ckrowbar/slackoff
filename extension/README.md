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

Open the Slackoff DM in Slack. The console detects that conversation and covers the full Slack page.
Any other channel renders as stock Slack.

`Alt+Shift+O` (`Command+Shift+O` on macOS) toggles the takeover, as does the toolbar icon in the
extension build. Chrome reserves `Ctrl+Shift+O` for the bookmark manager, which is why the default
differs. The userscript menu includes **Toggle Slackoff script**, **Toggle takeover**,
**Re-detect Slackoff DM**, and **Toggle notifications**. Use **Toggle Slackoff script** to unmount
the userscript until you turn it on again. The extension build uses its options page instead.

## What it shows

Sessions are grouped by what they need from you: **Needs you**, **Working**, **Ready**, and
**Done**. Closed threads are hidden. Each row shows status, project, model, relative time, and unread
count.

The session sidebar can be collapsed or resized by dragging its divider. Focus the divider and use
the arrow keys to resize it in 16-pixel steps. The console remembers both settings.

The transcript renders headings, lists, emphasis, links, blockquotes, inline code, and fenced code.
It treats raw HTML as text.

State comes from the structured metadata the daemon attaches to each message. Messages posted
before that existed are parsed from their Block Kit blocks instead. Those cards may show a short id
and no model picker until the session next updates its card.

## Controls

| Action | What it posts |
| --- | --- |
| Send an instruction | your text |
| Answer a question | the option labels, comma-separated when multi-select |
| Stop | `!stop` |
| Switch model | `!model <provider>/<id>` |
| Run an OMP slash command | `!omp <command> [arguments]` |
| Close thread | `!close` |
| Add images | the image files, with optional instruction text |
| Create session | a top-level launch request with name, working directory, and optional prompt |

The `!` controls are recognised by the daemon (`src/daemon/commands.ts`). Use `!omp compact`,
`!omp model <provider>/<id>`, or `!omp skill:<name> [arguments]`; omit the slash that OMP normally
expects. A command must be a single line on its own. Any other text, including a multi-line message
that merely starts with `!stop`, is delivered as an instruction exactly as before.

## Keyboard

`j` / `k` or arrows move between sessions. `Enter` focuses the composer and sends from it.
`Shift+Enter` inserts a newline. `1` to `9` answer a pending question. `Cmd/Ctrl+K` opens the command
palette, which is the fastest way to switch model when a session offers dozens. `g` then `a` jumps
to the first session waiting on you. `Escape` leaves the composer, then offers to stop. `?` lists
every shortcut.

## What it changes

The console posts instructions, answers, controls, launch requests, and image files through Slack.
It never edits or deletes an existing Slack message. It does not change your Slack settings.

The console adds one full-page host element and one favicon link while it is active. It removes both
when you toggle the takeover off, navigate elsewhere, or disable the script or extension.

Session tokens stay in memory. Slackoff never writes them to storage or logs. The console also keeps
one-time image upload URLs out of the DOM and error messages.

Only the resolved DM channel id and your preferences persist. The extension uses
`chrome.storage.local`. The userscript uses the single `GM_setValue` key
`slackoff-console:settings`.

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
