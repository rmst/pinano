#!/usr/bin/env node

import * as http from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { URL, fileURLToPath } from "node:url"

const VERSION = "pinano-curl 0.1 curl-compatible HTTP(S) subset"
const DEFAULT_MAX_REDIRECTS = 30
const unsupportedExitCode = 2

class CurlUsageError extends Error {
	constructor(message, exitCode = unsupportedExitCode) {
		super(message)
		this.exitCode = exitCode
	}
}

const booleanShort = new Set(["f", "s", "S", "L", "I", "O", "i", "k", "v"])
const valueShort = new Set(["X", "H", "d", "o", "u", "A", "e", "b", "c", "m", "w", "F", "D"])
const longBoolean = new Map([
	["fail", "fail"],
	["silent", "silent"],
	["show-error", "showError"],
	["location", "location"],
	["head", "head"],
	["remote-name", "remoteName"],
	["include", "include"],
	["insecure", "insecure"],
	["verbose", "verbose"],
	["compressed", "compressed"],
	["get", "get"],
	["fail-with-body", "failWithBody"],
])
const longValue = new Map([
	["request", "request"],
	["header", "header"],
	["data", "data"],
	["data-raw", "dataRaw"],
	["data-binary", "dataBinary"],
	["json", "json"],
	["form", "form"],
	["form-string", "formString"],
	["output", "output"],
	["user", "user"],
	["user-agent", "userAgent"],
	["referer", "referer"],
	["cookie", "cookie"],
	["cookie-jar", "cookieJar"],
	["max-time", "maxTime"],
	["connect-timeout", "connectTimeout"],
	["write-out", "writeOut"],
	["dump-header", "dumpHeader"],
	["cacert", "cacert"],
	["cert", "cert"],
	["key", "key"],
	["url", "url"],
	["max-redirs", "maxRedirs"],
])
const explicitlyUnsupported = new Set([
	"ftp-ssl",
	"ftp-pasv",
	"ftp-method",
	"ftp-create-dirs",
	"http2",
	"http3",
	"http1.0",
	"proxy",
	"proxy-user",
	"socks5",
	"socks5-hostname",
	"unix-socket",
	"abstract-unix-socket",
	"netrc",
	"netrc-file",
	"cert-type",
	"key-type",
	"digest",
	"negotiate",
	"ntlm",
	"aws-sigv4",
	"oauth2-bearer",
	"retry",
	"retry-delay",
	"retry-max-time",
	"parallel",
	"parallel-max",
	"limit-rate",
	"rate",
	"range",
	"continue-at",
	"remote-header-name",
	"remote-time",
	"create-dirs",
	"config",
	"config-insecure",
	"resolve",
	"connect-to",
	"interface",
	"dns-servers",
	"doh-url",
	"ipv4",
	"ipv6",
	"location-trusted",
	"upload-file",
	"request-target",
	"next",
])

function initialConfig() {
	return {
		urls: [],
		headers: [],
		data: [],
		dataBinary: [],
		forms: [],
		fail: false,
		failWithBody: false,
		silent: false,
		showError: false,
		location: false,
		head: false,
		remoteName: false,
		include: false,
		insecure: false,
		verbose: false,
		compressed: false,
		get: false,
		output: null,
		request: null,
		user: null,
		userAgent: null,
		referer: null,
		cookie: null,
		cookieJar: null,
		maxTime: null,
		connectTimeout: null,
		writeOut: null,
		dumpHeader: null,
		cacert: null,
		cert: null,
		key: null,
		maxRedirs: DEFAULT_MAX_REDIRECTS,
	}
}

function takeValue(args, index, label, inline) {
	if (inline !== undefined) return [inline, index]
	if (index + 1 >= args.length) throw new CurlUsageError(`option ${label} requires an argument`)
	return [args[index + 1], index + 1]
}

function applyBoolean(config, key) {
	config[key] = true
}

function applyValue(config, key, value) {
	if (key === "request") config.request = value
	else if (key === "header") config.headers.push(value)
	else if (key === "data" || key === "dataRaw") config.data.push({ value, raw: key === "dataRaw" })
	else if (key === "dataBinary") config.dataBinary.push(value)
	else if (key === "json") config.json = value
	else if (key === "form" || key === "formString") config.forms.push({ value, string: key === "formString" })
	else if (key === "output") config.output = value
	else if (key === "user") config.user = value
	else if (key === "userAgent") config.userAgent = value
	else if (key === "referer") config.referer = value
	else if (key === "cookie") config.cookie = value
	else if (key === "cookieJar") config.cookieJar = value
	else if (key === "maxTime") config.maxTime = parsePositiveNumber(value, "--max-time")
	else if (key === "connectTimeout") config.connectTimeout = parsePositiveNumber(value, "--connect-timeout")
	else if (key === "writeOut") config.writeOut = value
	else if (key === "dumpHeader") config.dumpHeader = value
	else if (key === "cacert") config.cacert = value
	else if (key === "cert") config.cert = value
	else if (key === "key") config.key = value
	else if (key === "url") config.urls.push(value)
	else if (key === "maxRedirs") config.maxRedirs = parseInteger(value, "--max-redirs")
	else throw new CurlUsageError(`internal parser error for option ${key}`)
}

function parsePositiveNumber(value, label) {
	const number = Number(value)
	if (!Number.isFinite(number) || number < 0) throw new CurlUsageError(`${label} expects a non-negative number`)
	return number
}

function parseInteger(value, label) {
	const number = Number(value)
	if (!Number.isInteger(number) || number < 0) throw new CurlUsageError(`${label} expects a non-negative integer`)
	return number
}

export function parseArgs(args) {
	const config = initialConfig()
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]
		if (arg === "--") {
			config.urls.push(...args.slice(i + 1))
			break
		}
		if (arg === "--version" || arg === "-V") {
			config.version = true
			continue
		}
		if (arg === "--help" || arg === "-h") {
			config.help = true
			continue
		}
		if (arg.startsWith("--")) {
			const body = arg.slice(2)
			const eq = body.indexOf("=")
			const name = eq === -1 ? body : body.slice(0, eq)
			const inline = eq === -1 ? undefined : body.slice(eq + 1)
			if (explicitlyUnsupported.has(name)) throw new CurlUsageError(`unsupported option --${name}`)
			if (longBoolean.has(name)) {
				if (inline !== undefined) throw new CurlUsageError(`option --${name} does not take an argument`)
				applyBoolean(config, longBoolean.get(name))
				continue
			}
			if (longValue.has(name)) {
				const [value, used] = takeValue(args, i, `--${name}`, inline)
				applyValue(config, longValue.get(name), value)
				i = used
				continue
			}
			throw new CurlUsageError(`unsupported option --${name}`)
		}
		if (arg.startsWith("-") && arg !== "-") {
			for (let j = 1; j < arg.length; j += 1) {
				const flag = arg[j]
				if (booleanShort.has(flag)) {
					const key = { f: "fail", s: "silent", S: "showError", L: "location", I: "head", O: "remoteName", i: "include", k: "insecure", v: "verbose" }[flag]
					applyBoolean(config, key)
					continue
				}
				if (valueShort.has(flag)) {
					const inline = j + 1 < arg.length ? arg.slice(j + 1) : undefined
					const [value, used] = takeValue(args, i, `-${flag}`, inline)
					const key = { X: "request", H: "header", d: "data", o: "output", u: "user", A: "userAgent", e: "referer", b: "cookie", c: "cookieJar", m: "maxTime", w: "writeOut", F: "form", D: "dumpHeader" }[flag]
					applyValue(config, key, value)
					i = used
					break
				}
				throw new CurlUsageError(`unsupported option -${flag}`)
			}
			continue
		}
		config.urls.push(arg)
	}
	validateConfig(config)
	return config
}

function validateConfig(config) {
	if (config.version || config.help) return
	if (config.urls.length === 0) throw new CurlUsageError("no URL specified")
	if (config.urls.length > 1) throw new CurlUsageError("multiple URLs are not supported by the pinano curl fallback")
	if (config.cookieJar) throw new CurlUsageError("unsupported option --cookie-jar/-c")
	if (config.forms.length > 0 && (config.data.length > 0 || config.dataBinary.length > 0 || config.json !== undefined)) {
		throw new CurlUsageError("mixing -F/--form with data/json options is not supported")
	}
}

function usage() {
	return `${VERSION}

Supported subset: HTTP(S), -fsSL, -I, -i, -o, -O, -X, -H, -d/--data,
--data-binary, --json, -F/--form, -u, -A, -e, -b, -k, --cacert, --cert,
--key, --compressed, --connect-timeout, --max-time, -w, -D.

Unsupported options fail before network I/O. Install curl for full curl support.
`
}

function parseHeaders(headerLines) {
	const headers = {}
	const disabled = new Set()
	for (const line of headerLines) {
		const index = line.indexOf(":")
		if (index === -1) throw new CurlUsageError(`malformed header: ${line}`)
		const name = line.slice(0, index).trim()
		const value = line.slice(index + 1).trimStart()
		if (!name) throw new CurlUsageError(`malformed header: ${line}`)
		if (value === "") disabled.add(name.toLowerCase())
		else headers[name] = value
	}
	return { headers, disabled }
}

function hasHeader(headers, name) {
	const lower = name.toLowerCase()
	return Object.keys(headers).some((key) => key.toLowerCase() === lower)
}

async function readArgData(value, { rawAt = false } = {}) {
	if (!rawAt && value.startsWith("@")) {
		const path = value.slice(1)
		if (path === "-") return readStdin()
		return readFile(path)
	}
	return Buffer.from(value)
}

async function readStdin() {
	const chunks = []
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
	return Buffer.concat(chunks)
}

async function buildMultipart(forms) {
	const boundary = `pinano-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	const chunks = []
	for (const form of forms) {
		const [namePart, valuePart = ""] = form.value.split(/=(.*)/s)
		if (!namePart) throw new CurlUsageError(`malformed form field: ${form.value}`)
		chunks.push(Buffer.from(`--${boundary}\r\n`))
		if (!form.string && valuePart.startsWith("@")) {
			const spec = valuePart.slice(1)
			const [path, ...params] = spec.split(";")
			if (!path) throw new CurlUsageError(`malformed form file field: ${form.value}`)
			const type = params.find((part) => part.startsWith("type="))?.slice("type=".length) || "application/octet-stream"
			chunks.push(Buffer.from(`Content-Disposition: form-data; name="${escapeQuoted(namePart)}"; filename="${escapeQuoted(basename(path))}"\r\n`))
			chunks.push(Buffer.from(`Content-Type: ${type}\r\n\r\n`))
			chunks.push(await readFile(path))
			chunks.push(Buffer.from("\r\n"))
		} else {
			chunks.push(Buffer.from(`Content-Disposition: form-data; name="${escapeQuoted(namePart)}"\r\n\r\n`))
			chunks.push(Buffer.from(valuePart))
			chunks.push(Buffer.from("\r\n"))
		}
	}
	chunks.push(Buffer.from(`--${boundary}--\r\n`))
	return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

function escapeQuoted(value) {
	return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\r", "%0D").replaceAll("\n", "%0A")
}

async function buildRequest(config, url) {
	const { headers, disabled } = parseHeaders(config.headers)
	if (config.userAgent && !disabled.has("user-agent")) headers["User-Agent"] = config.userAgent
	if (config.referer && !disabled.has("referer")) headers.Referer = config.referer
	if (config.cookie && !disabled.has("cookie")) headers.Cookie = await cookieHeader(config.cookie)
	if (config.compressed && !disabled.has("accept-encoding") && !hasHeader(headers, "Accept-Encoding")) headers["Accept-Encoding"] = "gzip, deflate, br"
	if (config.user && !disabled.has("authorization") && !hasHeader(headers, "Authorization")) {
		headers.Authorization = `Basic ${Buffer.from(config.user).toString("base64")}`
	}

	let body = null
	let contentType = null
	if (config.forms.length > 0) {
		const multipart = await buildMultipart(config.forms)
		body = multipart.body
		contentType = multipart.contentType
	} else if (config.json !== undefined) {
		body = await readArgData(config.json)
		contentType = "application/json"
		if (!disabled.has("accept") && !hasHeader(headers, "Accept")) headers.Accept = "application/json"
	} else if (config.dataBinary.length > 0) {
		body = Buffer.concat(await Promise.all(config.dataBinary.map((value) => readArgData(value))))
	} else if (config.data.length > 0) {
		const pieces = await Promise.all(config.data.map((item) => readArgData(item.value, { rawAt: item.raw })))
		body = Buffer.concat(pieces.flatMap((piece, index) => index === 0 ? [piece] : [Buffer.from("&"), piece]))
		contentType = "application/x-www-form-urlencoded"
	}

	if (config.get && body) {
		const query = body.toString("utf-8")
		url.search += (url.search ? "&" : "?") + query
		body = null
	}
	if (body && !hasHeader(headers, "Content-Type") && !disabled.has("content-type") && contentType) headers["Content-Type"] = contentType
	if (body && !hasHeader(headers, "Content-Length") && !disabled.has("content-length")) headers["Content-Length"] = String(body.length)

	const method = (config.request || (config.head ? "HEAD" : body ? "POST" : "GET")).toUpperCase()
	return { method, headers, body }
}

async function cookieHeader(value) {
	if (value.includes("=") || value.includes(";")) return value
	try {
		const text = await readFile(value, "utf-8")
		return text.split(/\r?\n/)
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => line.split("\t"))
			.filter((parts) => parts.length >= 7)
			.map((parts) => `${parts[5]}=${parts[6]}`)
			.join("; ")
	} catch {
		return value
	}
}

async function tlsOptions(config) {
	return {
		rejectUnauthorized: !config.insecure,
		...(config.cacert ? { ca: await readFile(config.cacert) } : {}),
		...(config.cert ? { cert: await readFile(config.cert) } : {}),
		...(config.key ? { key: await readFile(config.key) } : {}),
	}
}

async function httpsClient() {
	try {
		return await import("node:https")
	} catch {
		throw new CurlUsageError("HTTPS requires node:https support in the selected runtime")
	}
}

async function requestOnce(url, request, config, signal) {
	const isHttps = url.protocol === "https:"
	const client = isHttps ? await httpsClient() : http
	const options = {
		protocol: url.protocol,
		hostname: url.hostname,
		port: url.port || (isHttps ? 443 : 80),
		path: `${url.pathname}${url.search}`,
		method: request.method,
		headers: request.headers,
		signal,
		...(isHttps ? await tlsOptions(config) : {}),
	}
	return new Promise((resolve, reject) => {
		const req = client.request(options, (res) => resolve(res))
		req.on("error", reject)
		if (config.connectTimeout !== null) {
			req.setTimeout(config.connectTimeout * 1000, () => req.destroy(new Error(`connect timeout after ${config.connectTimeout} seconds`)))
		}
		if (request.body) req.write(request.body)
		req.end()
	})
}

function redirectLocation(currentUrl, res) {
	const status = res.statusCode || 0
	if (![301, 302, 303, 307, 308].includes(status)) return null
	const location = res.headers.location
	if (!location) return null
	return new URL(Array.isArray(location) ? location[0] : location, currentUrl)
}

function redirectedRequest(previous, status) {
	if ([301, 302, 303].includes(status) && previous.method !== "GET" && previous.method !== "HEAD") {
		const headers = { ...previous.headers }
		for (const name of Object.keys(headers)) {
			if (["content-length", "content-type"].includes(name.toLowerCase())) delete headers[name]
		}
		return { method: "GET", headers, body: null }
	}
	return previous
}

async function readResponseBody(res, compressed) {
	let stream = res
	const encoding = String(res.headers["content-encoding"] || "").toLowerCase()
	if (compressed && encoding) {
		const zlib = await import("node:zlib")
		if (encoding.includes("gzip")) stream = res.pipe(zlib.createGunzip())
		else if (encoding.includes("deflate")) stream = res.pipe(zlib.createInflate())
		else if (encoding.includes("br") && zlib.createBrotliDecompress) stream = res.pipe(zlib.createBrotliDecompress())
	}
	const chunks = []
	for await (const chunk of stream) chunks.push(Buffer.from(chunk))
	return Buffer.concat(chunks)
}

function responseHeaderBlock(res) {
	const status = res.statusCode || 0
	const message = res.statusMessage || ""
	const lines = [`HTTP/${res.httpVersion || "1.1"} ${status}${message ? ` ${message}` : ""}`]
	for (const [name, value] of Object.entries(res.headers)) {
		if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`)
		else if (value !== undefined) lines.push(`${name}: ${value}`)
	}
	return `${lines.join("\r\n")}\r\n\r\n`
}

async function perform(config) {
	let url = parseUrl(config.urls[0])
	const proxy = proxyEnvFor(url, process.env)
	if (proxy) throw new CurlUsageError(`proxy environment variable ${proxy.name} is not supported`)
	const start = Date.now()
	const controller = new AbortController()
	const timer = config.maxTime !== null
		? setTimeout(() => controller.abort(new Error(`operation timed out after ${config.maxTime} seconds`)), config.maxTime * 1000)
		: null
	try {
		let request = await buildRequest(config, url)
		let redirects = 0
		let response
		let headerBlocks = ""
		while (true) {
			if (config.verbose && !config.silent) writeStderr(`> ${request.method} ${url.href}\n`)
			response = await requestOnce(url, request, config, controller.signal)
			headerBlocks += responseHeaderBlock(response)
			const nextUrl = config.location ? redirectLocation(url, response) : null
			if (!nextUrl) break
			await readResponseBody(response, false)
			redirects += 1
			if (redirects > config.maxRedirs) throw new CurlUsageError(`maximum redirects (${config.maxRedirs}) followed`, 47)
			request = redirectedRequest(request, response.statusCode || 0)
			url = nextUrl
		}

		const body = await readResponseBody(response, config.compressed)
		const status = response.statusCode || 0
		const failedHttp = (config.fail || config.failWithBody) && status >= 400
		if (config.dumpHeader) await writeOutput(config.dumpHeader, Buffer.from(headerBlocks))
		const payload = config.head ? Buffer.from(headerBlocks) : config.include ? Buffer.concat([Buffer.from(headerBlocks), body]) : body
		if (!failedHttp || config.failWithBody) await writeBody(payload, config)
		if (config.writeOut) process.stdout.write(formatWriteOut(config.writeOut, { status, url, start }))
		if (failedHttp) {
			if (!config.silent || config.showError) writeStderr(`curl: (22) The requested URL returned error: ${status}\n`)
			return 22
		}
		return 0
	} finally {
		if (timer) clearTimeout(timer)
	}
}

function proxyEnvFor(url, env) {
	const noProxy = env.NO_PROXY || env.no_proxy || ""
	if (noProxyMatches(noProxy, url.hostname)) return null
	const names = url.protocol === "https:"
		? ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
		: ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
	for (const name of names) {
		if (env[name]) return { name, value: env[name] }
	}
	return null
}

function noProxyMatches(noProxy, hostname) {
	const host = hostname.toLowerCase()
	return noProxy.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean)
		.some((item) => {
			if (item === "*") return true
			const [pattern] = item.split(":")
			if (pattern.startsWith(".")) return host === pattern.slice(1) || host.endsWith(pattern)
			return host === pattern || host.endsWith(`.${pattern}`)
		})
}

function parseUrl(value) {
	let url
	try {
		url = new URL(value)
	} catch {
		url = new URL(`http://${value}`)
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new CurlUsageError(`unsupported protocol: ${url.protocol.replace(/:$/, "")}`)
	return url
}

async function writeBody(buffer, config) {
	if (config.remoteName) return writeOutput(remoteName(config.urls[0]), buffer)
	if (config.output) return writeOutput(config.output, buffer)
	process.stdout.write(buffer)
}

function remoteName(value) {
	const url = parseUrl(value)
	const name = basename(fileURLToPath(`file://${url.pathname}`))
	if (!name || name === "/") throw new CurlUsageError("remote file name has no length")
	return name
}

async function writeOutput(path, buffer) {
	if (path === "-") {
		process.stdout.write(buffer)
		return
	}
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, buffer)
}

function formatWriteOut(template, { status, url, start }) {
	const elapsed = (Date.now() - start) / 1000
	return template
		.replaceAll("\\n", "\n")
		.replaceAll("\\t", "\t")
		.replaceAll("%{http_code}", String(status).padStart(3, "0"))
		.replaceAll("%{response_code}", String(status).padStart(3, "0"))
		.replaceAll("%{url_effective}", url.href)
		.replaceAll("%{time_total}", elapsed.toFixed(6))
}

function writeStderr(text) {
	process.stderr.write(text)
}

async function main() {
	try {
		const config = parseArgs(process.argv.slice(2))
		if (config.version) {
			process.stdout.write(`${VERSION}\nProtocols: http https\nFeatures: headers data forms redirects fail silent output tls compressed write-out\n`)
			return 0
		}
		if (config.help) {
			process.stdout.write(usage())
			return 0
		}
		return await perform(config)
	} catch (err) {
		const code = err?.exitCode || (err?.name === "AbortError" ? 28 : 1)
		const prefix = code === unsupportedExitCode ? "pinano curl fallback" : "curl"
		writeStderr(`${prefix}: ${err?.message || err}\n`)
		if (code === unsupportedExitCode) writeStderr("This fallback only supports common HTTP(S) curl usage. Install curl for full support.\n")
		return code
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	process.exitCode = await main()
}
