import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { HOP_BY_HOP_HEADERS, requestPath } from "../http/proxy.js"
import { sessionWorkspacePath } from "../paths.js"
import {
	DEFAULT_PREVIEW_HOST,
	DEFAULT_PREVIEW_IDLE_TIMEOUT_MS,
	DEFAULT_PREVIEW_STARTUP_TIMEOUT_MS,
	PREVIEW_AUTHORIZATION_HEADER,
	PREVIEW_CONTROL_PATH_PREFIX,
	LEGACY_PREVIEW_AUTHORIZATION_HEADER,
	LEGACY_PREVIEW_CONTROL_PATH_PREFIX,
	PREVIEW_FRAME_BRIDGE_SCRIPT_PATH,
	PREVIEW_OPEN_DOCUMENT_PATH,
	PREVIEW_INJECT_SCRIPT_PATH,
	PREVIEW_LOG_PATH,
	PREVIEW_LOG_PAGE_PATH,
	PREVIEW_RESTART_PATH,
	PREVIEW_STATUS_PATH,
	PREVIEW_ROOT_KIND_PROJECT,
	PREVIEW_ROOT_KIND_SOURCE,
	PREVIEW_ROOT_KIND_STATIC,
	matchPreviewHost,
	previewDefinitionKey,
	previewFileDefinitionFromPath,
	previewLogPath,
	projectPreviewLogPath,
	previewPublicUrl,
	sessionPreviewScopeId,
	readSessionPreviewDefinitions,
	staticPreviewDefinition,
	staticPreviewPublicUrl,
	staticPreviewScopeId,
} from "./manifest.js"
import { isStaticPreviewDefinition, staticPreviewDefinitionForRecord } from "./static-definitions.js"
import { WEB_BROWSER_UI_NAME } from "../../../../protocol/src/web-branding.js"
import { staticPreviewRootIsProjectDocuments } from "../project/documents.js"
import { injectPreviewPageScripts, previewFrameBridgeScriptResponse, previewInjectScriptResponse, previewLogPageResponse, previewShellResponse } from "./shell.js"
import { encodeStaticPreviewPath } from "./static-server.js"

const MAX_PREVIEW_LOG_BYTES = 256 * 1024
const MAX_PREVIEW_STARTUP_LOG_BYTES = 16 * 1024
const PREVIEW_PROXY_HOP = "service-preview-upstream"
const PREVIEW_PROXY_RETRY_DELAYS_MS = [80, 160, 320]
const PREVIEW_PROXY_RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const PREVIEW_PROXY_TRANSIENT_ERROR_CODES = new Set([
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EPIPE",
	"ETIMEDOUT",
])

function text(body, status = 200, headers = {}) {
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
			...headers,
		},
	})
}

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	})
}

function routeError(err) {
	const status = Number.isInteger(err?.status) ? err.status : 502
	return text(err?.message ?? String(err), status, previewProxyErrorHeaders(err))
}

function previewProxyErrorHeaders(err) {
	if (err?.previewProxyHop !== PREVIEW_PROXY_HOP) return {}
	return {
		"x-cerex-preview-proxy-hop": PREVIEW_PROXY_HOP,
		...(Number.isInteger(err?.previewProxyAttempts) ? { "x-cerex-preview-proxy-attempts": String(err.previewProxyAttempts) } : {}),
		...(typeof err?.previewProxyErrorCode === "string" ? { "x-cerex-preview-proxy-error-code": err.previewProxyErrorCode } : {}),
	}
}

function cleanForwardedAuthorization(value) {
	if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) return undefined
	return value
}

function headerHost(headers) {
	const value = headers.get?.("host")
	return typeof value === "string" ? value : ""
}

async function previewSourceDefinitionForRoot(rootRecord, match, workspace) {
	const definition = rootRecord.projectDir
		? (await workspace.previews.resolveSource(rootRecord.rootPath, { projectDir: rootRecord.projectDir })).definition
		: await previewFileDefinitionFromPath(rootRecord.rootPath)
	if (definition.name !== match.name) throw Object.assign(new Error(`Preview source not found: ${match.name}`), { status: 404 })
	return definition
}

function proxyRequestHeaders(request, preview, options = {}) {
	const headers = new Headers(request.headers)
	for (const name of [...headers.keys()]) {
		const lower = name.toLowerCase()
		if (
			HOP_BY_HOP_HEADERS.has(lower)
			|| lower === "authorization"
			|| lower === PREVIEW_AUTHORIZATION_HEADER.toLowerCase()
			|| lower === LEGACY_PREVIEW_AUTHORIZATION_HEADER.toLowerCase()
			|| lower === "cookie"
			|| lower === "host"
			|| lower === "origin"
			|| lower === "referer"
			|| (options.stripAcceptEncoding && lower === "accept-encoding")
			|| lower.startsWith("sec-fetch-")
		) headers.delete(name)
	}
	if (request.method === "GET" || request.method === "HEAD") headers.delete("content-length")
	const publicUrl = new URL(preview.publicUrl)
	headers.set("host", `${preview.host}:${preview.port}`)
	headers.set("x-forwarded-host", publicUrl.host)
	headers.set("x-forwarded-proto", publicUrl.protocol.slice(0, -1))
	const authorization = cleanForwardedAuthorization(options.authorization)
	if (authorization) headers.set("authorization", authorization)
	return headers
}

function proxyResponseHeaders(upstream, preview) {
	const headers = new Headers()
	const upstreamOrigins = [
		`http://${preview.host}:${preview.port}`,
		...(preview.bindHost && preview.bindPort ? [`http://${preview.bindHost}:${preview.bindPort}`] : []),
	]
	upstream.headers.forEach((value, key) => {
		const lower = key.toLowerCase()
		if (HOP_BY_HOP_HEADERS.has(lower) || lower === "set-cookie") return
		if (lower === "x-frame-options") return
		if (lower === "content-security-policy") {
			const filtered = value.split(";").map((item) => item.trim()).filter((item) => item && !/^frame-ancestors(?:\s|$)/i.test(item)).join("; ")
			if (filtered) headers.set(key, filtered)
			return
		}
		if (lower === "location") {
			const origin = upstreamOrigins.find((item) => value.startsWith(item))
			if (origin) {
				headers.set(key, `${preview.publicUrl.replace(/\/$/, "")}${value.slice(origin.length)}`)
				return
			}
		}
		headers.set(key, value)
	})
	if (!headers.has("cache-control")) headers.set("cache-control", "no-store")
	return headers
}

function requestPathname(request) {
	try {
		return new URL(request.url).pathname
	} catch {
		return "/"
	}
}

function isPreviewControlPath(pathname) {
	return [PREVIEW_CONTROL_PATH_PREFIX, LEGACY_PREVIEW_CONTROL_PATH_PREFIX]
		.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function canonicalPreviewControlPath(pathname) {
	return pathname.startsWith(LEGACY_PREVIEW_CONTROL_PATH_PREFIX)
		? `${PREVIEW_CONTROL_PATH_PREFIX}${pathname.slice(LEGACY_PREVIEW_CONTROL_PATH_PREFIX.length)}`
		: pathname
}

function acceptsHtml(request) {
	const accept = request.headers.get("accept") || ""
	return /\btext\/html\b/i.test(accept)
}

const PREVIEW_PAGE_FETCH_DESTINATIONS = new Set(["document", "iframe"])

function wantsPreviewPage(request) {
	if (request.method !== "GET") return false
	if (!acceptsHtml(request)) return false
	if (isPreviewControlPath(requestPathname(request))) return false
	// Embedded previews are iframe navigations, but they still need the same startup shell and bridge scripts as top-level preview documents.
	return PREVIEW_PAGE_FETCH_DESTINATIONS.has((request.headers.get("sec-fetch-dest") || "").toLowerCase())
}

function previewTargetUrl(preview, request) {
	return new URL(requestPath(request.url), preview.publicUrl).href
}

function previewControlUrl(preview, path) {
	return new URL(path, preview.publicUrl).href
}

function cleanReturnPath(value) {
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/"
	return value
}

function previewReturnUrl(preview, request) {
	try {
		return new URL(cleanReturnPath(new URL(request.url).searchParams.get("next")), preview.publicUrl).href
	} catch {
		return new URL("/", preview.publicUrl).href
	}
}

function decodeUtf8Tail(buffer, maxBytes) {
	if (buffer.length <= maxBytes) return buffer.toString("utf-8")
	let start = buffer.length - maxBytes
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
	return buffer.subarray(start).toString("utf-8")
}

async function readPreviewLog(logPath, maxBytes = MAX_PREVIEW_LOG_BYTES) {
	if (!logPath) return ""
	try {
		return decodeUtf8Tail(await readFile(logPath), maxBytes)
	} catch (err) {
		if (err?.code === "ENOENT") return ""
		throw err
	}
}

function socketError(socket, status, message) {
	if (socket.destroyed) return
	socket.write([
		`HTTP/1.1 ${status} ${message}`,
		"content-type: text/plain; charset=utf-8",
		"cache-control: no-store",
		"connection: close",
		"",
		message,
	].join("\r\n"))
	socket.destroy()
}

const delay = (ms) => new Promise((resolve) => {
	const timer = setTimeout(resolve, ms)
	timer.unref?.()
})

function requestAbortedError() {
	return Object.assign(new Error("Preview request was aborted"), { status: 499 })
}

function previewProxyErrorCode(err) {
	if (typeof err?.code === "string" && err.code) return err.code
	if (typeof err?.cause?.code === "string" && err.cause.code) return err.cause.code
	const message = previewProxyErrorMessage(err)
	if (/\b(?:socket hang up|connection reset)\b/i.test(message)) return "ECONNRESET"
	if (/\bconnection refused\b/i.test(message)) return "ECONNREFUSED"
	if (/\btimed out\b/i.test(message)) return "ETIMEDOUT"
	if (/\bbroken pipe\b/i.test(message)) return "EPIPE"
	return undefined
}

function previewProxyErrorMessage(err) {
	return err?.message ?? String(err)
}

function isTransientPreviewProxyError(err) {
	const code = previewProxyErrorCode(err)
	if (code && PREVIEW_PROXY_TRANSIENT_ERROR_CODES.has(code)) return true
	const message = previewProxyErrorMessage(err)
	return /\b(?:socket hang up|connection reset|connection refused|timed out)\b/i.test(message)
}

function retryablePreviewProxyRequest(request) {
	const method = String(request.method || "GET").toUpperCase()
	return PREVIEW_PROXY_RETRYABLE_METHODS.has(method) && !request.body && request.signal?.aborted !== true
}

function cleanPreviewProxyRetryDelays(value) {
	if (value === false) return []
	if (!Array.isArray(value)) return PREVIEW_PROXY_RETRY_DELAYS_MS
	return value
		.map((item) => Number(item))
		.filter((item) => Number.isFinite(item) && item >= 0)
		.map((item) => Math.floor(item))
}

function markPreviewProxyError(err, metadata) {
	const error = err instanceof Error ? err : new Error(String(err))
	if (!Number.isInteger(error.status)) error.status = 502
	error.previewProxyHop = PREVIEW_PROXY_HOP
	error.previewProxyAttempts = metadata.attempts
	error.previewProxyRetryable = metadata.retryable
	error.previewProxyErrorCode = previewProxyErrorCode(err)
	return error
}

function startupCancelledError() {
	return Object.assign(new Error("Preview startup was cancelled"), { cancelled: true, status: 499 })
}

async function waitForPreviewHealth(workspace, target, path, timeoutMs, options = {}) {
	const deadline = Date.now() + timeoutMs
	let lastError
	while (Date.now() < deadline) {
		if (options.cancelled?.()) throw startupCancelledError()
		try {
			const remaining = Math.max(1, deadline - Date.now())
			const status = await workspace.previews.process.health(target, path, Math.min(1000, remaining))
			if ((status >= 200 && status < 400) || status === 401 || status === 403) return
			lastError = new Error(`healthPath returned HTTP ${status}`)
		} catch (err) {
			lastError = err
		}
		const inspected = await workspace.previews.process.touch(target.id).catch(() => undefined)
		if (inspected?.preview?.running === false) {
			const error = new Error("Preview process exited before becoming healthy")
			error.previewInspection = inspected.preview
			throw error
		}
		await delay(Math.min(100, Math.max(1, deadline - Date.now())))
	}
	const suffix = lastError?.message ? `: ${lastError.message}` : ""
	throw Object.assign(new Error(`Preview process did not become healthy at http://${target.host}:${target.port}${path} within ${timeoutMs}ms${suffix}`), { status: 504 })
}

function previewExitDescription(inspection) {
	if (!inspection || inspection.running !== false) return undefined
	if (inspection.exitCode !== null && inspection.exitCode !== undefined) return `code ${inspection.exitCode}`
	if (inspection.exitSignal) return `signal ${inspection.exitSignal}`
	return "process exited"
}

function startupFailure(error, target, definition, inspection, logText) {
	const lines = [
		`Preview ${definition.name} failed to start.`,
		`Command: ${definition.command}`,
		`Environment: ${target.environmentId}`,
		`Working directory: ${target.cwd}`,
	]
	const exit = previewExitDescription(inspection)
	if (exit) lines.push(`Exit: ${exit}`)
	else if (error?.message) lines.push(`Reason: ${error.message}`)
	if (target.logPath) lines.push(`Log: ${target.logPath}`)
	const tail = String(logText ?? "").trim()
	if (tail) lines.push("Log tail:", tail)
	return Object.assign(new Error(lines.join("\n")), {
		cause: error,
		status: Number.isInteger(error?.status) ? error.status : 502,
	})
}

export class PreviewManager {
	constructor(options = {}) {
		this.manager = options.manager
		this.workspace = options.workspace ?? options.manager?.workspace
		this.db = options.db
		this.getPublicUrl = options.getPublicUrl ?? (() => options.publicUrl)
		this.diagnostics = options.diagnostics
		this.previewStartupTimeoutMs = Number.isFinite(options.previewStartupTimeoutMs)
			? Math.max(1, options.previewStartupTimeoutMs)
			: DEFAULT_PREVIEW_STARTUP_TIMEOUT_MS
		this.previewProxyRetryDelaysMs = cleanPreviewProxyRetryDelays(options.previewProxyRetryDelaysMs)
		this.previews = new Map()
		this.starts = new Map()
		this.failures = new Map()
	}

	matchHost(host) {
		return matchPreviewHost(host, this.getPublicUrl())
	}

	async resolvePreviewTarget(match) {
		const value = String(match?.scopeId ?? "").trim().toLowerCase()
		if (!/^[a-z0-9]{16}$/.test(value)) throw Object.assign(new Error("preview scope id must be a 16-character lowercase hash"), { status: 400 })
		const rootRecord = await this.db?.getPreviewRoot?.(value)
		if (rootRecord?.scopeKind === PREVIEW_ROOT_KIND_STATIC) {
			const definition = await staticPreviewDefinitionForRecord(this.workspace, rootRecord, match?.name)
			if (definition) return {
				scopeKind: "static",
				scopeId: value,
				rootPath: rootRecord.rootPath,
				projectDir: rootRecord.projectDir,
				definition,
			}
		}
		if (rootRecord?.scopeKind === PREVIEW_ROOT_KIND_SOURCE) {
			const definition = await previewSourceDefinitionForRoot(rootRecord, match, this.workspace)
			if (isStaticPreviewDefinition(definition) && rootRecord.projectDir) return {
				scopeKind: "static",
				scopeId: value,
				rootPath: definition.source.path,
				projectDir: rootRecord.projectDir,
				definition,
			}
			if (rootRecord.projectDir) {
				return {
					scopeKind: "project",
					scopeId: value,
					projectDir: rootRecord.projectDir,
					executionRoot: rootRecord.projectDir,
					definition,
					logPath: projectPreviewLogPath(rootRecord.projectDir, definition.name),
				}
			}
			if (rootRecord.sessionId) {
				const sessionDir = sessionWorkspacePath(rootRecord.sessionId)
				return {
					scopeKind: "session",
					scopeId: value,
					sessionId: rootRecord.sessionId,
					sessionDir,
					executionRoot: sessionDir,
					definition,
					logPath: previewLogPath(sessionDir, definition.name),
				}
			}
		}
		const sessionMatches = await Promise.all(((await this.db?.listSessions?.(undefined, { includeHidden: true })) ?? []).map(async (entry) => {
			const sessionDir = sessionWorkspacePath(entry.id)
			if (sessionPreviewScopeId(sessionDir) !== value) return undefined
			const manifest = await readSessionPreviewDefinitions(sessionDir)
			const definition = manifest.previews[match.name]
			if (!definition) return undefined
			return {
				scopeKind: "session",
				scopeId: value,
				sessionId: entry.id,
				sessionDir,
				executionRoot: sessionDir,
				definition,
				logPath: previewLogPath(sessionDir, definition.name),
			}
		}))
		const projectMatches = []
		if (rootRecord?.scopeKind === PREVIEW_ROOT_KIND_PROJECT && rootRecord.projectDir) {
			const manifest = await this.workspace.previews.projectManifest(rootRecord.projectDir)
			const definition = manifest.previews[match.name]
			if (definition && !isStaticPreviewDefinition(definition)) {
				projectMatches.push({
					scopeKind: "project",
					scopeId: value,
					projectDir: rootRecord.projectDir,
					executionRoot: rootRecord.projectDir,
					definition,
					logPath: projectPreviewLogPath(rootRecord.projectDir, definition.name),
				})
			}
		}
		const matches = [...sessionMatches, ...projectMatches].filter(Boolean)
		if (matches.length === 1) return matches[0]
		if (matches.length > 1) throw Object.assign(new Error(`Ambiguous preview scope id ${value}`), { status: 400 })
		throw Object.assign(new Error(`Preview scope not found: ${value}`), { status: 404 })
	}

	async definitionFor(match) {
		const publicUrl = this.getPublicUrl()
		if (!publicUrl) throw Object.assign(new Error(`${WEB_BROWSER_UI_NAME} publicUrl is required for previews`), { status: 404 })
		const record = this.manager?.resolvePreviewTarget
			? await this.manager.resolvePreviewTarget(match)
			: await this.resolvePreviewTarget(match)
		if (record.scopeKind === "static" || isStaticPreviewDefinition(record.definition)) {
			return {
				scopeKind: "static",
				scopeId: record.scopeId,
				rootPath: record.rootPath ?? record.definition.source.path,
				projectDir: record.projectDir ?? record.definition.projectDir,
				definition: record.definition,
				publicUrl: previewPublicUrl({ publicUrl, name: record.definition.name, scopeId: record.scopeId, routingSlug: match.routingSlug }),
			}
		}
		if (record.scopeKind === "project") {
			const execution = await this.workspace.previews.process.describe(record.executionRoot ?? record.projectDir, record.definition.cwd)
			return {
				scopeKind: "project",
				projectDir: record.projectDir,
				...execution,
				scopeId: record.scopeId,
				definition: record.definition,
				publicUrl: previewPublicUrl({ publicUrl, name: record.definition.name, scopeId: record.scopeId, routingSlug: match.routingSlug }),
				logPath: record.logPath,
			}
		}
		const execution = await this.workspace.previews.process.describe(record.executionRoot ?? record.sessionDir, record.definition.cwd)
		return {
			scopeKind: "session",
			sessionId: record.sessionId,
			sessionDir: record.sessionDir,
			...execution,
			scopeId: record.scopeId,
			definition: record.definition,
			publicUrl: previewPublicUrl({ publicUrl, name: record.definition.name, scopeId: record.scopeId, routingSlug: match.routingSlug }),
			logPath: record.logPath,
		}
	}

	previewKey(target) {
		return `${target.scopeKind}\0${target.scopeId}\0${target.definition.name}`
	}

	async createStaticPreview(request = {}) {
		const publicUrl = this.getPublicUrl()
		if (!publicUrl) throw Object.assign(new Error(`${WEB_BROWSER_UI_NAME} publicUrl is required for previews`), { status: 404 })
		const managerResolved = typeof this.manager?.resolveStaticPreviewRequest === "function"
		const resolved = managerResolved ? await this.manager.resolveStaticPreviewRequest(request) : request
		const rootPath = resolved.rootPath
		const projectDir = resolved.projectDir
		const relativePath = resolved.relativePath ?? ""
		const routingSlug = resolved.routingSlug ?? request.routingSlug
		if (typeof rootPath !== "string" || !rootPath) throw Object.assign(new Error("static preview rootPath is required"), { status: 400 })
		const definition = resolved.definition ?? (staticPreviewRootIsProjectDocuments(rootPath, projectDir)
			? staticPreviewDefinition(rootPath)
			: undefined)
		if (!isStaticPreviewDefinition(definition) || resolve(definition.source.path) !== resolve(rootPath)) {
			throw Object.assign(new Error("Static document preview root is not configured"), { status: 403 })
		}
		const sourceScoped = managerResolved && resolved.scopeKind === PREVIEW_ROOT_KIND_SOURCE && typeof resolved.scopeId === "string"
		const scopeId = sourceScoped ? resolved.scopeId : staticPreviewScopeId(rootPath)
		const record = sourceScoped ? { rootPath, projectDir } : await this.db?.upsertPreviewRoot?.({
			scopeId,
			scopeKind: PREVIEW_ROOT_KIND_STATIC,
			rootPath,
			projectDir,
		})
		if (!record) throw Object.assign(new Error("Static previews require server database support"), { status: 501 })
		return {
			scopeId,
			rootPath: record.rootPath,
			projectDir: record.projectDir,
			relativePath,
			publicUrl: staticPreviewPublicUrl({
				publicUrl,
				scopeId,
				routingSlug,
				name: definition.name,
				path: encodeStaticPreviewPath(relativePath),
			}),
		}
	}

	async stopPreview(preview) {
		const alreadyStopped = preview.stopped
		preview.stopped = true
		clearTimeout(preview.idleTimer)
		if (this.previews.get(preview.key) === preview) this.previews.delete(preview.key)
		if (alreadyStopped) return
		await this.workspace.previews.process.stop(preview.id).catch(() => {})
	}

	scheduleIdleStop(preview) {
		clearTimeout(preview.idleTimer)
		preview.idleTimer = setTimeout(() => {
			if (Date.now() - preview.lastAccessAt < preview.idleTimeoutMs) {
				this.scheduleIdleStop(preview)
				return
			}
			this.stopPreview(preview).catch(() => {})
		}, Math.max(1000, preview.idleTimeoutMs))
		preview.idleTimer.unref?.()
	}

	async startPreview(key, target, options = {}) {
		const { definition } = target
		const host = DEFAULT_PREVIEW_HOST
		const port = await this.workspace.previews.process.allocatePort(host)
		if (options.cancelled?.()) throw startupCancelledError()
		const id = `preview:${target.scopeKind}:${target.scopeId}:${definition.name}`
		const next = {
			id,
			key,
			scopeKind: target.scopeKind,
			name: definition.name,
			definitionKey: previewDefinitionKey(definition),
			host,
			port,
			publicUrl: target.publicUrl,
			logPath: target.logPath,
			executionRoot: target.executionRoot,
			environmentId: target.environmentId,
			cwd: target.cwd,
			definitionPath: definition.configPath,
			command: definition.command,
			idleTimeoutMs: DEFAULT_PREVIEW_IDLE_TIMEOUT_MS,
			lastAccessAt: Date.now(),
			ready: false,
			stopped: false,
			idleTimer: undefined,
		}
		this.previews.set(key, next)
		try {
			if (options.cancelled?.()) throw startupCancelledError()
			const started = await this.workspace.previews.process.start(id, {
				executionRoot: target.executionRoot,
				name: definition.name,
				command: definition.command,
				cwd: definition.cwd,
				host,
				port,
				publicUrl: next.publicUrl,
				logPath: next.logPath,
				appendLog: options.appendLog === true,
			})
			if (options.cancelled?.()) throw startupCancelledError()
			next.host = started?.host ?? host
			next.port = started?.port ?? port
			next.bindHost = started?.bindHost
			next.bindPort = started?.bindPort
			next.environmentId = started?.environmentId ?? next.environmentId
			next.cwd = started?.cwd ?? next.cwd
			if (started?.logPath !== undefined && started.logPath !== next.logPath) {
				throw new Error(`Preview process reported log path ${started.logPath}, expected ${next.logPath}`)
			}
			this.scheduleIdleStop(next)
			await waitForPreviewHealth(this.workspace, next, definition.healthPath, this.previewStartupTimeoutMs, { cancelled: () => next.stopped || options.cancelled?.() })
			next.ready = true
			this.scheduleIdleStop(next)
			return next
		} catch (err) {
			const inspection = err?.previewInspection ?? (await this.workspace.previews.process.touch(id).catch(() => undefined))?.preview
			let logText = ""
			try {
				logText = next.scopeKind === "project"
					? await this.workspace.previews.readProjectLog(target.projectDir, definition.name, MAX_PREVIEW_STARTUP_LOG_BYTES)
					: await readPreviewLog(next.logPath, MAX_PREVIEW_STARTUP_LOG_BYTES)
			} catch {}
			await this.stopPreview(next)
			if (err?.cancelled) throw err
			throw startupFailure(err, next, definition, inspection, logText)
		}
	}

	startPromiseFor(key, target, options = {}) {
		let start = this.starts.get(key)
		if (!start) {
			this.failures.delete(key)
			const { definition } = target
			const definitionKey = previewDefinitionKey(definition)
			start = {
				cancelled: false,
				definitionKey,
				promise: undefined,
			}
			start.promise = this.startPreview(key, target, {
				appendLog: options.appendLog,
				cancelled: () => start.cancelled,
			})
				.catch((err) => {
					if (!err?.cancelled) this.failures.set(key, {
						definitionKey,
						message: err?.message ?? String(err),
						status: Number.isInteger(err?.status) ? err.status : 502,
						at: Date.now(),
					})
					throw err
				})
				.finally(() => {
					if (this.starts.get(key) === start) this.starts.delete(key)
				})
			this.starts.set(key, start)
			start.promise.catch(() => {})
		}
		return start.promise
	}

	async restartPreview(match) {
		const target = await this.definitionFor(match)
		if (target.scopeKind === "static") return await this.previewStatus(match)
		const key = this.previewKey(target)
		const start = this.starts.get(key)
		if (start) {
			start.cancelled = true
			this.starts.delete(key)
		}
		const existing = this.previews.get(key)
		if (existing) await this.stopPreview(existing)
		this.failures.delete(key)
		await this.startPromiseFor(key, target, { appendLog: true })
		return await this.previewStatus(match)
	}

	async previewFor(match) {
		const target = await this.definitionFor(match)
		if (target.scopeKind === "static") return target
		const { definition } = target
		const key = this.previewKey(target)
		const definitionKey = previewDefinitionKey(definition)
		const existing = this.previews.get(key)
		if (existing && existing.definitionKey === definitionKey) {
			if (existing.ready) {
				existing.lastAccessAt = Date.now()
				this.scheduleIdleStop(existing)
				const touched = await this.workspace.previews.process.touch(existing.id).catch(() => ({ ok: false }))
				if (touched?.ok !== false && touched?.preview?.running !== false) return existing
				await this.stopPreview(existing)
			}
		} else if (existing) await this.stopPreview(existing)
		return await this.startPromiseFor(key, target)
	}

	async previewState(match, options = {}) {
		const target = await this.definitionFor(match)
		const { definition } = target
		const key = this.previewKey(target)
		const definitionKey = previewDefinitionKey(definition)
		const base = {
			key,
			scopeKind: target.scopeKind,
			...(target.sessionId ? { sessionId: target.sessionId } : {}),
			name: definition.name,
			definitionKey,
			publicUrl: target.publicUrl,
			logPath: target.logPath,
			projectDir: target.projectDir,
			definitionPath: definition.configPath,
			executionRoot: target.executionRoot,
			environmentId: target.environmentId,
			cwd: target.cwd,
			command: definition.command,
		}
		if (target.scopeKind === "static") return { ...base, state: "ready", ready: true, rootPath: target.rootPath }
		const existing = this.previews.get(key)
		if (existing && existing.definitionKey !== definitionKey) {
			if (options.start) await this.stopPreview(existing)
		} else if (existing?.ready) {
			existing.lastAccessAt = Date.now()
			this.scheduleIdleStop(existing)
			return { ...base, ...existing, state: "ready" }
		}
		else if (existing) {
			existing.lastAccessAt = Date.now()
			this.scheduleIdleStop(existing)
			return { ...base, ...existing, state: "starting" }
		}

		const failure = this.failures.get(key)
		if (failure?.definitionKey === definitionKey && !options.start) return { ...base, state: "error", error: failure.message, status: failure.status }
		if (this.starts.has(key)) return { ...base, state: "starting" }
		if (options.start) {
			this.startPromiseFor(key, target)
			return { ...base, state: "starting" }
		}
		return { ...base, state: "stopped" }
	}

	async previewStatus(match) {
		const state = await this.previewState(match)
		return {
			state: state.state,
			ready: state.state === "ready",
			name: state.name,
			scopeKind: state.scopeKind,
			publicUrl: state.publicUrl,
			logPath: state.logPath,
			definitionPath: state.definitionPath,
			executionRoot: state.executionRoot,
			environmentId: state.environmentId,
			cwd: state.cwd,
			command: state.command,
			...(state.error ? { error: state.error } : {}),
		}
	}

	async previewShell(request, match, state = undefined) {
		state ??= await this.previewState(match, { start: true })
		return previewShellResponse({
			name: state.name,
			title: `${state.name} preview`,
			targetUrl: previewTargetUrl(state, request),
			statusUrl: previewControlUrl(state, PREVIEW_STATUS_PATH),
			logUrl: previewControlUrl(state, PREVIEW_LOG_PATH),
			restartUrl: previewControlUrl(state, PREVIEW_RESTART_PATH),
		})
	}

	async previewLogPage(request, match) {
		const state = await this.previewState(match)
		return previewLogPageResponse({
			name: state.name,
			title: `${state.name} preview logs`,
			targetUrl: previewReturnUrl(state, request),
			statusUrl: previewControlUrl(state, PREVIEW_STATUS_PATH),
			logUrl: previewControlUrl(state, PREVIEW_LOG_PATH),
			restartUrl: previewControlUrl(state, PREVIEW_RESTART_PATH),
		})
	}

	previewProxyEvent(name, preview, request, args = {}) {
		this.diagnostics?.instant?.(name, {
			hop: PREVIEW_PROXY_HOP,
			method: request.method || "GET",
			pathname: requestPathname(request),
			previewName: preview.name,
			scopeKind: preview.scopeKind,
			sessionId: preview.sessionId,
			...args,
		})
	}

	async proxyPreviewResponse(request, preview, options = {}, proxyOptions = {}) {
		const upstream = await this.workspace.previews.process.fetch(request, {
			host: preview.host,
			port: preview.port,
		}, {
			headers: Object.fromEntries(proxyRequestHeaders(request, preview, {
				...options,
				stripAcceptEncoding: proxyOptions.injectPageScripts === true,
			})),
		})
		const headers = proxyResponseHeaders(upstream, preview)
		for (const name of [...upstream.headers.keys()]) upstream.headers.delete(name)
		headers.forEach((value, name) => upstream.headers.set(name, value))
		return upstream
	}

	async proxyPreviewResponseWithRetries(request, preview, options = {}, proxyOptions = {}) {
		const canRetry = retryablePreviewProxyRequest(request)
		let attempt = 0
		for (;;) {
			try {
				return await this.proxyPreviewResponse(request, preview, options, proxyOptions)
			} catch (err) {
				const retryable = canRetry && request.signal?.aborted !== true && isTransientPreviewProxyError(err)
				const delayMs = retryable ? this.previewProxyRetryDelaysMs[attempt] : undefined
				if (delayMs !== undefined) {
					this.previewProxyEvent("preview.proxy.retry", preview, request, {
						attempt: attempt + 1,
						nextAttempt: attempt + 2,
						delayMs,
						error: previewProxyErrorMessage(err),
						...(previewProxyErrorCode(err) ? { errorCode: previewProxyErrorCode(err) } : {}),
					})
					await delay(delayMs)
					if (request.signal?.aborted) throw requestAbortedError()
					attempt += 1
					continue
				}
				const marked = markPreviewProxyError(err, {
					attempts: attempt + 1,
					retryable,
				})
				this.previewProxyEvent("preview.proxy.failure", preview, request, {
					attempts: attempt + 1,
					retryable,
					error: previewProxyErrorMessage(err),
					...(previewProxyErrorCode(err) ? { errorCode: previewProxyErrorCode(err) } : {}),
				})
				throw marked
			}
		}
	}

	async proxyPreviewRequest(request, preview, options = {}, proxyOptions = {}) {
		const response = await this.proxyPreviewResponseWithRetries(request, preview, options, proxyOptions)
		if (!proxyOptions.injectPageScripts) return response
		return await injectPreviewPageScripts(response, {
			logPageUrl: previewControlUrl(preview, PREVIEW_LOG_PAGE_PATH),
			logScriptUrl: previewControlUrl(preview, PREVIEW_INJECT_SCRIPT_PATH),
			frameBridgeScriptUrl: previewControlUrl(preview, PREVIEW_FRAME_BRIDGE_SCRIPT_PATH),
		})
	}

	async fetch(request, options = {}) {
		try {
			const match = this.matchHost(headerHost(request.headers))
			if (!match) return text("Not Found", 404)
			const pathname = canonicalPreviewControlPath(requestPathname(request))
			if (pathname === PREVIEW_STATUS_PATH) return json(await this.previewStatus(match))
			if (pathname === PREVIEW_LOG_PATH) {
				const state = await this.previewState(match)
				const log = state.scopeKind === "project"
					? await this.workspace.previews.readProjectLog(state.projectDir, state.name, MAX_PREVIEW_LOG_BYTES)
					: await readPreviewLog(state.logPath)
				return text(log)
			}
			if (pathname === PREVIEW_INJECT_SCRIPT_PATH) return previewInjectScriptResponse()
			if (pathname === PREVIEW_FRAME_BRIDGE_SCRIPT_PATH) return previewFrameBridgeScriptResponse()
			if (pathname === PREVIEW_OPEN_DOCUMENT_PATH) {
				const target = await this.definitionFor(match)
				if (target.scopeKind !== "static") return text("Not Found", 404)
				return await this.workspace.previews.static.openDocument(request, target, { appPublicUrl: this.getPublicUrl() })
			}
			if (pathname === PREVIEW_LOG_PAGE_PATH) return await this.previewLogPage(request, match)
			if (pathname === PREVIEW_RESTART_PATH) {
				if (request.method !== "POST") return text("Method Not Allowed", 405, { allow: "POST" })
				return json(await this.restartPreview(match))
			}
			if (isPreviewControlPath(pathname)) return text("Not Found", 404)
			const target = await this.definitionFor(match)
			if (target.scopeKind === "static") return await this.workspace.previews.static.fetch(request, target, {
				bridgeScriptPath: PREVIEW_FRAME_BRIDGE_SCRIPT_PATH,
				openDocumentPath: PREVIEW_OPEN_DOCUMENT_PATH,
			})
			const previewPage = wantsPreviewPage(request)
			if (previewPage) {
				const state = await this.previewState(match, { start: true })
				if (state.state !== "ready") return await this.previewShell(request, match, state)
			}
			const preview = await this.previewFor(match)
			return await this.proxyPreviewRequest(request, preview, options, { injectPageScripts: previewPage })
		} catch (err) {
			return routeError(err)
		}
	}

	async upgrade(incoming, socket, head, options = {}) {
		const match = this.matchHost(incoming.headers.host)
		if (!match) return false
		let preview
		try {
			const target = await this.definitionFor(match)
			if (target.scopeKind === "static") {
				socketError(socket, 404, "Not Found")
				return true
			}
			preview = await this.previewFor(match)
		} catch (err) {
			socketError(socket, err?.status ?? 502, err?.message ?? "Preview Error")
			return true
		}
		const publicUrl = new URL(preview.publicUrl)
		const headers = { ...incoming.headers }
		for (const name of Object.keys(headers)) {
			const lower = name.toLowerCase()
			if (
				lower === "cookie"
				|| lower === "authorization"
				|| lower === PREVIEW_AUTHORIZATION_HEADER.toLowerCase()
				|| lower === LEGACY_PREVIEW_AUTHORIZATION_HEADER.toLowerCase()
				|| lower === "host"
				|| lower === "origin"
				|| lower === "referer"
				|| lower.startsWith("sec-fetch-")
			) delete headers[name]
		}
		headers.host = `${preview.host}:${preview.port}`
		headers["x-forwarded-host"] = publicUrl.host
		headers["x-forwarded-proto"] = publicUrl.protocol.slice(0, -1)
		headers.connection = "Upgrade"
		if (incoming.headers.upgrade) headers.upgrade = incoming.headers.upgrade
		const authorization = cleanForwardedAuthorization(options.authorization)
		if (authorization) headers.authorization = authorization

		this.workspace.previews.process.upgrade(incoming, socket, head, {
			host: preview.host,
			port: preview.port,
		}, headers)
		return true
	}

	async close() {
		await Promise.allSettled([...this.previews.values()].map((preview) => this.stopPreview(preview)))
		this.starts.clear()
	}
}
