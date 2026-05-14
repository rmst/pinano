#!/usr/bin/env node
// pinano — interactive AI assistant TUI.
//
// Usage:
//   pinano [--cwd DIR] [--model ID] [--baseurl URL] [--no-resume]
//
// Auth: API key from $OPENAI_API_KEY or stored via /login. Codex (ChatGPT
// subscription) credentials are obtained via /login (PKCE OAuth) and
// refreshed on demand.

import { join, resolve } from "node:path"

import { refreshCodex, streamCodex } from "../ai-apis/codex/index.js"
import { streamSimple as openaiStreamSimple } from "../agent-core/index.js"
import { Agent } from "../agent-core/agent.js"
import { createDefaultTools } from "../tools/index.js"
import { runChat } from "./chat-mode.js"
import { resolveApiKey, getCredential, updateCredential } from "./auth.js"
import { availableModelEntries, modelEntryMatches, modelRef, resolveModel, findModelEntry } from "./models.js"
import { loadSettings } from "./settings.js"
import { sessionsDir } from "./paths.js"
import { LazyContextLoader, formatLazyContextNotice, extractToolPath } from "./lazy-context.js"
import { buildProjectContextMessage, ensureProjectContextMessage } from "./project-context.js"
import {
	createSession,
	getLatestForCwd,
	openSession,
	reconcileIndex,
	resolveSessionArg,
} from "./session-store.js"
import { SlashCommandRegistry } from "./slash-commands.js"
import { registerSimpleCommands } from "./commands/simple.js"
import { registerOverlayCommands } from "./commands/overlays.js"
import { compactCommand } from "./commands/compact.js"
import { registerBranchingCommands } from "./commands/branching.js"
import { compact, shouldCompact } from "./compaction.js"
import { runPrintMode } from "./print-mode.js"
import { runRpcMode } from "./rpc-mode.js"
import { installStderrCapture } from "./stderr-capture.js"

/**
 * @typedef {object} Args
 * @property {string} cwd
 * @property {boolean} cwdExplicit
 * @property {string} [model]
 * @property {string} [baseUrl]
 * @property {boolean} resume
 * @property {string} [session]
 * @property {boolean} help
 * @property {boolean} print
 * @property {"text" | "json" | "rpc"} mode
 * @property {string[]} messages
 * @property {boolean} noContextFiles
 */

/**
 * @param {string[]} argv
 * @returns {Args}
 */
function parseArgs(argv) {
	/** @type {Args} */
	const args = {
		cwd: process.cwd(),
		cwdExplicit: false,
		baseUrl: process.env.OPENAI_BASE_URL,
		resume: false,
		help: false,
		print: false,
		mode: "text",
		messages: [],
		noContextFiles: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--cwd") {
			args.cwd = resolve(argv[++i])
			args.cwdExplicit = true
		}
		else if (arg === "--model") args.model = argv[++i]
		else if (arg === "--baseurl") args.baseUrl = argv[++i]
		else if (arg === "-r" || arg === "--resume") args.resume = true
		else if (arg === "--session") args.session = argv[++i]
		else if (arg === "--help" || arg === "-h") args.help = true
		else if (arg === "--no-context-files") args.noContextFiles = true
		else if (arg === "-p" || arg === "--print") {
			args.print = true
			const next = argv[i + 1]
			if (next !== undefined && !next.startsWith("-")) {
				args.messages.push(next)
				i++
			}
		} else if (arg === "--mode") {
			const next = argv[++i]
			if (next === "text" || next === "json" || next === "rpc") args.mode = next
			else {
				console.error(`Invalid --mode "${next}". Use "text", "json", or "rpc".`)
				process.exit(2)
			}
		} else if (!arg.startsWith("-")) {
			args.messages.push(arg)
		}
	}
	// `--mode json` implies print mode (matches pi).
	if (args.mode === "json") args.print = true
	if (args.session && args.resume) {
		console.error("--session and --resume are mutually exclusive.")
		process.exit(2)
	}
	return args
}

function printHelp() {
	console.log(
		[
			"pinano — interactive AI assistant",
			"",
			"Usage:",
			"  pinano [options] [prompt...]",
			"  pinano -p \"do this\"           # non-interactive single-shot",
			"  pinano --mode json \"do this\"  # JSON event stream",
			"",
			"Options:",
			"  --cwd DIR       working directory the agent operates in (default: $PWD)",
			"  --model ID      model id (e.g. gpt-5.5, gpt-5.3-chat-latest, kimi-k2.6). Overrides settings.",
			"  --baseurl URL   override the API base URL (for local llamacpp / openai-compat)",
			"  -r, --resume    open a session picker on startup (default: start a new session)",
			"  --session ARG   open a specific session — file path or session-id prefix (no picker)",
			"  -p, --print     non-interactive: send prompt(s) and exit (text output)",
			"  --mode MODE     'text' (default print output), 'json' (print event stream), or 'rpc' (headless JSON-line server)",
			"  --no-context-files  skip AGENTS.md / CLAUDE.md discovery (startup + lazy)",
			"",
			"In-app slash commands (try /help): /quit /model /thinking /resume /new /session",
			"  /name /login /logout /sessions /settings /clear /copy /reload /hotkeys",
		].join("\n"),
	)
}

/**
 * Build a streamFn that:
 *   - uses streamCodex when the active model is openai-codex (auto-refreshes the OAuth token)
 *   - uses the OpenAI Chat Completions stream otherwise (resolves the API key per call)
 */
function buildStreamFn() {
	/** @type {any} */
	let codexCreds
	return async (/** @type {any} */ model, /** @type {any} */ ctx, /** @type {any} */ options) => {
		if (model.provider === "openai-codex") {
			if (!codexCreds) codexCreds = await getCredential("openai-codex")
			if (!codexCreds) throw new Error("No Codex credentials. Run /login to set them up.")
			if (codexCreds.expiresAt && codexCreds.expiresAt - Date.now() < 60_000) {
				const fresh = await refreshCodex(codexCreds.refresh)
				codexCreds = await updateCredential("openai-codex", () => ({
					kind: "codex",
					access: fresh.access,
					refresh: fresh.refresh,
					idToken: /** @type {any} */ (fresh).idToken,
					accountId: fresh.accountId,
					expiresAt: fresh.expires,
					createdAt: Date.now(),
				}))
			}
			return streamCodex(model, ctx, { ...options, apiKey: codexCreds.access })
		}
		const apiKey = (await resolveApiKey(model.provider)) ?? options.apiKey
		return openaiStreamSimple(model, ctx, { ...options, apiKey })
	}
}

/**
 * @param {string} cwd
 * @returns {string}
 */
function systemPromptFor(cwd) {
	const now = new Date()
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`

	// Minimal pi-shape prompt — mirrors what pi's system-prompt.ts produces
	// for the same tool set. Pi traces (incl. gpt-5.3-codex) emit clean tool
	// calls under this exact structure, so this is the known-good baseline.
	// If we want to add agentic norms back, do it incrementally on top.
	const base = `You are an expert coding assistant operating inside pinano, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- write: Create or overwrite files
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- bash: Execute bash commands (ls, grep, find, etc.)
- grep: Search file contents for patterns (respects .gitignore)
- find: Find files by glob pattern (respects .gitignore)
- ls: List directory contents

Guidelines:
- Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)
- Use read to examine files instead of cat or sed.
- Use write only for new files or complete rewrites.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Be concise in your responses
- Show file paths clearly when working with files
- For reversible actions (reads, edits to tracked files, running tests), just do them — don't preview intent ("I can check…", "If you want, I'll look…", "Let me…"). Save confirmation for actions that can't be cleanly undone: destructive deletes, \`git reset --hard\`, force-push, pushing to remotes, modifying CI/CD, dropping data.`

	let prompt = base
	prompt += `\n\nCurrent date: ${date}`
	prompt += `\nCurrent working directory: ${cwd}`
	return prompt
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	if (args.help) {
		printHelp()
		return
	}

	const settings = await loadSettings()
	const availableModels = args.model ? [] : await availableModelEntries()
	const configuredModel = availableModels.find((m) => modelEntryMatches(m, settings.model))
	const modelId = args.model ?? (configuredModel ? settings.model : (availableModels[0] ? modelRef(availableModels[0]) : settings.model))
	const model = resolveModel(modelId, { baseUrl: args.baseUrl })

	// Resolve --session up-front so its stored cwd can drive the agent's
	// system prompt / context-file lookup. An explicit --cwd still wins.
	/** @type {{ session: any, id: string, cwd: string, path: string } | undefined} */
	let preResolved
	if (args.session) {
		try {
			preResolved = await resolveSessionArg(args.session)
		} catch (err) {
			console.error(/** @type {any} */ (err)?.message ?? err)
			process.exit(2)
		}
		if (!args.cwdExplicit) args.cwd = preResolved.cwd
	}

	// Lazy loader picks up AGENTS.md/CLAUDE.md from subdirs of cwd as the agent
	// touches files there. The set is hydrated on each tool call from message
	// history — including the startup project-context user message — so we
	// don't need to seed it here.
	const lazyContext = new LazyContextLoader({
		cwd: args.cwd,
		alreadyLoaded: [],
	})

	const agent = new Agent({
		initialState: {
			model,
			thinkingLevel: /** @type {any} */ (settings.thinkingLevel),
			systemPrompt: systemPromptFor(args.cwd),
			tools: createDefaultTools(args.cwd),
		},
		streamFn: buildStreamFn(),
		// Auto-compact older messages just before each LLM call when usage is high.
		transformContext: async (messages, signal) => {
			// Bail before the (potentially slow) compaction API call if the user
			// already pressed Esc — the loop will check signal.aborted on return
			// and exit cleanly.
			if (signal?.aborted) return messages
			if (!shouldCompact(agent, settings.autocompactThreshold)) return messages
			try {
				await compact(agent, undefined, signal)
			} catch (err) {
				// Surface failures via /log — silent swallowing here historically
				// masked the case where the prefix to summarize was itself too big
				// for one API call, leaving an un-compacted (oversize) request to
				// go out and 400 instead.
				console.error("autocompact failed:", err instanceof Error ? err.message : err)
			}
			return agent.state.messages
		},
		afterToolCall: async (ctx) => {
			if (args.noContextFiles) return undefined
			// Hydrate from replayed history every call: idempotent, and handles
			// mid-session `/resume` swaps where agent.state.messages changes
			// without our knowledge.
			lazyContext.hydrateFromMessages(ctx.context.messages)
			const path = extractToolPath(ctx.toolCall.name, ctx.args)
			if (!path) return undefined
			const newFiles = lazyContext.loadForPath(path)
			if (newFiles.length === 0) return undefined
			return {
				content: [
					...(ctx.result.content ?? []),
					{ type: "text", text: formatLazyContextNotice(newFiles) },
				],
			}
		},
	})

	// Print mode is normally hermetic (no session creation, no index work).
	// With --session we make an exception: load the session's history as
	// context and append the new turn back to its file — the user explicitly
	// pointed at it.
	if (args.print) {
		if (preResolved) {
			// Inject project context into the session if not already there (legacy
			// upgrade path). For freshly-created sessions opened via `--session`
			// pointing at an empty file this also handles the first-time inject.
			if (!args.noContextFiles) await ensureProjectContextMessage(preResolved.session, args.cwd)
			agent.state.messages = /** @type {any} */ (preResolved.session.getMessages())
			agent.subscribe(async (event) => {
				if (event.type === "message_end") {
					try { await /** @type {NonNullable<typeof preResolved>} */ (preResolved).session.appendMessage(/** @type {any} */ (event.message)) } catch {}
				}
			})
		} else if (!args.noContextFiles) {
			// Hermetic print mode (no session). Push the project-context user
			// message directly into agent state so the model still sees it.
			const ctxMsg = buildProjectContextMessage(args.cwd)
			if (ctxMsg) agent.state.messages = [ctxMsg]
		}
		const code = await runPrintMode(agent, { mode: args.mode, messages: args.messages })
		process.exit(code)
	}

	// Setup that's shared by interactive and RPC modes — both want a real
	// session on disk and a clean index.
	await reconcileIndex()

	// Session selection at boot:
	//   --session     → open the resolved session directly (skip picker / autoResume)
	//   -r            → start fresh, then open the picker (handled in onReady)
	//   autoResume on → if a most-recent session exists for this cwd, open it
	//   else          → start fresh
	/** @type {{ session: any, id: string }} */
	let opened
	if (preResolved) {
		opened = { session: preResolved.session, id: preResolved.id }
	} else if (!args.resume && settings.autoResume) {
		const latestId = await getLatestForCwd(args.cwd)
		opened = latestId ? await openSession(latestId) : await createSession(args.cwd)
	} else {
		opened = await createSession(args.cwd)
	}

	// Inject the project-context user message on first session creation, or
	// upgrade a legacy session that doesn't yet have one. On resume of a
	// session that already has the message, this is a no-op (freeze).
	// Skipped under --no-context-files for diagnostic runs.
	if (!args.noContextFiles) await ensureProjectContextMessage(opened.session, args.cwd)

	if (args.mode === "rpc") {
		await runRpcMode({
			agent,
			session: opened.session,
			sessionId: opened.id,
			// Honour the resolved file path when it's outside `sessionsDir()`
			// (the user pointed at an arbitrary path via --session).
			sessionFile: preResolved?.path ?? join(sessionsDir(), `${opened.id}.jsonl`),
			cwd: args.cwd,
			baseUrlOverride: args.baseUrl,
		})
		return
	}

	const commands = new SlashCommandRegistry()
	registerSimpleCommands(commands)
	registerOverlayCommands(commands)
	commands.register(compactCommand)
	registerBranchingCommands(commands)

	// Capture process stderr so qn/JS error messages don't get swallowed by the
	// TUI's alternate screen buffer. Surfaced in the footer + via `/log`.
	const stderrCapture = installStderrCapture()

	const entry = findModelEntry(modelId)
	const hello = `pinano ready — ${entry?.displayName ?? modelId} | thinking=${settings.thinkingLevel} | session=${opened.id.slice(0, 8)}. /help, Ctrl+C to abort/exit.`

	await runChat({
		agent,
		session: opened.session,
		sessionId: opened.id,
		hello,
		commands,
		baseUrlOverride: args.baseUrl,
		stderrCapture,
		onReady: args.resume
			? async (ctx) => {
					// Auto-trigger the resume picker. If no sessions exist for this cwd
					// the resume command prints a friendly message and we stay in the
					// fresh session.
					const cmd = commands.get("resume")
					if (cmd) await cmd.handler(ctx, "")
				}
			: undefined,
	})
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
