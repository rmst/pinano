// !cmd / !!cmd — run a shell command directly from the editor without round-
// tripping through the LLM. Trimmed equivalent of pi's interactive-mode
// `handleBashCommand` path: same semantic for the leading `!` (record in
// context) vs `!!` (exclude from context), no fancy ANSI rendering yet.
//
//   !ls         runs `ls`, transcripts it, and appends a synthetic user
//               message to the agent so subsequent prompts can refer to it
//   !!ls        runs `ls`, transcripts it, doesn't touch agent/session state
//
// Output is collected via the bash tool's onUpdate streaming, so we get the
// same truncation/exit-code formatting as the agent's own bash calls.

/** @typedef {import("../agent-core/agent.js").Agent} Agent */
/** @typedef {import("../session-manager/index.js").Session} Session */

/**
 * @typedef {object} BashShortcutResult
 * @property {string} command
 * @property {string} output
 * @property {number} [exitCode]
 * @property {boolean} excludeFromContext
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

/**
 * Run `command` via the agent's `bash` tool. Resolves with the captured output
 * + exit code. Exceptions from the tool itself bubble up.
 *
 * @param {Agent} agent
 * @param {string} command
 * @param {{ excludeFromContext: boolean, onChunk?: (output: string) => void }} options
 * @returns {Promise<BashShortcutResult>}
 */
export async function runBashShortcut(agent, command, options) {
	const bashTool = /** @type {any} */ (agent.state.tools.find((/** @type {any} */ t) => t.name === "bash"))
	if (!bashTool) {
		throw new Error("bash tool is not available on this agent")
	}

	let lastOutput = ""
	const result = await bashTool.execute(
		`bash-shortcut-${Date.now()}`,
		{ command },
		undefined,
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
		excludeFromContext: options.excludeFromContext,
	}
}

/**
 * Persist a finished bash shortcut into the agent's transcript + session
 * unless `excludeFromContext` was set. Stored as a single synthetic user
 * message so the LLM sees the command + output on the next turn.
 *
 * @param {Agent} agent
 * @param {Session} session
 * @param {BashShortcutResult} result
 * @returns {Promise<void>}
 */
export async function recordBashShortcut(agent, session, result) {
	if (result.excludeFromContext) return
	const text = `[user ran shell command]\n$ ${result.command}\n${result.output}`
	/** @type {any} */
	const message = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	}
	agent.state.messages = [.../** @type {any[]} */ (agent.state.messages), message]
	try {
		const id = await session.appendMessage(message)
		if (id) agent.msgToEntryId?.set(message, id)
	} catch {
		// Best-effort — session save errors are non-fatal for shortcut UX.
	}
}
