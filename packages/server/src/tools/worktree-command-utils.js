import { spawn } from "node:child_process"
import * as http from "node:http"

export class CliError extends Error {
	constructor(message, exitCode = 1) {
		super(message)
		this.exitCode = exitCode
	}
}

export function commandResult(command, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (chunk) => { stdout += chunk })
		child.stderr?.on("data", (chunk) => { stderr += chunk })
		child.on("error", reject)
		child.on("exit", (code, signal) => {
			resolvePromise({ code: code ?? 1, signal, stdout, stderr })
		})
	})
}

export async function run(command, args, options = {}) {
	const result = await commandResult(command, args, options)
	if (result.code !== 0) {
		const output = `${result.stderr}${result.stdout}`.trim()
		throw new CliError(output || `${command} ${args.join(" ")} failed${result.signal ? ` (${result.signal})` : ""}`)
	}
	return result
}

export async function gitOutput(args, cwd) {
	return (await run("git", args, { cwd })).stdout.trim()
}

function parseResponseBody(text) {
	if (!text) return undefined
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

function postInternalEventWithHttp(url, token, data, options = {}) {
	return new Promise((resolvePromise) => {
		let resolved = false
		let req
		let timer
		const finish = (value) => {
			if (resolved) return
			resolved = true
			if (timer) clearTimeout(timer)
			resolvePromise(value)
		}
		req = http.request(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"content-length": Buffer.byteLength(data),
			},
		}, (res) => {
			const chunks = []
			res.on("data", (chunk) => chunks.push(chunk))
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf-8")
				finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode ?? 0, text, body: parseResponseBody(text) })
			})
		})
		timer = setTimeout(() => {
			req?.destroy()
			finish({ ok: false, status: 0, text: "request timed out" })
		}, options.timeoutMs ?? 2000)
		req.on("error", (err) => finish({ ok: false, status: 0, text: err?.message ?? String(err) }))
		req.end(data)
	})
}

export async function postInternalEvent(baseUrl, token, route, body, options = {}) {
	if (!baseUrl || !token) return { ok: false, status: 0, text: "Cerex internal API environment is not available" }
	let url
	try {
		url = new URL(route, baseUrl)
	} catch {
		return { ok: false, status: 0, text: "invalid Cerex internal API URL" }
	}
	const data = JSON.stringify(body)
	if (typeof fetch === "function" && typeof AbortController === "function") {
		const controller = new AbortController()
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			controller.abort()
		}, options.timeoutMs ?? 2000)
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: data,
				signal: controller.signal,
			})
			const text = await response.text().catch(() => "")
			return { ok: response.status >= 200 && response.status < 300, status: response.status, text, body: parseResponseBody(text) }
		} catch (err) {
			return { ok: false, status: 0, text: timedOut ? "request timed out" : err?.message ?? String(err) }
		} finally {
			clearTimeout(timer)
		}
	}
	return await postInternalEventWithHttp(url, token, data, options)
}
