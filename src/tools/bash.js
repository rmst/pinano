import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.js"

// /bin/bash if available, else sh. We deliberately ignore $SHELL so macOS-zsh
// (or any user-customized shell) doesn't change behavior. Non-login (-c) so we
// don't re-source /etc/profile, which on Debian/Ubuntu resets PATH and would
// strip the additions made by the surrounding container/jix env.
const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "sh"

const bashSchema = {
	type: "object",
	properties: {
		command: { type: "string", description: "Bash command to execute" },
		timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
	},
	required: ["command"],
	additionalProperties: false,
}

/**
 * Spawn a process group on Unix and SIGKILL the whole group on abort/timeout.
 * Posix-only — we don't target Windows.
 */
function spawnInGroup(command, cwd, env) {
	return spawn(SHELL, ["-c", command], {
		cwd,
		env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	})
}

function killGroup(pid) {
	if (!pid) return
	try {
		process.kill(-pid, "SIGKILL")
	} catch {
		try {
			process.kill(pid, "SIGKILL")
		} catch {}
	}
}

/**
 * @param {string} cwd
 * @returns {import("../agent-core/types.js").AgentTool}
 */
export function createBashTool(cwd) {
	return {
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the working directory. Streams stdout+stderr; output is truncated from the head if it exceeds the size limit. Use the `timeout` parameter for long-running commands.",
		parameters: bashSchema,
		executionMode: "sequential",
		async execute(_id, { command, timeout }, signal, onUpdate) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`)
			}
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"))
					return
				}
				const child = spawnInGroup(command, cwd, process.env)
				let buffer = ""
				let exited = false
				let timedOut = false
				let aborted = false

				const onData = (chunk) => {
					buffer += chunk.toString("utf-8")
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: buffer }],
							details: {},
						})
					}
				}
				child.stdout?.on("data", onData)
				child.stderr?.on("data", onData)

				const timer =
					timeout && timeout > 0
						? setTimeout(() => {
								timedOut = true
								killGroup(child.pid)
							}, timeout * 1000)
						: undefined

				const onAbort = () => {
					aborted = true
					killGroup(child.pid)
				}
				signal?.addEventListener("abort", onAbort, { once: true })

				const finish = (err) => {
					if (exited) return
					exited = true
					if (timer) clearTimeout(timer)
					signal?.removeEventListener("abort", onAbort)
					if (err) {
						reject(err)
						return
					}
				}

				child.on("error", (err) => finish(err))
				child.on("close", (code) => {
					if (exited) return
					exited = true
					if (timer) clearTimeout(timer)
					signal?.removeEventListener("abort", onAbort)

					if (aborted) {
						reject(new Error("Operation aborted"))
						return
					}
					const truncation = truncateTail(buffer)
					let output = truncation.content
					const trailers = []
					if (timedOut) trailers.push(`[Timed out after ${timeout}s]`)
					if (truncation.truncated) {
						if (truncation.truncatedBy === "lines") {
							trailers.push(
								`[Truncated head: showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines} line limit)]`,
							)
						} else {
							trailers.push(
								`[Truncated head: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`,
							)
						}
					}
					if (typeof code === "number" && code !== 0) trailers.push(`[Exit code: ${code}]`)
					if (trailers.length > 0) output += (output ? "\n" : "") + trailers.join("\n")
					if (!output) output = "(no output)"
					resolve({
						content: [{ type: "text", text: output }],
						details: { exitCode: code, truncation, timedOut },
					})
				})
			})
		},
	}
}

// re-export so callers can adjust if they want to override defaults
export { DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES }
