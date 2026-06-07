# Pinano

<p>
<a href="#pinano"><img src="https://github.com/rmst/pinano/releases/download/readme-assets/overview-attach-scripted-960w.gif" alt="Pinano session overview and running agent demo" width="100%"></a>
</p>

Pinano is an interactive AI coding assistant for the terminal with an ergonomic agent-view UI comparable to Claude Code's [Agent View](https://code.claude.com/docs/en/agent-view). Pinano works very well with a ChatGPT/Codex subscription. Pinano exposes the same system prompt and tools like the official Codex CLI, so agent performance with the flagship GPT-5.x models should be just as good. Other APIs are also supported, including local models via `llama.cpp`.

Pinano is directly installable from GitHub source, with no npm dependencies and no build step.

## Install

```bash
npm install -g github:rmst/pinano
pinano
```

Requires **Node ≥ 22.6**. It's best tested on MacOS but it also runs on Linux and Windows WSL-2 where it requires bubblewrap for sandboxing (it will offer to run without a sandbox otherwise).

<details>
<summary>Clone and run directly</summary>

```bash
git clone https://github.com/rmst/pinano
./pinano/bin/pinano.js
```

</details>

On first run, Pinano opens the model provider credentials view when no provider is configured. Pinano is currently optimized for use with a ChatGPT subscription.

<details>
<summary>Install and first setup demo</summary>

<p>
<a href="#install"><img src="https://github.com/rmst/pinano/releases/download/readme-assets/install-setup-scripted-960w.gif" alt="Pinano install and first setup demo" width="100%"></a>
</p>

</details>

API keys are also supported. Pinano can import supported API keys from the launch environment. Deployment-level API keys and other settings can also be configured declaratively; see [settings](docs/settings.md).

When you have questions about Pinano itself, asking Pinano is usually best: by default the agent has read-only access to the running Pinano source and documentation.

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
| `/rewind` | rewind to an earlier prompt or switch branch |
| `/branch` | create a new session from the current conversation branch |
| `/context` | show context usage details |
| `/fast on\|off\|status` | toggle Codex Fast mode when supported by the model |

In an open session, type `!cmd` to run a shell command directly. Use `!!cmd` to run it without adding the result to agent context.

Press `Ctrl+V` in the session or overview editor to paste an image from the system clipboard. On Linux this requires `wl-clipboard` (`wl-paste`) or `xclip`.

### Branching and rewind

`/branch` creates a new session from the current conversation point. The original session remains unchanged and both sessions can continue independently.

Press `Esc Esc` on an empty editor to open `/rewind`. You can return to an earlier prompt, switch to another branch tip, and optionally restore files changed through Pinano's edit tools.

## Tool environments

By default, tools run in a native filesystem sandbox on MacOS and Linux. MacOS uses `sandbox-exec`; Linux uses Bubblewrap (`bwrap`). You can optionally configure named local, container, or SSH environments for tool execution.

Sandboxed local environments include the session's starting working directory by default (`useSessionWd: true`). `mountPaths` adds static host paths; relative entries resolve from that starting directory. Pinano fixes this set when the worker starts. Later `cwd` changes are passed to tools but do not add mounts or writable paths. Native workers allow reads from mounted/writable paths plus system, toolchain, Pinano runtime paths, the service-created Pinano runtime source reference, and the environment's tool home, while writes stay restricted to mounted/writable paths, temp directories, and that tool home. Native sandbox workers use a per-environment fake home under `$PINANO_HOME/environments/<environment-id>/home`; `HOME`, XDG roots, temp variables, and Pinano fallback-tool wrappers all point there so tools share state across projects without writing into project directories. On interactive TUI startup, Pinano probes the default local native sandbox first; if Linux `bwrap` is unavailable or unusable, or if MacOS `sandbox-exec` fails, Pinano shows a startup page that retries every 5 seconds and lets you continue by saving `sandbox.type: "none"` for that environment. Non-interactive tool execution still fails closed and tells you how to opt into `sandbox.type: "none"` explicitly.

By default, sandboxed tools only get narrow Pinano state mounts for the current session workspace and runtime source reference. To let tools inspect the full Pinano state directory, set `toolSandbox.pinanoStateMount` in `settings.json` or `default-settings.json` to `"readOnly"`. `"readWrite"` is also supported, but it gives tools direct write access to Pinano's live state and should be treated as a high-trust debugging mode. The setting only affects native sandboxes and Pinano-managed containers; existing containers and SSH targets must provide their own mounts.

<details>
<summary>Environment configuration</summary>

Create `~/.pinano/environments.json` to define explicit environments:

```json
{
	"default": "local",
	"environments": {
		"local": {
			"target": "local",
			"sandbox": {
				"type": "container",
				"image": "ghcr.io/example/pinano-tools:latest",
				"mountPaths": [
					"/Users/me/dev",
					{ "from": "/Users/me/.gitconfig", "to": "/home/node/.gitconfig", "readOnly": true }
				],
				"env": { "GH_TOKEN": "..." },
				"network": "host",
				"extraArgs": ["--add-host", "host.docker.internal:host-gateway"]
			}
		},
		"existing-container": {
			"target": "local",
			"sandbox": {
				"type": "container",
				"engine": "docker",
				"container": "pinano-tools",
				"mountPaths": ["/Users/me/dev"]
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

`target` describes where tools run. `sandbox.type: "native"` uses `sandbox-exec` on MacOS and `bwrap` on Linux. `sandbox.type: "container"` with `image` makes Pinano start and own the container; with `container` it execs into an already-running container whose mounts must already exist. `mountPaths` entries can be strings or objects: a string mounts or allows that host path read/write at the same absolute path; an object uses `{ "from": "<host path>", "to": "<container path>", "readOnly": true }`, with `to` only supported for containers. Native read-only mounts must not be inside a writable mount. On service startup Pinano refreshes a code-only runtime source reference under the Pinano state directory (`$PINANO_HOME/data/services/global/runtime-source/current`); native and Pinano-managed container environments add it as a read-only mount unless an existing mount already covers it. Existing containers and SSH targets must provide their own access if they need that source. Container `env` is passed to managed containers and `docker exec` workers. `network` and `extraArgs` apply only to Pinano-managed containers; prefer typed fields and keep `extraArgs` for Docker/Podman options Pinano does not model yet. `useSessionWd` defaults to `true`; set it to `false` to avoid automatically using and mounting the session's starting working directory. `sandbox.type: "none"` runs without a Pinano sandbox and should be treated as an explicit unsafe opt-out. The legacy `worker` field and legacy `sandbox.paths` field are still accepted for existing configs.

</details>

## Project context

Pinano reads project instructions from `AGENTS.md` or `CLAUDE.md`:

1. Global instructions under `~/.pinano/`.
2. Instructions in ancestor directories of the current working directory.
3. Additional instructions in subdirectories when files there are read or modified.

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
  tui/               ported pi-tui — Markdown renderer restored with vendored marked, east-asian-width vendored
  app/               CLI, service runtime, and terminal app UI
```

## Notes

- The initial version of Pinano was based on [Pi](https://github.com/earendil-works/pi).
- Pinano also runs on the experimental [Qn](https://github.com/rmst/qn) runtime.
