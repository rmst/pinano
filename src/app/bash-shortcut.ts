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

import type { Agent } from "../agent-core/agent.js"
import type { Session } from "../session-manager/index.js"

export interface BashShortcutResult {
	command: string
	output: string
	exitCode?: number
	excludeFromContext: boolean
}

/**
 * If `text` looks like a `!cmd` invocation, returns the parsed command +
 * exclusion flag, else null. Whitespace-only commands (just `!` or `!!`)
 * return null so the editor falls through to its normal handling.
 */
export function parseBashShortcut(text: string): { command: string; excludeFromContext: boolean } | null {
	if (!text.startsWith("!")) return null
	const excludeFromContext = text.startsWith("!!")
	const command = (excludeFromContext ? text.slice(2) : text.slice(1)).trim()
	if (!command) return null
	return { command, excludeFromContext }
}

/**
 * Run `command` via the agent's `bash` tool. Resolves with the captured output
 * + exit code. Exceptions from the tool itself bubble up.
 */
export async function runBashShortcut(
	agent: Agent,
	command: string,
	options: { excludeFromContext: boolean; onChunk?: (output: string) => void },
): Promise<BashShortcutResult> {
	const bashTool = agent.state.tools.find((t: any) => t.name === "bash") as any
	if (!bashTool) {
		throw new Error("bash tool is not available on this agent")
	}

	let lastOutput = ""
	const result = await bashTool.execute(
		`bash-shortcut-${Date.now()}`,
		{ command },
		undefined,
		(update: any) => {
			lastOutput = (update?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
			options.onChunk?.(lastOutput)
		},
	)

	const finalText = (result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || lastOutput
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
 */
export async function recordBashShortcut(
	agent: Agent,
	session: Session,
	result: BashShortcutResult,
): Promise<void> {
	if (result.excludeFromContext) return
	const text = `[user ran shell command]\n$ ${result.command}\n${result.output}`
	const message: any = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	}
	agent.state.messages = [...(agent.state.messages as any[]), message]
	try {
		await session.appendMessage(message)
	} catch {
		// Best-effort — session save errors are non-fatal for shortcut UX.
	}
}
