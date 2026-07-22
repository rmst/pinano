import {
	maxOutputBytesForTokens,
	normalizeExecYieldTimeMs,
	normalizeWriteStdinYieldTimeMs,
	processSessionManager,
	waitForSession,
} from "./process-sessions.js"

const execCommandSchema = {
	type: "object",
	properties: {
		cmd: { type: "string", description: "Shell command to execute" },
		workdir: { type: "string", description: "Working directory for the command. Relative paths are resolved from the current working directory." },
		shell: { type: "string", description: "Shell executable to run with -c. Defaults to /bin/bash when available, otherwise sh." },
		yield_time_ms: { type: "number", description: "How long to wait before returning a still-running session_id. Defaults to 10000ms." },
		max_output_tokens: { type: "number", description: "Approximate maximum output tokens to return in this tool result. Defaults to 10000 tokens; larger requests are clamped to that model-visible limit." },
		interactive: {
			type: "string",
			enum: ["none", "pipe"],
			description: "Use 'none' for no stdin (default), or 'pipe' when write_stdin should send stdin bytes.",
		},
		timeout_ms: { type: "number", description: "Hard execution timeout in milliseconds. On timeout, the process group is killed." },
	},
	required: ["cmd"],
	additionalProperties: false,
}

const writeStdinSchema = {
	type: "object",
	properties: {
		session_id: { type: "number", description: "Numeric session id returned by exec_command" },
		chars: { type: "string", description: "Bytes/text to write to the session's stdin. Omit or pass an empty string to poll output only." },
		yield_time_ms: { type: "number", description: "How long to wait for more output or process exit. Defaults to 250ms for writes and at least 5000ms for empty polls." },
		max_output_tokens: { type: "number", description: "Approximate maximum output tokens to return in this tool result. Defaults to 10000 tokens; larger requests are clamped to that model-visible limit." },
		close_stdin: { type: "boolean", description: "Close stdin after any chars, like a reliable Ctrl-D/EOF for pipe-backed sessions." },
		signal: {
			type: "string",
			enum: ["interrupt", "terminate", "kill"],
			description: "Signal the process group: interrupt=SIGINT, terminate=SIGTERM, kill=SIGKILL.",
		},
	},
	required: ["session_id"],
	additionalProperties: false,
}

/**
 * @param {string} cwd
 * @returns {import("../agent-core/types.js").AgentTool}
 */
export function createExecCommandTool(cwd) {
	return {
		name: "exec_command",
		label: "exec_command",
		description:
			"Execute a shell command. If the command is still running after yield_time_ms, returns a session_id; poll or interact with that session using write_stdin. Use interactive: 'pipe' when stdin is needed.",
		parameters: execCommandSchema,
		executionMode: "parallel",
		async execute(id, args, signal) {
			if (!args || typeof args.cmd !== "string") throw new Error("cmd is required")
			if (signal?.aborted) throw new Error("Operation aborted")
			const session = processSessionManager.start(cwd, args, { toolCallId: id })
			const abort = () => session.dispose("kill")
			signal?.addEventListener("abort", abort, { once: true })
			try {
				await waitForSession(session, normalizeExecYieldTimeMs(args.yield_time_ms), signal)
				const result = session.formatResult(maxOutputBytesForTokens(args.max_output_tokens))
				if (!session.running) processSessionManager.delete(session)
				return result
			} catch (error) {
				session.dispose("kill")
				processSessionManager.delete(session)
				throw error
			} finally {
				signal?.removeEventListener("abort", abort)
			}
		},
	}
}

/**
 * @returns {import("../agent-core/types.js").AgentTool}
 */
export function createWriteStdinTool() {
	return {
		name: "write_stdin",
		label: "write_stdin",
		description:
			"Poll or interact with a running exec_command session. Omit chars to poll. Use close_stdin for EOF. Use signal to interrupt, terminate, or kill the process group instead of sending control-character bytes.",
		parameters: writeStdinSchema,
		executionMode: "sequential",
		async execute(_id, args, signal) {
			if (!args || typeof args.session_id !== "number" || !Number.isInteger(args.session_id)) throw new Error("session_id must be an integer")
			if (signal?.aborted) throw new Error("Operation aborted")
			const session = processSessionManager.get(args.session_id)
			if (typeof args.chars === "string" && args.chars.length > 0) session.sendInput(args.chars)
			if (args.close_stdin === true) session.closeStdin()
			if (typeof args.signal === "string") session.sendSignal(args.signal)
			await waitForSession(session, normalizeWriteStdinYieldTimeMs(args.yield_time_ms, args.chars), signal)
			const result = session.formatResult(maxOutputBytesForTokens(args.max_output_tokens))
			if (!session.running) processSessionManager.delete(session)
			return result
		},
	}
}
