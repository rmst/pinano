# Pinano

(<i>experimental</i>)

Interactive AI coding agent harness (terminal ui). Fork of [Pi](https://github.com/earendil-works/pi) with:

- **No npm dependencies.** Pure Node, nothing to install beyond the source.
- **No build step.** Plain JS with JSDoc types throughout — same type-checking story as the TS source it was ported from, but no transform/compile step.

This avoids relying on [wonky supply chains](https://simonramstedt.com/blog/2026-04-09-wonky-software-supply-chains/).

A few small behavioural tweaks bring it closer to Claude Code (lazy `AGENTS.md`/`CLAUDE.md` loading, `@import` in context files, etc.). See **[comparison.md](./comparison.md)** for the feature-by-feature gap to upstream Pi.

## Install & run

Requires **Node ≥ 22.6**. No runtime dependencies.

```bash
npm install -g github:rmst/pinano
pinano
```

Or clone and run without installing:

```bash
git clone https://github.com/rmst/pinano
node pinano/bin/pinano.js
```

Usage:

```bash
pinano                                                  # fresh session, model from settings.json
pinano -r                                               # open the resume picker on startup
pinano --baseurl http://localhost:8080/v1 --model local # local llama.cpp / openai-compat host
pinano -p "summarize README.md"                         # print mode: single-shot, exit
pinano --mode json "do this"                            # print mode: one JSON event per line
pinano --help
```

Auth on first run: type `/login` in the TUI.

Pinano recognizes the following env vars as API keys:

- `OPENAI_API_KEY`
- `LLAMACPP_API_KEY`
- `MOONSHOT_API_KEY`
- `DEEPSEEK_API_KEY`

For ChatGPT subscriptions, `/login openai-codex` opens a PKCE OAuth flow; tokens are refreshed on demand.

## In-app slash commands

Type `/` to autocomplete. The full list (also via `/help`):

| Command | What it does |
|---|---|
| `/help` | list commands |
| `/hotkeys` | show keyboard shortcuts |
| `/quit`, `/exit` | exit Pinano |
| `/clear` | clear the on-screen transcript (history is preserved) |
| `/new` | start a new session for the current cwd |
| `/resume` | session picker for the current cwd |
| `/sessions` | print sessions list for the current cwd |
| `/session` | show metadata for the active session |
| `/name <text>` | name the active session |
| `/model` | model selector |
| `/scoped-models` | toggle which models cycle on Ctrl+P |
| `/thinking [level]` | switch reasoning effort (off/minimal/low/medium/high) |
| `/compact` | summarize older messages into a single compaction note |
| `/fork` | fork from a previous user message in this session |
| `/clone` | duplicate the session at the current point |
| `/tree` | switch to a different branch (leaf) of the session tree |
| `/login` | OpenAI API key entry or Codex OAuth |
| `/logout [provider]` | drop a stored credential |
| `/copy` | copy last assistant message to clipboard (OSC 52) |
| `/cwd` | print current working directory |
| `/system` | print the current system prompt |
| `/reload` | rebuild session index, reload settings |
| `/settings` | overlay UI for settings.json (model, thinking, autoResume, threshold, scoped models, doubleEscapeAction) |

Bash shortcut: type `!cmd` (e.g. `!ls`) to run a shell command directly without an LLM round-trip — output is appended to the transcript and to context. `!!cmd` does the same but excludes the result from agent context.

Rewind: press `Esc Esc` on an empty editor to roll back to a previous user message. Defaults to opening `/fork` — pick a past user message, then choose `Rewind` or `Rewind with branch summary` (one-shot LLM summary of the discarded tail attached at the new leaf). Either way the picked message is dropped back into the editor so you can edit and re-send. Set `doubleEscapeAction` to `tree` for the leaf picker instead, or `none` to disable.

## Project context (AGENTS.md / CLAUDE.md)

Pinano auto-discovers `AGENTS.md` (or `CLAUDE.md` as fallback) at session start. Three passes:

1. **Globals** — `~/.pinano/`.
2. **Ancestors of cwd** — walks up to `/`, one file per dir. cwd's own file has highest priority.
3. **Subdirs on demand** — when a tool touches a path under cwd, any not-yet-loaded `AGENTS.md`/`CLAUDE.md` between cwd and that path is included in the tool's result.

Within a single directory the priority is `AGENTS.md > CLAUDE.md`.

Edits only apply to **new** sessions; resume replays the captured context verbatim.

### `@import`

A line whose only non-whitespace content is `@<path>` is replaced with that file's contents (recursive, max 5 levels). Relative paths resolve against the importing file; `~/` expands to `$HOME`. Only line-based imports — `@anthropic-ai/sdk` or `@deprecated` in prose is left alone.

```
# project rules
see also: @./conventions.md
@~/.pinano/personal-style.md
```

## Layout

```
src/
  agent-core/        AgentLoop + Agent (streamFn-driven), JSDoc types
  ai-apis/           zero-dep OpenAI Chat-Completions / Responses / Codex clients
  tools/             read, write, edit, bash, ls, grep, find
  session-manager/   JSONL + in-memory storage, parent-link tree
  tui/               ported pi-tui — markdown.js dropped, east-asian-width
                     vendored, Intl.Segmenter polyfilled for [qn](https://github.com/rmst/qn)
  app/
    main.js          entry, args, settings/auth wiring
    chat-mode.js     transcript + editor + slash dispatch + footer
    slash-commands.js registry
    commands/        simple/, overlays/, compact/, branching/
    components/      footer, keybind-hints, picker, prompt-input
    auth.js          multi-provider credential store
    models.js        curated model registry
    settings.js      $XDG_CONFIG_HOME/pinano/settings.json
    session-store.js wraps Session for app-level open/list/resume/index
    compaction.js    auto-summarize older messages near context limit
```

## Notes

- If you don't like Node.js, Pinano also runs on our experimental hyper-minimalist [Qn](https://github.com/rmst/qn) runtime.
- **No markdown rendering, no syntax highlighting, no image processing** — explicitly out of scope per [comparison.md](./comparison.md).
