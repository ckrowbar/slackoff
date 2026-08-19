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

1. Run `npm install && npm run install:userscript`.
2. Select **Install or update Slackoff Console** on the local page.
3. Confirm the change in Tampermonkey.

The installer fetches and builds the latest revision from your current upstream branch. Set
`SLACKOFF_USERSCRIPT_UPSTREAM=origin/main` to use another remote branch. Keep the command running
until Tampermonkey finishes.

The userscript runs entirely in the signed-in Slack tab after installation. It does not need a local
server, tunnel, companion extension or separate authentication.

## Install as an extension

1. `npm install && npm run build` in the repository root. This emits `extension/dist`.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the
   `extension` directory.

## Either way

Open the Slackoff DM in Slack. The console detects that conversation and covers the full Slack page.
Any other channel renders as stock Slack.

The extension toolbar icon toggles the takeover. The userscript menu includes **Toggle Slackoff
script**, **Toggle takeover**, **Re-detect Slackoff DM**, and **Toggle notifications**. Use
**Toggle Slackoff script** to unmount the userscript until you turn it on again. The extension
build uses its options page instead.

## What it shows

Sessions are grouped by what they need from you: **Needs you**, **Working**, **Ready**, and
**Done**. Closed threads are hidden. Each row shows status, project, model, relative time, and unread
count.

While the console is visible, it advances the Slackoff DM read cursor to the newest message after a
short delay. This clears the same unread state in Slack's other open clients.

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

## Icon assets

`icons/sloth.svg` is the source artwork for the extension, takeover favicon, and userscript icon.
Chrome uses the generated `sloth-16.png`, `sloth-32.png`, `sloth-48.png`, and `sloth-128.png`
variants. Regenerate all four PNGs at their named dimensions whenever the SVG changes.

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
