# pinano vs [pi](https://github.com/earendil-works/pi)

pinano is a deliberately slimmed-down port. We drop many of pi's features to keep the code small (~3k LOC vs ~50k+ in pi-coding-agent's interactive mode), self-contained (no npm), and runnable on both Node and qn.

Last synced against pi @ [`3d5cbe98`](https://github.com/earendil-works/pi/commit/3d5cbe98) (v0.74.0-69, dated 2026-05-08).

`[x]` = pinano has parity (or close enough). `[ ]` = pi has it, pinano doesn't. `[+]` = pinano-only addition (pi doesn't have it).

## Sessions
- [x] `Session` library (JSONL storage, parent-pointer tree, in-memory variant)
- [x] Wire `Session` into `main.ts` — open/create on start, append every message
- [x] `/resume` — pick a different session (per-cwd list); `pinano -r` opens it on startup
- [x] `/new` — start a fresh session (in-process, no exit)
- [x] `/name` — set the current session's display name
- [x] `/session` — show metadata (id, name, msg count)
- [x] `/sessions` — list all sessions for the current cwd
- [x] `/fork`, `/clone` — branch off from a previous user message / current point
- [x] `/tree` — branch navigator (switch to any leaf)
- [x] Session picker (used by `/resume`) — inline full-width, showing first message + last user message per session
- [x] In-process session switching — `/new` and `/resume` mutate state without restart
- [x] Default = no auto-resume (use `-r` to opt in)
- [x] Auto-clean empty / never-used sessions (reconcileIndex prunes; chat-mode drops on session swap)
- [x] `--session <path|id>` — open a specific session non-interactively (file path, or unique session-id prefix); also works with `-p`
- [ ] `--continue` / `-c` — open the most-recent session non-interactively (vs the `-r` picker)
- [ ] `--no-session` ephemeral-mode flag (pinano always persists when not in print mode)
- [ ] `--fork <path|id>` startup fork (pinano has `/fork` and `/clone` slash commands only)

## Compaction
- [x] Auto-compact when token count crosses `settings.autocompactThreshold`
- [x] `/compact` — manual trigger
- [x] Branch-summary on fork (one-shot LLM summary of the discarded branch, attached at the new leaf — opt-in via the second `/fork` prompt)

## Settings
- [x] `settings.json` (model, thinking level, scoped model ids, autocompact threshold) under `$XDG_CONFIG_HOME/pinano/` (or `$PINANO_HOME/config/`)
- [x] `--baseurl`/`--model` CLI overrides; `/model` preserves the runtime baseurl
- [x] `/settings` — overlay UI to toggle/edit (model, thinking, autoResume, threshold, scoped models, doubleEscapeAction)
- [x] `doubleEscapeAction` — Esc Esc on empty editor opens `/fork` (default — list past user messages, pick one to rewind to, optionally summarize the discarded tail) or `/tree` (leaf picker); `none` disables the keybind
- [ ] Per-project settings overrides
- [ ] `--system-prompt` / `--append-system-prompt` CLI overrides (replace or extend `systemPromptFor()`)
- [ ] Steering mode / follow-up mode — queue messages while the agent is busy. Pi: pressing Enter mid-stream queues a "steering" nudge; a separate hotkey queues a follow-up. Pinano currently has no message queue, so Enter mid-stream is a no-op. Adding it is moderate (~300–500 LOC across `agent-core` queue primitives, chat-mode wiring, and a `pendingMessagesContainer` above the editor).
- [ ] `Hide thinking` setting (toggle thinking-block rendering)
- [ ] Image settings — `image.show` (toggle whether tool-result image attachments are sent to the model), `image.autoResize` (resize to 2000×2000 max before send), `image.widthCells` (terminal render width). Pinano always sends; no resize.

## Auth (OpenAI ecosystem only)
- [x] Multi-provider credential store under `$config/auth/<provider>.json` with file lock
- [x] OpenAI API key — stored via `/login openai`; env-var fallback (`OPENAI_API_KEY`)
- [x] Codex (ChatGPT subscription) OAuth — full PKCE flow via `/login openai-codex`
- [x] Codex token refresh on demand (auto-refresh near expiry)
- [x] `/logout [provider]` — drop a stored credential
- [ ] Anthropic, Gemini, Copilot, Groq, OpenRouter (won't add)

## Model registry
- [x] Curated registry: OpenAI cloud (gpt-5.3+), Codex via ChatGPT OAuth (`openai-codex/gpt-5.3+`, legacy `gpt-5.5-codex` / `gpt-5.4-codex` / `gpt-5.3-codex` settings still resolve), llamacpp, Kimi K2.x, DeepSeek V4. Numbers backfilled from pi's `models.generated.ts`.
- [x] `--baseurl` and `--model` overrides; `/model` switch keeps the override (regression-tested)
- [x] `/scoped-models` toggle list
- [ ] `Ctrl+P` keybind to cycle through scoped models
- [ ] `--list-models [search]` CLI (fuzzy registry lookup without booting the TUI)

## Slash commands
- [x] `/quit`, `/exit`, `/new`, `/clear`, `/help`, `/hotkeys`, `/reload`
- [x] `/model`, `/scoped-models`, `/thinking`
- [x] `/login`, `/logout`
- [x] `/copy` — copy last assistant message via OSC 52
- [x] `/name`, `/session`, `/sessions`, `/resume`, `/fork`, `/clone`, `/tree`, `/compact`
- [x] `/cwd`
- [x] Slash-command autocomplete via the TUI's `CombinedAutocompleteProvider`
- [x] `!cmd` / `!!cmd` bash mode (run shell directly without LLM round-trip; `!!` excludes from context)
- [ ] `/export`, `/import`, `/share` (won't add)

## TUI components
- [x] Layout: chat container above; spacer + keybinding hints + editor + footer anchored at bottom
- [x] Footer: model | thinking | session name | tokens | cost | context %
- [x] Keybinding hints strip above the editor
- [x] Model / thinking / session-picker / login overlays
- [x] Bracketed-paste with prefix/suffix typing + paste-token expansion on submit (verified by `smoke-paste.mjs`)
- [x] Theme defines all `SelectListTheme` callables (regression: typing `/` no longer crashes)
- [x] `Intl.Segmenter` polyfill so the TUI runs on qn
- [x] Pi-style message rendering — user messages in a colored Box (`userMessageBg`) with paddingY=1 for breathing room, tool execution in pending → success/error boxes, thinking blocks italic in `thinkingText` color. Components in `src/app/components/messages.ts`.
- [x] Concise per-tool call formatting (`read /etc/hosts`, `$ npm test`, `grep TODO src/`) for `read`/`write`/`edit`/`bash`/`ls`/`grep`/`find` — same look as pi. Unknown tools fall back to a JSON arg dump. Lives in `src/app/components/tool-format.ts`. (We deliberately don't ship per-tool result widgets — diffs, syntax-highlighted source, etc. — see "Per-tool render widgets" row.)
- [x] Tool result lines truncate to 12 with a `… +N more` footer so a chatty bash command doesn't push the editor off-screen.
- [x] Pi-style rewind picker — **tree-aware** (├─/└─/│ connectors show where past rewinds branched the conversation), `•` marker for entries on the current active branch (siblings on discarded branches dim out). Filters to user messages only — pi's full TreeSelectorComponent shows all entry types (assistant/tool/custom) which is too noisy for "pick something to rewind to". Renders **full-width in place of the editor** via the chat-mode `showSelector` swap (pi pattern), not as a centered modal overlay. Component in `src/app/components/user-message-selector.ts`; sequencing helper for the second-tier mode prompt in `src/app/components/inline-picker.ts`.
- [x] After `/fork` rewinds, the new branch's messages are replayed into the transcript (via the new `ctx.replaySession`) — without it, the user saw an empty transcript and lost track of what context survived the rewind.
- [ ] Per-tool render widgets — read shows highlighted source, edit shows colored diff inline, bash streams output (won't add — stringify is fine)
- [ ] Inline diff viewer (won't add)
- [ ] Bracketed-paste preview UI — toggle marker open/closed inline before submit (the *actual* pasting works, this is just the preview)
- [ ] Markdown rendering / syntax highlighting (won't add)
- [ ] Image rendering (Kitty / iTerm2) (won't add)
- [ ] Multi-theme system (won't add)
- [ ] Drag-and-drop file attach (the editor's "drop files to attach" path)
- [ ] `@file` / `@image` initial mentions in CLI args (`pinano @prompt.md @img.png "..."` — pre-load file/image content into the first message)

## Modes
- [x] Interactive (the default)
- [x] Print mode — `pinano -p "do this"` text output, `--mode json "do this"` event stream. See `src/app/print-mode.ts`.
- [x] RPC mode — JSON-line stdin/stdout protocol (`--mode rpc`). Pi-compatible command/response shape; pi commands without an underlying pinano surface yet are kept as comments in `src/app/rpc-types.ts` so future ports can just uncomment. Ported from a slightly older pi snapshot (`5133697b`, v0.52.12, 2026-02-16) than the rest of this comparison — the only meaningful gap vs. current pi is the recently-added `clone` command, easy to add later. Currently dropped: `bash` / `abort_bash` (in scope for a future port — pinano's `!cmd` shortcut is a slash UI feature, not an RPC surface), `get_commands` (no extensions / skills / prompt templates yet), `set_auto_compaction` (always-on), `set_auto_retry` / `abort_retry` (no retry feature), `export_html` (won't add), the `extension_ui_*` family (won't add). `compact`'s `customInstructions` field is parsed but ignored until the parallel `summarizeMessages` refactor is wired through.

## Context files
- [x] AGENTS.md / CLAUDE.md auto-discovery (walks cwd → root, plus globals under `configRoot()` and `~/.pinano/`)
- [+] **Delivered as a user message, not a system-prompt block** — pinano diverges from pi here. Pi puts AGENTS.md content inside the system prompt under `# Project Context`. Pinano injects a synthetic user-role message at session creation, wrapped Codex-style (`# AGENTS.md / CLAUDE.md context for <cwd>\n<INSTRUCTIONS>...</INSTRUCTIONS>`), and persists it to the session's JSONL. This matches Codex CLI (`context/user_instructions.rs`, `session/mod.rs:2717`) and Claude Code (per their memory.md docs). Benefit: AGENTS.md edits don't invalidate the system-prompt cache; system prompt holds agent identity, user message holds user/project preferences. See `src/app/project-context.ts`. The synthetic message is treated as internal metadata: filtered out of the visible chat transcript, the `(resumed session …)` hint, `/session`'s message count, `/resume`'s previews, `sessionIsEmpty`, and `reconcileIndex` — so a fresh session looks fresh even when AGENTS.md is non-trivial.
- [+] **Freeze on resume** — the project-context message is replayed verbatim from session JSONL, not re-read from disk. Edits to AGENTS.md only apply to new sessions. Matches Codex's `rollout_reconstruction.rs`; diverges from pi's re-read-every-startup model. Legacy sessions without the marker get a one-time upgrade injection on first open.
- [+] **Lazy subdir loading** — pinano-only, matches Claude Code. When a path-bound tool (`read`/`write`/`edit`/`ls`/`grep`/`find`) touches a path under cwd, pinano walks from that path up to cwd and injects any not-yet-loaded `AGENTS.md`/`CLAUDE.md` into the tool result under `# Additional project context (loaded on demand)`. Pi only loads at startup. On resume, lazy-loaded files are detected in replayed history and not re-injected — frozen in place. See `src/app/lazy-context.ts`.
- [+] **`@import` syntax inside context files** — pinano-only, matches Claude Code. A line whose only non-whitespace content is `@<path>` is replaced with that file's contents (max 5 levels deep, with cycle detection). Pi has no equivalent. See `src/app/context-imports.ts`.
- [ ] `--no-context-files` CLI flag (pi has it; trivial to add later)
- [ ] `SYSTEM.md` / `APPEND_SYSTEM.md` discovery under `.pi/` (won't add for now — keep `systemPromptFor` hardcoded)

## Tools
- [x] Built-in suite: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`
- [x] `read` returns image content for png/jpg/gif/webp (magic-byte sniff in `src/tools/mime.js`; full file as base64). The downstream ai-apis pipeline downgrades image blocks to a placeholder when the active model isn't vision-capable.
- [ ] Image auto-resize before send (pi resizes images >2000×2000 via `sharp`; pinano sends raw bytes — agent can use `bash` to resize if needed)
- [ ] `--tools <allowlist>` / `--no-tools` / `--no-builtin-tools` (restrict which tools the agent can call — useful for read-only or scoped sessions)
- [ ] Auto-retry with backoff on transient stream failures (pi has `auto_retry_start/end` events with configurable max retries / base delay)

## Skills / extensions / package manager
- [ ] Skills system (SKILL.md auto-discovery) — won't add
- [ ] Extensions / plugin system — won't add
- [ ] `pi pkg ...` package manager — won't add
- N/A `--offline` / `PI_OFFLINE` — pi's flag suppresses startup network ops (version check, registry fetch, package updates). Pinano has none of those, so the flag has no work to do.

## Test coverage today

- 211 unit tests across `agent-core/`, `tools/`, `session-manager/`, `app/` (settings, auth, models, session-store, render-message, slash-commands, branching, compaction, login, model-command, rpc, theme, context-files).
- 6 tmux end-to-end smokes:
  - `smoke-tui` — TUI rendering with a scripted streamFn
  - `smoke-openai` — full real-flow: qn → main.ts → ai-apis → fetch → mock OpenAI HTTP server → SSE → TUI
  - `smoke-commands` — slash-command UI, autocomplete, overlays, footer updates
  - `smoke-login` — `/login openai` end-to-end, credential file shape on disk
  - `smoke-sessions` — default-no-resume, `/new` in-process, `-r` picker on startup
  - `smoke-paste` — bracketed-paste with prefix/suffix typing; large-paste marker expansion on submit

## Notes on the port

- **Runtime targets.** pinano runs on both **qn** and **Node** (`--experimental-transform-types`). Tests run on Node only because qn's `node:test` shim doesn't yet take callback-style tests.
- **TUI.** Bulk-copied from pi-tui, then: dropped `components/markdown.ts` (and `marked`); vendored `get-east-asian-width` under `src/tui/utils-vendor/` with the upstream LICENSE; rewrote `.js` import extensions to `.ts` for Node's strip-types resolver; added a tiny `Intl.Segmenter` polyfill so the TUI runs on qn.
- **Tools.** Reimplemented leaner. Some pieces near-verbatim (truncation, edit's fuzzy-match, line-ending detection); pi's heavy `ToolDefinition` surface (`renderCall`/`renderResult`/etc.) and syntax-highlighting concerns are dropped. Image MIME detection is a 25-line magic-byte sniffer (no `file-type` dep) and we don't auto-resize. Pi: ~3.9k LOC, pinano: ~1.2k LOC.
- **Session manager.** Reimplemented leaner. Pi's `compaction`, `model_change`, `branch_summary`, `custom_message`, `thinking_level_change` entry types dropped — we keep `message`, `label`, `session_info`, `custom`. Pi: ~750 LOC, pinano: ~400 LOC.
- **App glue.** Fresh code (~600 LOC) instead of pi-coding-agent's ~22k LOC interactive mode + ~30 components.
- **ai-apis quirks.** `src/ai-apis/sse.js` byte-buffers at event boundaries (qn's TextDecoder rejects `{ stream: true }`).
- **API surface.** `src/ai-apis/` speaks both `/v1/chat/completions` and `/v1/responses`; the `stream`/`complete` exports dispatch on `model.transport`. gpt-5.x reasoning models are flagged `transport: "responses"` because OpenAI rejects tools+reasoning_effort on Chat Completions for that family. Everything else (gpt-5.3-chat-latest, kimi, deepseek, llama.cpp) stays on Chat Completions.
