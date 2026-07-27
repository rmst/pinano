import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"

const DEFAULT_COPY_TIMEOUT_MS = 1000

/**
 * @typedef {{ timeoutMs?: number }} RunTextCommandOptions
 * @typedef {(command: string, args: string[], input: string, options?: RunTextCommandOptions) => Promise<void>} RunTextCommand
 */

/** @param {NodeJS.ProcessEnv} env */
function isRemoteShell(env) {
	return Boolean(env.SSH_CLIENT || env.SSH_CONNECTION || env.SSH_TTY)
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} input
 * @param {RunTextCommandOptions} [options]
 * @returns {Promise<void>}
 */
function runTextCommand(command, args, input, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] })
		const stderr = []
		let settled = false
		let timeout
		const rejectOnce = (err) => {
			if (settled) return
			settled = true
			if (timeout) clearTimeout(timeout)
			reject(err)
		}
		const resolveOnce = () => {
			if (settled) return
			settled = true
			if (timeout) clearTimeout(timeout)
			resolve()
		}
		timeout = setTimeout(() => {
			child.kill("SIGKILL")
			rejectOnce(new Error(`${command} timed out`))
		}, options.timeoutMs ?? DEFAULT_COPY_TIMEOUT_MS)
		child.stderr?.on("data", (chunk) => stderr.push(chunk))
		child.stdin?.on("error", rejectOnce)
		child.on("error", rejectOnce)
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolveOnce()
				return
			}
			const err = Buffer.concat(stderr).toString("utf8").trim()
			rejectOnce(new Error(`${command} failed${signal ? ` (${signal})` : ` (code ${code})`}${err ? `: ${err}` : ""}`))
		})
		child.stdin?.end(input, "utf8")
	})
}

/**
 * Copy text to a native host clipboard when Cerex is running directly on a supported host.
 * @param {string} text
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, runTextCommand?: RunTextCommand, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>} true when a native clipboard command was attempted
 */
export async function copyTextToHostClipboard(text, options = {}) {
	if (!text) return false
	const platform = options.platform ?? process.platform
	const env = options.env ?? process.env
	const run = options.runTextCommand ?? runTextCommand

	if (platform === "darwin" && !isRemoteShell(env)) {
		await run("pbcopy", [], text, { timeoutMs: options.timeoutMs ?? DEFAULT_COPY_TIMEOUT_MS })
		return true
	}

	return false
}
