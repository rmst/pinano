import { createWriteStream } from "node:fs"
import { chmod, mkdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { PINANO_DEBUG_REQUEST_HEADER, rejectBrowserDebugRequestParts, requireDebugRequestHeaderParts } from "./http-auth.js"
import { WebRouter } from "./web-router.js"

export const DEBUG_ROUTE_PREFIX = "/_pinano/debug"

const DEFAULT_SECTIONS = ["service", "diagnostics", "events", "runtimes", "workers"]
const MB = 1024 * 1024

export function isDebugRequestPath(pathname) {
	return pathname === DEBUG_ROUTE_PREFIX || pathname.startsWith(`${DEBUG_ROUTE_PREFIX}/`)
}

function boolFromSearch(value, fallback) {
	if (value === null) return fallback
	return ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

function selectedSections(url) {
	const raw = url.searchParams.get("sections")
	if (!raw) return new Set(DEFAULT_SECTIONS)
	return new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))
}

function bytesMb(value) {
	return typeof value === "number" ? Math.round((value / MB) * 1000) / 1000 : undefined
}

function memoryUsage() {
	const memory = typeof process.memoryUsage === "function" ? process.memoryUsage() : {}
	return {
		rss: memory.rss ?? 0,
		heapTotal: memory.heapTotal ?? 0,
		heapUsed: memory.heapUsed ?? 0,
		external: memory.external ?? 0,
		arrayBuffers: memory.arrayBuffers ?? 0,
		rssMb: bytesMb(memory.rss ?? 0),
		heapTotalMb: bytesMb(memory.heapTotal ?? 0),
		heapUsedMb: bytesMb(memory.heapUsed ?? 0),
		externalMb: bytesMb(memory.external ?? 0),
		arrayBuffersMb: bytesMb(memory.arrayBuffers ?? 0),
	}
}

async function heapStatistics() {
	try {
		const v8 = await import("node:v8")
		return typeof v8.getHeapStatistics === "function" ? v8.getHeapStatistics() : undefined
	} catch {
		return undefined
	}
}

function resourceUsage() {
	return typeof process.resourceUsage === "function" ? process.resourceUsage() : undefined
}

function isLoopbackHost(host) {
	const value = String(host || "127.0.0.1").toLowerCase()
	return value === "localhost"
		|| value.endsWith(".localhost")
		|| value === "::1"
		|| value === "[::1]"
		|| value.startsWith("127.")
		|| value.startsWith("::ffff:127.")
}

function guardResponse(context, config, endpoint, capability) {
	const enabled = capability === "heapSnapshot" ? config.heapSnapshot === true : config.inspect === true
	if (!enabled) return context.json({ error: "Pinano debug endpoint is disabled" }, 404)
	if (config.allowNonLoopback !== true && !isLoopbackHost(endpoint?.host)) {
		return context.json({ error: "Pinano debug endpoint is only available on loopback-bound services" }, 403)
	}
	return undefined
}

function capabilityForPath(pathname) {
	if (pathname === `${DEBUG_ROUTE_PREFIX}/heap-snapshot`) return "heapSnapshot"
	if (pathname === `${DEBUG_ROUTE_PREFIX}/inspect` || pathname === `${DEBUG_ROUTE_PREFIX}/inspect/workers`) return "inspect"
	if (pathname.startsWith(`${DEBUG_ROUTE_PREFIX}/inspect/sessions/`)) return "inspect"
	return undefined
}

function createBrowserDebugGuardMiddleware(options) {
	return (context, next) => {
		const config = options.getConfig()
		const capability = capabilityForPath(new URL(context.req.url).pathname)
		const enabled = capability === "heapSnapshot" ? config.heapSnapshot === true : capability === "inspect" && config.inspect === true
		if (!enabled) return next()
		const browserGuard = rejectBrowserDebugRequestParts({
			origin: context.req.header("origin"),
			referer: context.req.header("referer"),
			secFetchSite: context.req.header("sec-fetch-site"),
			secFetchMode: context.req.header("sec-fetch-mode"),
			secFetchDest: context.req.header("sec-fetch-dest"),
			secFetchUser: context.req.header("sec-fetch-user"),
		})
		if (!browserGuard.ok) return context.json({ error: browserGuard.error }, browserGuard.status)
		if (capability === "heapSnapshot") {
			const headerGuard = requireDebugRequestHeaderParts({ debugHeader: context.req.header(PINANO_DEBUG_REQUEST_HEADER) })
			if (!headerGuard.ok) return context.json({ error: headerGuard.error }, headerGuard.status)
		}
		return next()
	}
}

function routeError(context, err) {
	return context.json({ error: err?.message ?? String(err) }, err?.status ?? 400)
}

function safeCall(fn, fallback) {
	try {
		const value = fn()
		return value === undefined ? fallback : value
	} catch (err) {
		return { error: err?.message ?? String(err) }
	}
}

function roughValueBytes(value, seen = new WeakSet()) {
	if (value === undefined || value === null) return 0
	if (typeof value === "string") return Buffer.byteLength(value, "utf-8")
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return 8
	if (typeof value === "symbol" || typeof value === "function") return 0
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + roughValueBytes(item, seen), 0)
	if (typeof value === "object") {
		if (seen.has(value)) return 0
		seen.add(value)
		let total = 0
		for (const [key, item] of Object.entries(value)) total += Buffer.byteLength(key, "utf-8") + roughValueBytes(item, seen)
		return total
	}
	return 0
}

function countBy(items, keyForItem) {
	const counts = {}
	for (const item of items) {
		const key = keyForItem(item)
		if (!key) continue
		counts[key] = (counts[key] ?? 0) + 1
	}
	return counts
}

function contextLoadSummary(branch) {
	const loads = branch.filter((entry) => entry.type === "context" && entry.contextLoad)
	let fileCount = 0
	let contentBytes = 0
	for (const entry of loads) {
		for (const file of entry.contextLoad?.files ?? []) {
			fileCount += 1
			contentBytes += Buffer.byteLength(file?.content ?? "", "utf-8")
		}
	}
	return {
		loadCount: loads.length,
		fileCount,
		contentBytes,
	}
}

function inspectSession(session) {
	const entries = safeCall(() => session.getEntries(), [])
	const branch = safeCall(() => session.getBranch(), [])
	const messageEntries = Array.isArray(entries) ? entries.filter((entry) => entry.type === "message") : []
	const branchEntries = Array.isArray(branch) ? branch : []
	return {
		id: safeCall(() => session.getMetadata()?.id, undefined),
		cwd: safeCall(() => session.getMetadata()?.cwd, undefined),
		leafId: safeCall(() => session.getLeafId(), undefined),
		mutationVersion: safeCall(() => session.getMutationVersion(), undefined),
		entryCount: Array.isArray(entries) ? entries.length : undefined,
		branchEntryCount: branchEntries.length,
		entryTypes: Array.isArray(entries) ? countBy(entries, (entry) => entry.type) : entries,
		branchEntryTypes: countBy(branchEntries, (entry) => entry.type),
		customTypes: Array.isArray(entries) ? countBy(entries, (entry) => entry.type === "custom" ? entry.customType : undefined) : undefined,
		messageCount: messageEntries.length,
		messageBytes: roughValueBytes(messageEntries.map((entry) => entry.message)),
		contextLoads: contextLoadSummary(branchEntries),
	}
}

function summarizeModelRequest(request) {
	if (!request) return undefined
	return {
		startedAt: request.startedAt,
		provider: request.provider,
		model: request.model,
		transport: request.transport,
		modelRequestId: request.modelRequestId,
	}
}

function inspectAgentState(agent) {
	const state = agent?.state ?? {}
	const messages = Array.isArray(state.messages) ? state.messages : []
	const tools = Array.isArray(state.tools) ? state.tools : []
	const queued = typeof agent?.getQueuedMessages === "function" ? agent.getQueuedMessages() : []
	return {
		model: state.model ? { id: state.model.id, provider: state.model.provider, transport: state.model.transport } : undefined,
		thinkingLevel: state.thinkingLevel,
		serviceTier: state.serviceTier,
		isStreaming: state.isStreaming === true,
		messageCount: messages.length,
		messageBytes: roughValueBytes(messages),
		streamingMessageBytes: roughValueBytes(state.streamingMessage),
		toolCount: tools.length,
		toolNames: tools.map((tool) => tool?.name).filter(Boolean),
		pendingToolCallCount: state.pendingToolCalls?.size ?? 0,
		errorMessage: state.errorMessage,
		currentModelRequest: summarizeModelRequest(state.currentModelRequest),
		queuedMessageCount: Array.isArray(queued) ? queued.length : undefined,
	}
}

function inspectRuntime(runtime, now = Date.now()) {
	const activeToolCalls = [...(runtime.activeToolCalls?.values?.() ?? [])]
	const currentPrompt = runtime.currentPrompt
	return {
		sessionId: runtime.sessionId,
		cwd: runtime.cwd,
		disposed: runtime.disposed === true,
		streaming: runtime.isStreaming?.() === true,
		backgroundWork: runtime.hasBackgroundWork?.() === true,
		lastActiveAgeMs: now - (runtime.lastActiveAt ?? now),
		currentRunId: runtime.currentRunId,
		finishedRunCount: runtime.finishedRunIds?.size,
		activeToolCallCount: activeToolCalls.length,
		activeToolCalls: activeToolCalls.map((tool) => ({
			id: tool.id,
			name: tool.name,
			argsBytes: roughValueBytes(tool.args),
		})),
		currentPrompt: currentPrompt ? {
			runId: currentPrompt.runId,
			textBytes: Buffer.byteLength(currentPrompt.text ?? "", "utf-8"),
			imageCount: Array.isArray(currentPrompt.images) ? currentPrompt.images.length : 0,
			userEntryId: currentPrompt.userEntryId,
		} : undefined,
		session: runtime.session ? inspectSession(runtime.session) : undefined,
		agent: inspectAgentState(runtime.agent),
	}
}

function inspectRuntimeManager(manager, now = Date.now()) {
	const runtimes = [...manager.runtimes.values()]
	return {
		initialSessionId: manager.initialSessionId,
		runtimeCount: runtimes.length,
		runningRuntimeCount: runtimes.filter((runtime) => runtime.isStreaming?.() === true).length,
		backgroundRuntimeCount: runtimes.filter((runtime) => runtime.hasBackgroundWork?.() === true).length,
		idleRuntimeTtlMs: manager.idleRuntimeTtlMs,
		maxIdleRuntimes: manager.maxIdleRuntimes,
		eventSeqCount: manager.eventSeqs?.size,
		viewEpochCount: manager.viewEpochs?.size,
		runtimes: runtimes.map((runtime) => inspectRuntime(runtime, now)),
	}
}

async function inspectWorkers(manager, options = {}) {
	const seen = new Set()
	const executors = []
	for (const runtime of manager.runtimes.values()) {
		const executor = runtime.agent?.toolExecutor
		if (!executor || typeof executor.inspect !== "function" || seen.has(executor)) continue
		seen.add(executor)
		let inspect
		try {
			inspect = await executor.inspect({ timeoutMs: options.timeoutMs })
		} catch (err) {
			inspect = { error: err?.message ?? String(err) }
		}
		executors.push({ sessionId: runtime.sessionId, inspect })
	}
	return {
		executorCount: executors.length,
		executors,
	}
}

async function serviceSummary(state) {
	return {
		pid: process.pid,
		startedAt: state.serviceStartedAt,
		uptimeMs: Date.now() - state.processStartedAtMs,
		serviceRunId: state.serviceRunId,
		cwd: state.cwd,
		endpoint: state.endpoint,
		protocolVersion: state.protocolVersion,
		codeFingerprint: state.codeFingerprint,
		runtimeKey: state.runtimeKey,
		packageName: state.packageName,
		packageVersion: state.packageVersion,
		mainPath: state.mainPath,
		sourceRoot: state.sourceRoot,
		packageRoot: state.packageRoot,
		execPath: process.execPath,
		activeRequests: state.activeRequests,
		web: state.web,
		memory: memoryUsage(),
		heapStatistics: await heapStatistics(),
		resourceUsage: resourceUsage(),
	}
}

async function collectInspect(options, requestUrl) {
	const now = Date.now()
	const url = new URL(requestUrl)
	const sections = selectedSections(url)
	const workerTimeoutMs = Number(url.searchParams.get("workerTimeoutMs"))
	const includeWorkers = boolFromSearch(url.searchParams.get("workers"), sections.has("workers"))
	const manager = options.getManager()
	const result = {
		ok: true,
		generatedAt: new Date(now).toISOString(),
		sections: [...sections],
	}
	if (sections.has("service")) result.service = await serviceSummary(options.getServiceState())
	if (sections.has("diagnostics")) result.diagnostics = options.getDiagnostics()?.status?.()
	if (sections.has("events")) result.events = options.getEventHub()?.inspect?.(now)
	if (sections.has("runtimes")) result.runtimeManager = inspectRuntimeManager(manager, now)
	if (includeWorkers) result.workers = await inspectWorkers(manager, {
		timeoutMs: Number.isFinite(workerTimeoutMs) && workerTimeoutMs > 0 ? workerTimeoutMs : undefined,
	})
	return result
}

async function writeHeapSnapshot(dir) {
	let v8
	try {
		v8 = await import("node:v8")
	} catch (err) {
		throw Object.assign(new Error(`Heap snapshots are not supported by this runtime: ${err?.message ?? err}`), { status: 501 })
	}
	if (typeof v8.getHeapSnapshot !== "function") throw Object.assign(new Error("Heap snapshots are not supported by this runtime"), { status: 501 })
	const { pipeline } = await import("node:stream/promises")
	await mkdir(dir, { recursive: true })
	const timestamp = new Date().toISOString().replace(/[^0-9A-Za-z.-]/g, "_")
	const path = join(dir, `pinano-service-${process.pid}-${timestamp}.heapsnapshot`)
	await pipeline(v8.getHeapSnapshot(), createWriteStream(path, { mode: 0o600 }))
	await chmod(path, 0o600).catch(() => {})
	const info = await stat(path)
	return { path, bytes: info.size }
}

export function createDebugInspectApp(options) {
	const app = new WebRouter()
	app.use(`${DEBUG_ROUTE_PREFIX}/*`, createBrowserDebugGuardMiddleware(options))

	const safe = (capability, handler) => async (context) => {
		try {
			const config = options.getConfig()
			const guard = guardResponse(context, config, options.getEndpoint(), capability)
			if (guard) return guard
			return await handler(context)
		} catch (err) {
			return routeError(context, err)
		}
	}

	app.get(`${DEBUG_ROUTE_PREFIX}/inspect`, safe("inspect", async (context) =>
		context.json(await collectInspect(options, context.req.url))))
	app.get(`${DEBUG_ROUTE_PREFIX}/inspect/workers`, safe("inspect", async (context) => {
		const url = new URL(context.req.url)
		const workerTimeoutMs = Number(url.searchParams.get("workerTimeoutMs"))
		return context.json({
			ok: true,
			generatedAt: new Date().toISOString(),
			workers: await inspectWorkers(options.getManager(), {
				timeoutMs: Number.isFinite(workerTimeoutMs) && workerTimeoutMs > 0 ? workerTimeoutMs : undefined,
			}),
		})
	}))
	app.get(`${DEBUG_ROUTE_PREFIX}/inspect/sessions/:id`, safe("inspect", async (context) => {
		const rawId = context.req.param("id") ?? ""
		const id = options.resolveSessionId ? options.resolveSessionId(rawId) : rawId
		const runtime = options.getManager().runtimes.get(id)
		return context.json({
			ok: true,
			generatedAt: new Date().toISOString(),
			sessionId: id,
			loaded: Boolean(runtime),
			runtime: runtime ? inspectRuntime(runtime) : undefined,
		})
	}))
	app.post(`${DEBUG_ROUTE_PREFIX}/heap-snapshot`, safe("heapSnapshot", async (context) =>
		context.json({ ok: true, heapSnapshot: await writeHeapSnapshot(options.heapSnapshotDir()) })))
	app.use(`${DEBUG_ROUTE_PREFIX}/*`, (context) => context.json({ error: "Not Found" }, 404))
	app.use(DEBUG_ROUTE_PREFIX, (context) => context.json({ error: "Not Found" }, 404))
	return app
}
