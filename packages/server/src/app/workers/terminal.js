import {
	_op,
	CLOSE,
	GET_PID,
	KILL,
	RESIZE,
	SET_ON_DATA,
	SET_ON_EXIT,
	SPAWN,
	WRITE,
} from "qn_uv_pty"
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

let pty
let ptyExited = false

function registerPidFile() {
	const pidFile = process.env.CEREX_WORKER_PID_FILE
	if (!pidFile) return
	try {
		mkdirSync(dirname(pidFile), { recursive: true })
		writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })
		process.on("exit", () => {
			try {
				unlinkSync(pidFile)
			} catch {}
		})
	} catch (err) {
		console.error(`failed to register Cerex terminal worker pid file: ${err?.message ?? err}`)
		process.exit(1)
	}
}

registerPidFile()

const decoder = new TextDecoder()
const send = (message) => {
	process.stdout.write(`${JSON.stringify(message)}\n`)
}

const sendData = (data) => {
	if (data) send({ type: "data", data })
}

const terminalEnv = (extra = {}) => Object.entries({
	...process.env,
	TERM: "xterm-256color",
	COLORTERM: "truecolor",
	...extra,
})
	.filter(([, value]) => value !== undefined && value !== null)
	.map(([key, value]) => `${key}=${value}`)

const cleanSize = (value, fallback) => {
	const number = Math.floor(Number(value))
	return Number.isFinite(number) && number > 0 ? Math.min(number, 1000) : fallback
}

function spawnPty(file, args, options = {}) {
	const cols = cleanSize(options.cols, 80)
	const rows = cleanSize(options.rows, 24)
	const handle = _op(SPAWN, file, args, cols, rows, options.cwd, terminalEnv(options.env))
	const api = {
		get pid() {
			return _op(GET_PID, handle)
		},
		write(data) {
			_op(WRITE, handle, data)
		},
		resize(cols, rows) {
			_op(RESIZE, handle, cleanSize(cols, 80), cleanSize(rows, 24))
		},
		kill(signal) {
			_op(KILL, handle, signal)
		},
		close() {
			_op(CLOSE, handle)
		},
	}
	_op(SET_ON_DATA, handle, (data) => sendData(decoder.decode(data, { stream: true })))
	_op(SET_ON_EXIT, handle, (code, signal) => {
		ptyExited = true
		sendData(decoder.decode())
		send({ type: "exit", exitCode: code, signal: signal || null })
	})
	return api
}

const defaultShell = () =>
	process.platform === "win32"
		? process.env.ComSpec || "cmd.exe"
		: process.env.SHELL?.startsWith("/") ? process.env.SHELL : existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh"

const cleanArgs = (args) =>
	Array.isArray(args) ? args.filter((arg) => typeof arg === "string") : []

function handleMessage(message) {
	if (!message || typeof message !== "object") return
	if (message.type === "start") {
		if (pty) return
		const file = typeof message.file === "string" && message.file ? message.file : defaultShell()
		pty = spawnPty(file, cleanArgs(message.args), {
			cols: message.cols,
			rows: message.rows,
			cwd: typeof message.cwd === "string" && message.cwd ? message.cwd : undefined,
			env: message.env && typeof message.env === "object" ? message.env : undefined,
		})
		send({ type: "started", pid: pty.pid })
		return
	}
	if (!pty) return
	if (message.type === "write" && typeof message.data === "string") pty.write(message.data)
	else if (message.type === "resize") pty.resize(message.cols, message.rows)
	else if (message.type === "kill") pty.kill(message.signal)
	else if (message.type === "close") {
		if (!ptyExited) pty.kill()
		pty.close()
	}
}

let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
	input += chunk
	let newline
	while ((newline = input.indexOf("\n")) >= 0) {
		const line = input.slice(0, newline)
		input = input.slice(newline + 1)
		if (!line.trim()) continue
		try {
			handleMessage(JSON.parse(line))
		} catch (err) {
			send({ type: "error", error: String(err?.stack || err) })
		}
	}
})

process.on("exit", () => {
	try {
		if (pty && !ptyExited) pty.kill()
		pty?.close()
	} catch {}
})
