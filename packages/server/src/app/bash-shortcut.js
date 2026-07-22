// !cmd / !!cmd — run a shell command directly from the editor without round-
// tripping through the LLM. Trimmed equivalent of pi's interactive-mode
// `handleBashCommand` path: same semantic for the leading `!` (record in
// context) vs `!!` (exclude from context).
//
//   !ls         runs `ls`, records it in the session DAG, and projects a
//               synthetic user message to the agent so later prompts can refer
//               to it
//   !!ls        runs `ls` and records it for display, but omits it from model
//               context
//
// Output is collected via the bash tool's onUpdate streaming, so we get the
// same truncation/exit-code formatting as the agent's own bash calls.

/** @typedef {import("../agent-core/agent.js").Agent} Agent */
/** @typedef {import("../session-manager/index.js").Session} Session */

import {
	BASH_SHORTCUT_CUSTOM_TYPE,
	bashShortcutModelMessage,
	normalizeBashShortcutEntryData,
} from "../session-manager/bash-shortcut-entry.js"

/**
 * @typedef {object} BashShortcutResult
 * @property {string} command
 * @property {string} output
 * @property {number} [exitCode]
 * @property {boolean} excludeFromContext
 * @property {Record<string, unknown>} [details]
 */

/**
 * @typedef {object} BashShortcutExecutor
 * @property {(name: string, id: string, args: any, signal?: AbortSignal, onUpdate?: (update: any) => void, options?: { scope?: any, toolProfile?: "default" | "codex" }) => Promise<any>} executeTool
 */

/**
 * If `text` looks like a `!cmd` invocation, returns the parsed command +
 * exclusion flag, else null. Whitespace-only commands (just `!` or `!!`)
 * return null so the editor falls through to its normal handling.
 *
 * @param {string} text
 * @returns {{ command: string, excludeFromContext: boolean } | null}
 */
export function parseBashShortcut(text) {
	if (!text.startsWith("!")) return null
	const excludeFromContext = text.startsWith("!!")
	const command = (excludeFromContext ? text.slice(2) : text.slice(1)).trim()
	if (!command) return null
	return { command, excludeFromContext }
}

function bashShortcutToolCallId() {
	const uuid = globalThis.crypto?.randomUUID?.()
	return `bash-shortcut-${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

/**
 * Return the executor for user-initiated bash shortcuts. Service/session
 * runtimes expose `agent.toolExecutor`, which runs through the selected session
 * environment and sandbox regardless of which tools are visible to the model.
 * The model-tool fallback keeps direct in-process agents working, but is never
 * used when a session executor exists.
 *
 * @param {Agent} agent
 * @returns {BashShortcutExecutor | null}
 */
export function bashShortcutExecutorForAgent(agent) {
	const toolExecutor = /** @type {any} */ (agent)?.toolExecutor
	if (toolExecutor && typeof toolExecutor.executeTool === "function") {
		return {
			executeTool: (name, id, args, signal, onUpdate, options) => toolExecutor.executeTool(name, id, args, signal, onUpdate, options),
		}
	}
	const bashTool = /** @type {any} */ (agent?.state?.tools ?? []).find((/** @type {any} */ t) => t.name === "bash")
	if (!bashTool) return null
	return {
		executeTool: (name, id, args, signal, onUpdate) => {
			if (name !== "bash") throw new Error(`Unsupported shortcut tool: ${name}`)
			return bashTool.execute(id, args, signal, onUpdate)
		},
	}
}

/**
 * Run `command` via a session command executor. Resolves with the captured
 * output + exit code. Exceptions from the executor itself bubble up.
 *
 * @param {BashShortcutExecutor} executor
 * @param {string} command
 * @param {{ excludeFromContext: boolean, onChunk?: (output: string) => void, signal?: AbortSignal }} options
 * @returns {Promise<BashShortcutResult>}
 */
export async function runBashShortcut(executor, command, options) {
	if (!executor || typeof executor.executeTool !== "function") throw new Error("bash shortcut execution is not available for this session")
	let lastOutput = ""
	const result = await executor.executeTool(
		"bash",
		bashShortcutToolCallId(),
		{ command },
		options.signal,
		(/** @type {any} */ update) => {
			lastOutput = (update?.content ?? []).filter((/** @type {any} */ c) => c.type === "text").map((/** @type {any} */ c) => c.text).join("")
			options.onChunk?.(lastOutput)
		},
	)

	const finalText = (result?.content ?? []).filter((/** @type {any} */ c) => c.type === "text").map((/** @type {any} */ c) => c.text).join("") || lastOutput
	return {
		command,
		output: finalText,
		exitCode: result?.details?.exitCode,
		...(result?.details && typeof result.details === "object" ? { details: result.details } : {}),
		excludeFromContext: options.excludeFromContext,
	}
}

/**
 * @param {Agent} agent
 * @param {string} command
 * @param {{ excludeFromContext: boolean, onChunk?: (output: string) => void, signal?: AbortSignal }} options
 * @returns {Promise<BashShortcutResult>}
 */
export function runAgentBashShortcut(agent, command, options) {
	return runBashShortcut(bashShortcutExecutorForAgent(agent), command, options)
}

/**
 * Persist a finished bash shortcut into the session DAG. Included shortcuts
 * also project into the live agent context as the same synthetic user message
 * shape used for replay; excluded shortcuts remain display-only.
 *
 * @param {Agent} agent
 * @param {Session} session
 * @param {BashShortcutResult} result
 * @returns {Promise<void>}
 */
export async function recordBashShortcut(agent, session, result) {
	const data = normalizeBashShortcutEntryData({
		version: 1,
		command: result.command,
		output: result.output,
		exitCode: result.exitCode,
		excludeFromContext: result.excludeFromContext,
		recordedAt: new Date().toISOString(),
		...(result.details ? { details: result.details } : {}),
	})
	if (!data) throw new Error("valid bash shortcut result is required")
	const message = bashShortcutModelMessage(data)
	if (message) agent.state.messages = [.../** @type {any[]} */ (agent.state.messages), message]
	try {
		const id = await session.appendCustomEntry(BASH_SHORTCUT_CUSTOM_TYPE, data)
		if (message) {
			if (id) agent.msgToEntryId?.set(message, id)
		}
	} catch {
		// Best-effort — session save errors are non-fatal for shortcut UX.
	}
}
