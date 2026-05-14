// RPC mode: headless operation with a JSON-line stdin/stdout protocol.
//
// Ported from pi-mono `coding-agent/src/modes/rpc/rpc-mode.ts`. Pinano lacks
// pi's AgentSession + extensions surface, so the dispatcher talks directly to
// `Agent` plus session-store helpers. Commands pinano can't fulfil yet (bash,
// extension UI, get_commands, …) are listed in rpc-types.js as comments so a
// future port can just uncomment.
//
// I/O is parameterized — tests pass PassThrough streams instead of stdio.

import * as readline from "node:readline"
import { join } from "node:path"

import { compact } from "./compaction.js"
import { cycleModelId, cycleThinkingLevel } from "./cycle.js"
import { MODEL_REGISTRY, availableModelEntries, buildModel, resolveModel } from "./models.js"
import { sessionsDir } from "./paths.js"
import {
	createSession,
	openSession,
	setSessionName as persistSessionName,
	touchSession,
} from "./session-store.js"
import { loadSettings } from "./settings.js"
import { ensureProjectContextMessage } from "./project-context.js"

/** @typedef {import("../agent-core/agent.js").Agent} Agent */
/** @typedef {import("../session-manager/index.js").Session} Session */
/** @typedef {import("node:stream").Readable} Readable */
/** @typedef {import("node:stream").Writable} Writable */
/** @typedef {import("./rpc-types.js").RpcCommand} RpcCommand */
/** @typedef {import("./rpc-types.js").RpcResponse} RpcResponse */
/** @typedef {import("./rpc-types.js").RpcSessionState} RpcSessionState */

/**
 * @typedef {object} RpcModeOptions
 * @property {Agent} agent
 * @property {Session} session
 * @property {string} sessionId
 * @property {string} sessionFile
 * @property {string} cwd
 * @property {string} [baseUrlOverride] Forwarded from --baseurl so /set_model preserves the override.
 * @property {Readable} [input] Default to process.stdin/stdout. Tests inject PassThrough streams.
 * @property {Writable} [output]
 * @property {boolean} [exitOnInputEnd] Test-only — resolves when the readline loop ends.
 */

/**
 * @typedef {object} MutableState
 * @property {Session} session
 * @property {string} sessionId
 * @property {string} sessionFile
 */

/**
 * @param {RpcModeOptions} opts
 * @returns {Promise<void>}
 */
export async function runRpcMode(opts) {
	const { agent, cwd, baseUrlOverride } = opts
	const input = opts.input ?? process.stdin
	const output = opts.output ?? process.stdout

	/** @type {MutableState} */
	const state = {
		session: opts.session,
		sessionId: opts.sessionId,
		sessionFile: opts.sessionFile,
	}

	/** @param {unknown} obj */
	const write = (obj) => {
		output.write(`${JSON.stringify(obj)}\n`)
	}

	/**
	 * @param {string | undefined} id
	 * @param {RpcCommand["type"]} command
	 * @param {unknown} [data]
	 * @returns {RpcResponse}
	 */
	const success = (id, command, data) => {
		if (data === undefined) return /** @type {RpcResponse} */ ({ id, type: "response", command, success: true })
		return /** @type {RpcResponse} */ ({ id, type: "response", command, success: true, data })
	}

	/**
	 * @param {string | undefined} id
	 * @param {string} command
	 * @param {string} message
	 * @returns {RpcResponse}
	 */
	const error = (id, command, message) => ({
		id,
		type: "response",
		command,
		success: false,
		error: message,
	})

	// ─── Event fan-out ──────────────────────────────────────────────────────
	// Mirror chat-mode's persistence: append every message_end to the current
	// session file, and bump the index entry on agent_end.
	agent.subscribe(async (event) => {
		write(event)
		if (event.type === "message_end") {
			try {
				await state.session.appendMessage(/** @type {any} */ (event.message))
			} catch (err) {
				write({ type: "error", scope: "session_persist", error: /** @type {any} */ (err)?.message ?? String(err) })
			}
		}
		if (event.type === "agent_end") {
			touchSession(state.sessionId).catch(() => {})
		}
	})

	// Mirror existing transcript into the agent so a `--mode rpc -r` resume
	// works the same way it does in chat-mode.
	{
		const existing = state.session.getMessages()
		if (existing.length > 0) agent.state.messages = /** @type {any} */ (existing)
	}

	// ─── Helpers ────────────────────────────────────────────────────────────
	/** @returns {Promise<RpcSessionState>} */
	const buildState = async () => ({
		model: /** @type {any} */ (agent.state.model),
		thinkingLevel: /** @type {any} */ (agent.state.thinkingLevel),
		isStreaming: agent.state.isStreaming,
		isCompacting: false, // pinano has no separate "compacting" flag; transformContext blocks the turn
		steeringMode: /** @type {any} */ (agent.steeringMode),
		followUpMode: /** @type {any} */ (agent.followUpMode),
		sessionFile: state.sessionFile,
		sessionId: state.sessionId,
		sessionName: state.session.getSessionName(),
		autoCompactionEnabled: true, // pinano: always on via transformContext
		messageCount: agent.state.messages.length,
		pendingMessageCount: 0, // pinano's queues don't expose a count yet
	})

	/**
	 * @param {Session} next
	 * @param {string} id
	 * @param {string} sessionFile
	 */
	const swapSession = (next, id, sessionFile) => {
		state.session = next
		state.sessionId = id
		state.sessionFile = sessionFile
		const messages = next.getMessages()
		agent.state.messages = /** @type {any} */ (messages)
	}

	/**
	 * @param {any} m
	 * @returns {string}
	 */
	const userMessageText = (m) => {
		if (typeof m.content === "string") return m.content
		return (m.content ?? [])
			.filter((/** @type {any} */ c) => c.type === "text")
			.map((/** @type {any} */ c) => c.text)
			.join(" ")
	}

	// ─── Command dispatch ──────────────────────────────────────────────────
	/**
	 * @param {RpcCommand} command
	 * @returns {Promise<RpcResponse>}
	 */
	const handle = async (command) => {
		const id = command.id

		switch (command.type) {
			case "prompt": {
				if (agent.state.isStreaming && command.streamingBehavior === "steer") {
					agent.steer(/** @type {any} */ ({
						role: "user",
						content: [{ type: "text", text: command.message }, ...(command.images ?? [])],
						timestamp: Date.now(),
					}))
					return success(id, "prompt")
				}
				if (agent.state.isStreaming && command.streamingBehavior === "followUp") {
					agent.followUp(/** @type {any} */ ({
						role: "user",
						content: [{ type: "text", text: command.message }, ...(command.images ?? [])],
						timestamp: Date.now(),
					}))
					return success(id, "prompt")
				}
				if (agent.state.isStreaming) {
					return error(id, "prompt", "Agent is streaming. Use streamingBehavior:'steer'|'followUp'.")
				}
				// Don't await — events stream via subscribe.
				agent
					.prompt(command.message, /** @type {any} */ (command.images))
					.catch((/** @type {any} */ e) => write(error(id, "prompt", e?.message ?? String(e))))
				return success(id, "prompt")
			}

			case "steer": {
				agent.steer(/** @type {any} */ ({
					role: "user",
					content: [{ type: "text", text: command.message }, ...(command.images ?? [])],
					timestamp: Date.now(),
				}))
				return success(id, "steer")
			}

			case "follow_up": {
				agent.followUp(/** @type {any} */ ({
					role: "user",
					content: [{ type: "text", text: command.message }, ...(command.images ?? [])],
					timestamp: Date.now(),
				}))
				return success(id, "follow_up")
			}

			case "abort": {
				agent.abort()
				await agent.waitForIdle()
				return success(id, "abort")
			}

			case "new_session": {
				if (agent.state.isStreaming) {
					agent.abort()
					await agent.waitForIdle()
				}
				const created = await createSession(cwd)
				await ensureProjectContextMessage(created.session, cwd)
				swapSession(created.session, created.id, join(sessionsDir(), `${created.id}.jsonl`))
				return success(id, "new_session", { cancelled: false, sessionId: created.id })
			}

			case "get_state": {
				return success(id, "get_state", await buildState())
			}

			case "set_model": {
				const entry = MODEL_REGISTRY.find((m) => m.provider === command.provider && m.id === command.modelId)
				if (!entry) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`)
				}
				agent.state.model = /** @type {any} */ (buildModel(entry, { baseUrl: baseUrlOverride }))
				return success(id, "set_model", agent.state.model)
			}

			case "cycle_model": {
				const settings = await loadSettings()
				const models = await availableModelEntries()
				const currentId = agent.state.model.provider === "openai-codex"
					? `openai-codex/${agent.state.model.id}`
					: agent.state.model.id
				const cycled = cycleModelId(currentId, settings.scopedModelIds, models)
				if (!cycled) return success(id, "cycle_model", null)
				agent.state.model = /** @type {any} */ (resolveModel(cycled.id, { baseUrl: baseUrlOverride }))
				return success(id, "cycle_model", {
					model: agent.state.model,
					thinkingLevel: agent.state.thinkingLevel,
					isScoped: cycled.isScoped,
				})
			}

			case "get_available_models": {
				const models = (await availableModelEntries()).map((entry) => buildModel(entry, { baseUrl: baseUrlOverride }))
				return success(id, "get_available_models", { models })
			}

			case "set_thinking_level": {
				agent.state.thinkingLevel = /** @type {any} */ (command.level)
				return success(id, "set_thinking_level")
			}

			case "cycle_thinking_level": {
				const next = cycleThinkingLevel(/** @type {any} */ (agent.state.thinkingLevel))
				agent.state.thinkingLevel = /** @type {any} */ (next)
				return success(id, "cycle_thinking_level", { level: next })
			}

			case "set_steering_mode": {
				agent.steeringMode = command.mode
				return success(id, "set_steering_mode")
			}

			case "set_follow_up_mode": {
				agent.followUpMode = command.mode
				return success(id, "set_follow_up_mode")
			}

			case "compact": {
				// pinano's compact() doesn't yet honour customInstructions. The
				// parallel pinano-features branch is rewiring summarize() to take
				// a custom prompt — once merged we can pass it through here.
				void command.customInstructions
				const result = await compact(agent)
				return success(id, "compact", result)
			}

			case "get_session_stats": {
				const messages = /** @type {any[]} */ (agent.state.messages)
				const last = [...messages].reverse().find((m) => m.role === "assistant" && m.usage?.totalTokens)
				const tokensUsed = last?.usage?.totalTokens ?? 0
				const contextWindow = agent.state.model.contextWindow ?? 0
				return success(id, "get_session_stats", {
					messageCount: messages.length,
					tokensUsed,
					contextWindow,
					usageRatio: contextWindow > 0 ? tokensUsed / contextWindow : 0,
				})
			}

			case "switch_session": {
				const sessionId = pathToSessionId(command.sessionPath)
				if (!sessionId) {
					return error(id, "switch_session", `Could not derive session id from ${command.sessionPath}`)
				}
				if (agent.state.isStreaming) {
					agent.abort()
					await agent.waitForIdle()
				}
				try {
					const opened = await openSession(sessionId)
					await ensureProjectContextMessage(opened.session, cwd)
					swapSession(opened.session, opened.id, command.sessionPath)
					return success(id, "switch_session", { cancelled: false })
				} catch (e) {
					return error(id, "switch_session", /** @type {any} */ (e)?.message ?? String(e))
				}
			}

			case "fork": {
				const target = state.session.getEntry(command.entryId)
				if (!target) return error(id, "fork", `Entry not found: ${command.entryId}`)
				state.session.moveTo(command.entryId)
				const branch = state.session.getBranch()
				agent.state.messages = /** @type {any} */ (branch
					.filter((/** @type {any} */ e) => e.type === "message")
					.map((/** @type {any} */ e) => e.message))
				const text = target.type === "message" ? userMessageText(target.message) : ""
				return success(id, "fork", { text, cancelled: false })
			}

			case "get_fork_messages": {
				const entries = /** @type {any[]} */ (state.session.getEntries())
				const userEntries = entries.filter((e) => e.type === "message" && e.message?.role === "user")
				return success(id, "get_fork_messages", {
					messages: userEntries.map((e) => ({ entryId: e.id, text: userMessageText(e.message) })),
				})
			}

			case "get_last_assistant_text": {
				const messages = /** @type {any[]} */ (agent.state.messages)
				for (let i = messages.length - 1; i >= 0; i--) {
					const m = messages[i]
					if (m.role !== "assistant") continue
					const text = (m.content ?? [])
						.filter((/** @type {any} */ c) => c.type === "text")
						.map((/** @type {any} */ c) => c.text)
						.join("")
					return success(id, "get_last_assistant_text", { text: text || null })
				}
				return success(id, "get_last_assistant_text", { text: null })
			}

			case "set_session_name": {
				const name = command.name.trim()
				if (!name) return error(id, "set_session_name", "Session name cannot be empty")
				await state.session.appendSessionName(name)
				await persistSessionName(state.sessionId, name)
				return success(id, "set_session_name")
			}

			case "get_messages": {
				return success(id, "get_messages", { messages: agent.state.messages.slice() })
			}

			default: {
				const u = /** @type {{ type: string }} */ (command)
				return error(undefined, u.type, `Unknown command: ${u.type}`)
			}
		}
	}

	// ─── Readline loop ──────────────────────────────────────────────────────
	const rl = readline.createInterface({ input, output, terminal: false })

	/** @type {Promise<void>} */
	const inputClosed = new Promise((resolve) => rl.once("close", () => resolve()))

	rl.on("line", async (/** @type {string} */ line) => {
		const trimmed = line.trim()
		if (!trimmed) return
		/** @type {RpcCommand} */
		let parsed
		try {
			parsed = /** @type {RpcCommand} */ (JSON.parse(trimmed))
		} catch (e) {
			write(error(undefined, "parse", `Failed to parse command: ${/** @type {any} */ (e)?.message ?? e}`))
			return
		}
		try {
			const response = await handle(parsed)
			write(response)
		} catch (e) {
			write(error(parsed.id, parsed.type ?? "unknown", /** @type {any} */ (e)?.message ?? String(e)))
		}
	})

	if (opts.exitOnInputEnd) {
		await inputClosed
		await agent.waitForIdle()
		return
	}

	// Real CLI usage: when the controlling stdin closes (parent process gone,
	// EOF on a pipe), drain any in-flight work and exit cleanly. Without this
	// the active subscriber + listeners can keep the loop alive indefinitely.
	await inputClosed
	await agent.waitForIdle()
	process.exit(0)
}

/**
 * Pi's RPC takes session paths; pinano stores by id. Extract id from filename.
 *
 * @param {string} p
 * @returns {string | null}
 */
function pathToSessionId(p) {
	const m = p.match(/([0-9a-f-]{36})\.jsonl$/i)
	if (m) return m[1] ?? null
	// Allow callers to pass a bare id too.
	if (/^[0-9a-f-]{36}$/i.test(p)) return p
	return null
}
