# Pinano

<p>
<a href="#pinano"><img src="https://github.com/rmst/pinano/releases/download/readme-assets/install-setup-scripted-640w.gif" alt="Pinano install and setup demo" width="49%"></a>
<a href="#pinano"><img src="https://github.com/rmst/pinano/releases/download/readme-assets/overview-attach-scripted-640w.gif" alt="Pinano session overview and running agent demo" width="49%"></a>
</p>

Pinano is an interactive AI coding agent for the terminal, designed to be used with your ChatGPT/Codex subscription. It has a more advanced terminal UI than the official Codex CLI, while exposing the same system prompt and equivalent tools to the model, so model performance should be just as good. Other APIs are also supported, including llama.cpp and DeepSeek; see below.

Pinano is directly installable from GitHub source, with no npm dependencies and no build step.

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

API keys are also supported. Pinano can import supported API keys from the launch environment (`OPENAI_API_KEY`, `MOONSHOT_API_KEY`/`KIMI_API_KEY`, `DEEPSEEK_API_KEY`, `LLAMACPP_API_KEY`) or accept manual entry from the credentials page. Deployment-level API keys and other settings can also be configured declaratively.


## Common commands

```bash
pinano                           # open the session overview
pinano open /chat/<id>           # open a session directly
pinano service                   # show local service status
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
| `Ctrl+G` | return to the overview, including while composing text |
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
| `/debug-log [clear]` | show captured stderr or clear it |
| `/settings` | edit local settings; includes credentials |

### Session commands

| Command | What it does |
|---|---|
| `/continue` | resume an interrupted turn, or ask the model to continue |
| `/abort` | abort the current turn |
| `/session` | show current session metadata |
| `/fast on\|off\|status` | toggle Codex Fast mode when supported by the model |
| `/compact` | compact older conversation messages |
| `/branch` | create a new session from the current conversation branch |
| `/rewind` | rewind to an earlier prompt or switch branch |
| `/context` | show context usage |

In an open session, type `!cmd` to run a shell command directly. Use `!!cmd` to run it without adding the result to agent context.

Press `Ctrl+V` in the session or overview editor to paste an image from the system clipboard. On Linux this requires `wl-clipboard` (`wl-paste`) or `xclip`; under WSL, Pinano also opportunistically tries Windows clipboard access through `powershell.exe` interop.

Shell commands run with Pinano's fallback-tool bin directory appended to `PATH`, so real system tools always win. GPT-5.x agents use `exec_command`/`write_stdin` for long-running shell processes, stdin/EOF, polling, and process-group signals; the legacy `bash` tool remains for non-Codex tool profiles and the `!cmd` shortcut. The first fallback tool is `curl`: it covers common HTTP(S) use (`-fsSL`, redirects, headers, data/json/forms, output files, basic auth, TLS files, compression, timeouts, `-w`, `-D`) and exits clearly for unsupported curl options or protocols.

## Branching and rewind

`/branch` creates a new session from the current conversation point. The original session remains unchanged and both sessions can continue independently.

Press `Esc Esc` on an empty editor to open `/rewind`. You can return to an earlier prompt, switch to another branch tip, and optionally restore files changed through Pinano's `write` and `edit` tools.

## Tool environments

By default tools run in a native filesystem sandbox on macOS and Linux. macOS uses `sandbox-exec`; Linux uses Bubblewrap (`bwrap`). Sandbox paths default to `["."]`, resolved against the configured environment `cwd` when one is set, otherwise against the session's initial cwd; later `cwd` changes must stay under one of those paths. Native workers allow reads from sandbox paths plus system, toolchain, Pinano runtime paths, and the environment's tool home, while writes stay restricted to sandbox paths, temp directories, and that tool home. Native sandbox workers use a per-environment fake home under `$PINANO_HOME/environments/<environment-id>/home`; `HOME`, XDG roots, temp variables, and Pinano fallback-tool wrappers all point there so tools share state across projects without writing into project directories. If Linux native sandboxing cannot start because `bwrap` is unavailable or unusable, Pinano fails closed and tells you how to opt into `sandbox.type: "none"` explicitly.

You can also configure explicit local, container, or SSH environments in `$PINANO_HOME/config/environments.json`:

```json
{
	"default": "local",
	"environments": {
		"local": {
			"target": "local",
			"sandbox": {
				"type": "container",
				"image": "ghcr.io/example/pinano-tools:latest",
				"paths": [".", "../shared"]
			}
		},
		"existing-container": {
			"target": "local",
			"cwd": "/workspace/project",
			"sandbox": {
				"type": "container",
				"engine": "docker",
				"container": "pinano-tools"
			}
		},
		"remote": {
			"target": "ssh:devbox",
			"cwd": "/home/me/project",
			"sandbox": { "type": "none" }
		}
	}
}

```

`target` describes where tools run. `sandbox.type: "native"` uses `sandbox-exec` on macOS and `bwrap` on Linux. `sandbox.type: "container"` with `image` makes Pinano start and own the container; with `container` it execs into an already-running container. Managed containers default to `docker.io/library/node:22-alpine` when no image is set. `sandbox.paths` are writable roots, resolved relative to the environment `cwd` when it is configured and otherwise the session's initial cwd. `sandbox.type: "none"` runs without a Pinano sandbox and should be treated as an explicit unsafe opt-out. The legacy `worker` field is still accepted for existing configs.

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
  agent-core/        AgentLoop + Agent (streamFn-driven), JSDoc types
  ai-apis/           zero-dep OpenAI Chat-Completions / Responses / Codex clients
  tools/             read/view_image, write, edit/apply_patch, exec_command/write_stdin, bash, ls, grep, find, js
  fallback-tools/    PATH fallbacks for common external commands (currently curl)
  session-manager/   SQLite + in-memory storage, parent-link tree
  tui/               ported pi-tui — Markdown renderer restored with vendored
                     marked, east-asian-width vendored, Intl.Segmenter
                     polyfilled for [qn](https://github.com/rmst/qn)
  app/
    main.js          entry, args, settings/auth wiring
    agents-mode.js   service-backed agents overview + open chat view
    components/      footer, picker, prompt-input, transcript message components
    auth.js          multi-provider credential store
    models.js        curated model registry
    settings.js      ~/.pinano/config/settings.json (or $PINANO_HOME/config/)
    session-store.js wraps Session for app-level open/list/metadata
    server-db.js     SQLite db + migrations for session transcripts, metadata, and run state
    server-runtime.js per-session Agent runtimes for Pinano server/web/service mode
    service-mode.js   local background supervisor service + HTTP/SSE client
    web-mode.js      browser UI / local server HTTP/SSE routes
    compaction.js    auto-summarize older messages near context limit
```

## Notes

- The initial version of Pinano was based on [Pi](https://github.com/earendil-works/pi).
- Pinano also runs on the experimental [Qn](https://github.com/rmst/qn) runtime.
