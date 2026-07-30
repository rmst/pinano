import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, isAbsolute, join, resolve } from "node:path"

import { INTERNAL_API_BASE_URL_ENV, INTERNAL_API_TOKEN_ENV } from "../../../protocol/src/internal-api-env.js"
import {
	AVAILABLE_PROXY_TOOLS_ENV,
	LEGACY_AVAILABLE_PROXY_TOOLS_ENV,
	LEGACY_PROXY_TOOLS_BIN_ENV,
	PROXY_TOOLS_BIN_ENV,
	knownProxyToolNames,
	proxyToolSpecs,
} from "../proxy-tools/registry.js"

export { AVAILABLE_PROXY_TOOLS_ENV, LEGACY_AVAILABLE_PROXY_TOOLS_ENV, LEGACY_PROXY_TOOLS_BIN_ENV, PROXY_TOOLS_BIN_ENV }

let proxyToolsBinDir
let proxyToolsBinDirKey

/** @param {string} s */
function shellQuote(s) {
	return `'${String(s).replaceAll("'", "'\\''")}'`
}

function toolTmpdir(baseEnv) {
	if (baseEnv.CEREX_FALLBACK_TOOLS_TMPDIR && isAbsolute(baseEnv.CEREX_FALLBACK_TOOLS_TMPDIR)) return resolve(baseEnv.CEREX_FALLBACK_TOOLS_TMPDIR)
	return undefined
}

function createProxyClient(route) {
	return `import * as http from "node:http"

const baseUrl = process.env.${INTERNAL_API_BASE_URL_ENV}
const token = process.env.${INTERNAL_API_TOKEN_ENV}

function write(stream, buffer) {
	return new Promise((resolve) => {
		if (!buffer.length) {
			resolve(undefined)
			return
		}
		stream.write(buffer, () => resolve(undefined))
	})
}

async function finish(status, payload = {}) {
	const stdout = typeof payload.stdoutBase64 === "string" ? Buffer.from(payload.stdoutBase64, "base64") : Buffer.alloc(0)
	const stderr = typeof payload.stderrBase64 === "string" ? Buffer.from(payload.stderrBase64, "base64") : Buffer.alloc(0)
	await write(process.stdout, stdout)
	await write(process.stderr, stderr)
	process.exit(Number.isInteger(payload.exitCode) ? payload.exitCode : status)
}

function fail(message, code = 1) {
	process.stderr.write(\`Cerex proxy tool failed: \${message}\\n\`)
	process.exit(code)
}

if (!baseUrl || !token) fail("internal API bridge is unavailable")

const body = JSON.stringify({
	cwd: process.cwd(),
	argv: process.argv.slice(2),
	toolCallId: process.env.CEREX_TOOL_CALL_ID || undefined,
})

try {
	const url = new URL(${JSON.stringify(route)}, baseUrl)
	const req = http.request(url, {
		method: "POST",
		headers: {
			authorization: \`Bearer \${token}\`,
			"content-type": "application/json",
			"content-length": Buffer.byteLength(body),
		},
	}, (res) => {
		const chunks = []
		res.on("data", (chunk) => chunks.push(chunk))
		res.on("end", async () => {
			let payload
			try {
				payload = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}")
			} catch {
				fail(\`invalid response from internal API (HTTP \${res.statusCode || 0})\`)
			}
			if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
				fail(payload.error || \`internal API returned HTTP \${res.statusCode || 0}\`)
			}
			await finish(1, payload)
		})
	})
	req.on("error", (err) => fail(err?.message ?? String(err)))
	req.end(body)
} catch (err) {
	fail(err?.message ?? String(err))
}
`
}

function createProxyWrapper(proxyPath, runtimePath) {
	return `#!/bin/sh
exec ${shellQuote(runtimePath)} ${shellQuote(proxyPath)} "$@"
`
}

function proxyToolsEnabledByHost(baseEnv) {
	const names = String(baseEnv[AVAILABLE_PROXY_TOOLS_ENV] ?? "").split(",").filter(Boolean)
	const available = new Set(knownProxyToolNames(names))
	return proxyToolSpecs.filter((tool) => available.has(tool.name))
}

function envWithoutProxyToolInternals(baseEnv) {
	const env = { ...baseEnv }
	const previousBins = new Set([env[PROXY_TOOLS_BIN_ENV], env[LEGACY_PROXY_TOOLS_BIN_ENV]]
		.filter((value) => typeof value === "string" && value)
		.map((value) => resolve(value)))
	delete env[PROXY_TOOLS_BIN_ENV]
	delete env[LEGACY_PROXY_TOOLS_BIN_ENV]
	delete env[AVAILABLE_PROXY_TOOLS_ENV]
	delete env[LEGACY_AVAILABLE_PROXY_TOOLS_ENV]
	if (previousBins.size > 0 && env.PATH) {
		env.PATH = env.PATH.split(delimiter).filter((entry) => !previousBins.has(resolve(entry || "."))).join(delimiter)
	}
	return env
}

function ensureInternalProxyTools(baseEnv, tools) {
	if (tools.length === 0) return undefined
	if (!baseEnv[INTERNAL_API_BASE_URL_ENV] || !baseEnv[INTERNAL_API_TOKEN_ENV]) return undefined
	const parent = toolTmpdir(baseEnv)
	if (!parent) return undefined
	const key = `${parent}\0${process.execPath}\0${tools.map((tool) => `${tool.name}:${tool.route}`).join("\0")}`
	if (proxyToolsBinDir && proxyToolsBinDirKey === key) return { bin: proxyToolsBinDir }
	const removeParentOnExit = !existsSync(parent)
	mkdirSync(parent, { recursive: true })
	const dir = mkdtempSync(join(parent, ".proxy-tools-"))
	const bin = join(dir, "bin")
	try {
		mkdirSync(bin, { recursive: true })
		for (const tool of tools) {
			const proxy = join(dir, `${tool.name}-proxy.mjs`)
			const wrapper = join(bin, tool.name)
			writeFileSync(proxy, createProxyClient(tool.route), { mode: 0o600 })
			writeFileSync(wrapper, createProxyWrapper(proxy, process.execPath))
			chmodSync(wrapper, 0o755)
		}
		proxyToolsBinDir = bin
		proxyToolsBinDirKey = key
		process.once("exit", () => {
			rmSync(dir, { recursive: true, force: true })
			if (removeParentOnExit) {
				try {
					rmSync(parent)
				} catch {}
			}
		})
		return { bin }
	} catch (err) {
		proxyToolsBinDir = undefined
		proxyToolsBinDirKey = undefined
		rmSync(dir, { recursive: true, force: true })
		throw err
	}
}

export function envWithInternalProxyTools(baseEnv = process.env) {
	const enabledTools = proxyToolsEnabledByHost(baseEnv)
	const env = envWithoutProxyToolInternals(baseEnv)
	const tools = ensureInternalProxyTools(env, enabledTools)
	if (!tools) return env
	const path = env.PATH ? `${tools.bin}${delimiter}${env.PATH}` : tools.bin
	return {
		...env,
		[PROXY_TOOLS_BIN_ENV]: tools.bin,
		PATH: path,
	}
}

export function configureInternalProxyTools(names, env = process.env) {
	const available = knownProxyToolNames(names)
	delete env[AVAILABLE_PROXY_TOOLS_ENV]
	delete env[LEGACY_AVAILABLE_PROXY_TOOLS_ENV]
	if (available.length > 0) env[AVAILABLE_PROXY_TOOLS_ENV] = available.join(",")
}
