# pinano

Interactive AI assistant TUI. Fork of [pi](https://github.com/earendil-works/pi) with all npm dependencies stripped — pure Node, nothing to install beyond the source.

A few small behavioural tweaks bring it closer to Claude Code (lazy `AGENTS.md`/`CLAUDE.md` loading, `@import` in context files, etc.). See **[COMPARISON.md](./COMPARISON.md)** for the feature-by-feature gap to upstream pi.

> **Status:** experimental, pre-1.0. APIs and CLI flags may change without notice.

## Install & run

Requires **Node ≥ 22.6**. No runtime dependencies.

```bash
npm install -g github:rmst/pinano
pinano
```

Or clone and run without installing:

```bash
git clone https://github.com/rmst/pinano
cd pinano
./bin/pinano.js          # same as `pinano` once installed
npm start                # equivalent
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

Pinano recognizes the following env vars as fallback API keys:

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
| `/quit`, `/exit` | exit pinano |
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

1. **Globals** — `$XDG_CONFIG_HOME/pinano/` (or `$PINANO_HOME/config/`) and `~/.pinano/`.
2. **Ancestors of cwd** — walks up to `/`, one file per dir. cwd's own file has highest priority.
3. **Subdirs on demand** — when a tool touches a path under cwd, any not-yet-loaded `AGENTS.md`/`CLAUDE.md` between cwd and that path is included in the tool's result.

Within a single directory the priority is `AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD`.

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
  tui/               ported pi-tui — markdown.ts dropped, east-asian-width
                     vendored, Intl.Segmenter polyfilled for [qn](https://github.com/rmst/qn)
  app/
    main.ts          entry, args, settings/auth wiring
    chat-mode.ts     transcript + editor + slash dispatch + footer
    slash-commands.ts registry
    commands/        simple/, overlays/, compact/, branching/
    components/      footer, keybind-hints, picker, prompt-input
    auth.ts          multi-provider credential store
    models.ts        curated model registry
    settings.ts      $XDG_CONFIG_HOME/pinano/settings.json
    session-store.ts wraps Session for app-level open/list/resume/index
    compaction.ts    auto-summarize older messages near context limit
```

## Notes / caveats

- **Runs on both [qn](https://github.com/rmst/qn) and Node.**
- **Zero runtime dependencies.** `get-east-asian-width` is vendored under `src/tui/utils-vendor/` with its upstream LICENSE preserved.
- **No markdown rendering, no syntax highlighting, no image processing** — explicitly out of scope per [COMPARISON.md](./COMPARISON.md).
- **Session state lives in `$XDG_DATA_HOME/pinano/`.** Override the whole config+data root with `$PINANO_HOME`.
