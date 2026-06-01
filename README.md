# Pinano

(<i>experimental</i>)

Pinano is an interactive AI coding agent for the terminal, designed to be used with your ChatGPT/Codex subscription. It has a more advanced terminal UI than the official Codex CLI, while exposing the same system prompt and equivalent tools to the model, so model performance should be just as good. Other APIs are also supported, including llama.cpp and DeepSeek; see below.

Pinano is directly installable from GitHub source, with no npm dependencies and no build step.

## Screenshots and videos

Coming soon:

- screenshot: session overview
- screenshot: open chat session
- video: dispatching and reviewing background agents

## Install

Requires **Node ≥ 22.6**.

```bash
npm install -g github:rmst/pinano
pinano
```

Or clone and run directly:

```bash
git clone https://github.com/rmst/pinano
./pinano/bin/pinano.js
```

On first run, Pinano opens model provider credentials when no provider is configured. Pinano is currently optimized for use with a ChatGPT subscription; **Use your ChatGPT subscription** starts the OpenAI OAuth flow. You can also open this page later with `pinano open /settings/credentials`, `/credentials` from the session overview, or the credentials item inside `/settings`.

API keys are also supported. Pinano can import supported API keys from the launch environment (`OPENAI_API_KEY`, `MOONSHOT_API_KEY`/`KIMI_API_KEY`, `DEEPSEEK_API_KEY`, `LLAMACPP_API_KEY`) or accept manual entry from the credentials page. Deployment-level API key fallbacks can also be configured in `$PINANO_HOME/config/service.json`:

```json
{
	"providers": {
		"openai": { "apiKey": "..." },
		"moonshot": { "apiKey": "..." },
		"llamacpp": { "apiKey": "..." },
		"deepseek": { "apiKey": "..." }
	}
}
```

Launcher/deployment defaults for user settings can be placed in `$PINANO_HOME/config/default-settings.json`. Pinano merges built-in defaults, `default-settings.json`, and user-owned `settings.json` in that order.

## Common commands

```bash
pinano                           # open the session overview
pinano open /                    # open the session overview
pinano open /chat/<id>           # open a session
pinano open /settings/credentials # manage ChatGPT/API-key credentials
pinano service                   # show local service status
pinano service status --json     # show local service status as JSON
pinano --help
```

## Session overview

Running `pinano` opens an overview of your sessions. Type a task and press `Enter` to start a new background session in the current directory. Use `/model` from the overview to update the global default model for newly dispatched sessions.

Useful keys:

| Key | Action |
|---|---|
| `↑` / `↓` | select a session |
| `Enter` / `→` | open the selected session |
| `←` | return to the overview |
| `Space` | peek at the selected session or reply to it |
| `Esc` | interrupt an open running session |
| `Ctrl+X` | stop a selected running session |
| `Ctrl+C` | detach this terminal without stopping running sessions |

Sessions are grouped by review state, such as `Needs input`, `Ready for review`, `Working`, `Deferred`, and `Completed`.

Pinano keeps running sessions alive when you detach from the terminal and shuts down automatically after all sessions are idle.

## In-app commands

Type `/` to autocomplete. `/help` shows the full command list for the current view.

### Overview commands

| Command | What it does |
|---|---|
| `/model` | select the default model for new sessions |
| `/reasoning` | set the default reasoning effort for new sessions |
| `/usage` | show ChatGPT/Codex usage limits |
| `/settings` | edit local settings; includes credentials |

### Session commands

| Command | What it does |
|---|---|
| `/agents`, `/bg`, `/background` | return to the session overview |
| `/continue` | resume an interrupted turn, or ask the model to continue |
| `/abort` | abort the current turn |
| `/session` | show current session metadata |
| `/fast on\|off\|status` | toggle Codex Fast mode when supported by the model |
| `/compact` | compact older conversation messages |
| `/branch` | create a new session from the current conversation branch |
| `/rewind` | rewind to an earlier prompt or switch branch |
| `/context` | show context usage |
| `/system` | show system prompt, tools, and loaded project context |
| `/log [clear]` | show captured stderr or clear it |

In an open session, type `!cmd` to run a shell command directly. Use `!!cmd` to run it without adding the result to agent context.

## Branching and rewind

`/branch` creates a new session from the current conversation point. The original session remains unchanged and both sessions can continue independently.

Press `Esc Esc` on an empty editor to open `/rewind`. You can return to an earlier prompt, switch to another branch tip, and optionally restore files changed through Pinano's `write` and `edit` tools.

## Tool environments

By default tools run locally. You can also configure Docker or SSH environments in `$PINANO_HOME/config/environments.json`:

```json
{
	"default": "local",
	"environments": {
		"local": { "worker": "local" },
		"container": {
			"worker": "docker:pinano-tools",
			"cwd": "/workspace/project"
		},
		"remote": {
			"worker": "ssh:devbox",
			"cwd": "/home/me/project"
		}
	}
}

```

`cwd` is the working directory inside that environment. Pinano does not guess host/container path mappings.

## Project context

Pinano reads project instructions from `AGENTS.md` or `CLAUDE.md`:

1. Global instructions under `~/.pinano/`.
2. Instructions in ancestor directories of the current working directory.
3. Additional instructions in subdirectories when a tool first touches files there.

If both files exist in the same directory, `AGENTS.md` wins.

Context files are captured when a session starts or when a subdirectory is loaded. Resuming an old session reuses the captured instructions, so later edits only affect new sessions.

### `@import`

`@<path>` references in normal Markdown text are replaced with that file's contents. Relative paths resolve against the importing file; `~/` expands to `$HOME`. Inline code and fenced code blocks are left alone.

```md
# project rules
See @README for project overview.
@./conventions.md
@~/.pinano/personal-style.md
```

## Repository layout

```text
src/
  agent-core/        Agent loop and state
  ai-apis/           OpenAI Chat Completions / Responses / Codex clients
  tools/             read, write, edit, bash, ls, grep, find, js
  session-manager/   SQLite + in-memory session storage
  tui/               terminal UI components
  app/               CLI, settings, auth, service, overview, chat UI
```

## Notes

- The initial version of Pinano was based on [Pi](https://github.com/earendil-works/pi).
- Pinano also runs on the experimental [Qn](https://github.com/rmst/qn) runtime.
