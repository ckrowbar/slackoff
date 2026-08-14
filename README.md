# Slackoff

Slackoff connects opted-in [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) sessions to Slack. Each OMP session gets an interactive Slack thread where you can follow progress, send instructions, answer questions, stop work, switch models, and run supported OMP commands.

The project also includes Slackoff Console, an optional browser extension or userscript that turns the Slackoff direct message into a keyboard-first session dashboard.

## How it works

```text
OMP session
  └─ Slackoff OMP extension
       └─ user-only Unix socket
            └─ Slackoff daemon
                 ├─ Slack Socket Mode and Web API
                 ├─ session registry
                 └─ tmux launcher for remote session creation

Signed-in Slack tab
  └─ optional Slackoff Console
       └─ Slack Web API using the tab's in-memory credentials
```

- `src/extension.ts` is the OMP extension. It records opt-in state in the OMP session, forwards lifecycle events and assistant output, and replaces local questions with Slack questions while the bridge is active.
- `src/client.ts` connects the extension to the daemon. It starts the daemon automatically when the configured socket is unavailable.
- `src/daemon/` owns the Slack Bolt Socket Mode connection, session threads, Block Kit controls, App Home, image downloads, and tmux-backed session launching.
- `src/protocol.ts` and `src/metadata.ts` define the validated local protocol and structured Slack message metadata.
- `extension/` contains Slackoff Console. Its Chrome extension and Tampermonkey builds share the same controller, Slack adapter, and UI.

Only sessions explicitly enabled with `/slackoff on` are bridged. The daemon's Unix socket is created with mode `0600`. Slackoff Console keeps Slack credentials in memory and never writes them to storage or logs.

## Requirements

- Node.js 22 or newer
- OMP
- A Slack workspace where you can install a custom app
- `tmux` if you want to launch or attach OMP sessions from Slack App Home
- Chrome or Tampermonkey only if you want Slackoff Console

## Set up the Slack app

1. Open [Your Apps](https://api.slack.com/apps) and create an app from `slack-manifest.json`.
2. Under **Basic Information**, create an app-level token with the `connections:write` scope. This is the `xapp-...` token.
3. Install the app to the workspace. Copy its bot token, which starts with `xoxb-`.
4. Copy your Slack member ID from your Slack profile.

The manifest enables Socket Mode, App Home, direct-message events, interactivity, and the bot scopes Slackoff needs.

## Install

```sh
git clone git@github.com:ckrowbar/slackoff.git
cd slackoff
npm ci
npm run build

mkdir -p ~/.omp/agent/extensions
ln -sfn "$PWD/dist/src/extension.js" ~/.omp/agent/extensions/slackoff.js
mkdir -p ~/.config/slackoff
```

Create `~/.config/slackoff/config.json`:

```json
{
  "userId": "U0123456789",
  "botTokenFile": "/path/to/SLACKOFF_BOT_TOKEN",
  "appTokenFile": "/path/to/SLACKOFF_APP_TOKEN"
}
```

Write the `xoxb-...` bot token and `xapp-...` app token to those files, respectively, and restrict access to them:

```sh
chmod 600 /path/to/SLACKOFF_BOT_TOKEN /path/to/SLACKOFF_APP_TOKEN
```

Restart OMP after adding the extension. You do not normally need to start the daemon yourself. The OMP extension starts `dist/src/daemon/main.js` when the first enabled session connects. To run it in the foreground for troubleshooting:

```sh
node dist/src/daemon/main.js
```

### Configuration

Every file setting has an environment-variable equivalent. Environment variables take precedence.

| Purpose | Config key | Environment variable |
| --- | --- | --- |
| Slack member ID allowed to control sessions | `userId` | `SLACKOFF_USER_ID` |
| Bot token file | `botTokenFile` | `SLACKOFF_BOT_TOKEN_FILE` |
| App token file | `appTokenFile` | `SLACKOFF_APP_TOKEN_FILE` |
| Unix socket path | `socketPath` | `SLACKOFF_SOCKET_PATH` |
| Node executable | `nodePath` | `SLACKOFF_NODE` |
| OMP executable | `ompPath` | `SLACKOFF_OMP_PATH` |
| Config file location | | `SLACKOFF_CONFIG` |

You can provide tokens directly as `SLACKOFF_BOT_TOKEN` and `SLACKOFF_APP_TOKEN`. Token files are safer for long-running use.

## Use Slackoff

Start or resume an OMP session, then run:

```text
/slackoff on
```

Slackoff creates or restores the session's thread in the app direct message. The opt-in state and Slack binding persist with the OMP session.

Other extension commands:

```text
/slackoff status
/slackoff off
```

In Slack, reply in the session thread with a normal instruction or use a control message on its own line:

| Control | Result |
| --- | --- |
| `!stop` | Abort the active OMP turn |
| `!model <provider>/<id>` | Switch the session model |
| `!omp <command> [arguments]` | Run a supported OMP slash command without the leading slash |
| `!close` | Close the Slack thread's session binding |

Examples:

```text
!model anthropic/claude-sonnet-4-5
!omp compact
!omp skill:review the current diff
```

Interactive buttons provide the same stop, model, question-answer, and close operations. Multi-line messages and text that does not exactly match a control are delivered to OMP as normal instructions.

### App Home

Open the Slackoff app's **Home** tab to:

- launch a new detached tmux session with a name, working directory, and optional initial prompt;
- attach Slackoff to an existing tmux pane whose current command is `omp`;
- open active session threads.

Closing a session can close only the Slack binding or also terminate its tmux session.

## Install Slackoff Console (optional)

Slackoff works with normal Slack clients without the console. The console adds a session list, transcript view, composer, model picker, question controls, search, unread state, and keyboard navigation inside the Slack web app.

### Chrome extension

```sh
npm run build
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository's `extension` directory.

### Tampermonkey userscript

```sh
npm run build:userscript
```

Create a Tampermonkey script from `extension/dist/slackoff-console.user.js`. Open the Slackoff direct message after installation. Use `Alt+Shift+O` on Linux/Windows or `Command+Shift+O` on macOS to toggle the console.

See [`extension/README.md`](extension/README.md) for console controls, keyboard shortcuts, security behavior, and known Slack DOM fallbacks.

## Development

```sh
npm run typecheck
npm run typecheck:extension
npm test
npm run build
```

For UI work without Slack access, serve `extension/` with any static file server and open `extension/app.html`. It renders the console against in-memory fixtures.
