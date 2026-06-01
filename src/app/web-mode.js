// Browser UI / Pinano server mode. A small stdlib-backed router hosts a JSON/SSE
// API plus a Preact bundle. SQLite sessions are durable transcript state; the server owns
// live per-session Agent runtimes and projects tagged snapshots/events to the
// browser.

import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { watch } from "node:fs"
import { createServer } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { getModelRequestLog, isModelIoLogEnabled } from "../ai-apis/model-io-log.js"
import { getCredential } from "./auth.js"
import {
	codexUsageBaseUrlFromSettings,
	codexUsageStatusTone,
	codexUsageThresholdMessages,
	fetchCodexUsage,
	formatCodexUsage,
	formatCodexUsageLowStatus,
	formatCodexUsageSummary,
} from "./codex-usage.js"
import { authenticateRequestParts } from "./http-auth.js"
import { configRoot, dataRoot } from "./paths.js"
import { openServiceClient } from "./service-mode.js"
import { loadSettings, updateSetting } from "./settings.js"
import { RuntimeManager } from "./server-runtime.js"
import { WebRouter } from "./web-router.js"

/** @typedef {import("./server-db.js").ServerDb} ServerDb */

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, "../web")
const uiDir = join(webRoot, "ui")
const publicDir = join(webRoot, "public")
const katexDir = join(webRoot, "node_modules/katex")
const bundleHelperPath = join(here, "web-bundle-helper.js")

const encoder = new TextEncoder()
const MIN_TOKEN_LENGTH = 16

const WEB_COMMANDS = [
	{ name: "help", description: "show available slash commands" },
	{ name: "hotkeys", description: "show keyboard shortcuts" },
	{ name: "usage", description: "show ChatGPT/Codex usage limits" },
	{ name: "model", description: "select default model for new sessions" },
	{ name: "session", description: "show info about the current session" },
	{ name: "fast", description: "set Codex Fast mode for this session: /fast on|off|status" },
	{ name: "compact", description: "summarize older messages for agent context" },
	{ name: "branch", description: "create a new session from the current conversation branch" },
	{ name: "rewind", description: "rewind to a previous user message or switch to a branch tip" },
	{ name: "abort", description: "abort the running turn" },
]

/**
 * @typedef {object} WebModeOptions
 * @property {string} [sessionId]
 * @property {string} cwd
 * @property {number} [idleRuntimeTtlMs]
 * @property {number} [maxIdleRuntimes]
 * @property {string} [host]
 * @property {number} [port]
 * @property {boolean} [dev]
 * @property {string} [token]
 * @property {string} [publicUrl]
 * @property {boolean} [noContextFiles]
 * @property {string} [initialSessionId]
 */

/**
 * @typedef {object} WebAppOptions
 * @property {string} [token]
 * @property {string} [bundleJs]
 * @property {boolean} [dev]
 * @property {any} [client]
 */

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	})
}

function error(message, status = 400) {
	return json({ error: message }, status)
}

const NO_STORE_HEADERS = {
	"cache-control": "no-store, max-age=0",
	"pragma": "no-cache",
}

const noStoreHeaders = (headers = {}) => ({ ...headers, ...NO_STORE_HEADERS })

function safeAddressHost(host) {
	if (host === "0.0.0.0" || host === "::") return "localhost"
	return host || "127.0.0.1"
}

async function getOrCreateWebToken() {
	const path = join(configRoot(), "web-token")
	try {
		const existing = (await readFile(path, "utf-8")).trim()
		if (existing.length >= MIN_TOKEN_LENGTH) return existing
	} catch {}
	const token = randomUUID()
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, token, { mode: 0o600 })
	return token
}

function waitForEvent(emitter, event) {
	return new Promise((resolve) => emitter.once(event, resolve))
}

function waitForDrainOrClose(stream) {
	if (stream.destroyed) return false
	return new Promise((resolve) => {
		const cleanup = (value) => {
			stream.removeListener("drain", onDrain)
			stream.removeListener("close", onClose)
			resolve(value)
		}
		const onDrain = () => cleanup(true)
		const onClose = () => cleanup(false)
		stream.once("drain", onDrain)
		stream.once("close", onClose)
	})
}

async function writeResponseBody(incoming, outgoing, response) {
	if (incoming.method === "HEAD" || !response.body) return

	const reader = response.body.getReader()
	const closed = waitForEvent(outgoing, "close").then(() => null)
	try {
		for (;;) {
			const chunk = await Promise.race([reader.read(), closed])
			if (!chunk) {
				await reader.cancel().catch(() => {})
				return
			}
			const { done, value } = chunk
			if (done) return
			if (!outgoing.write(value) && !await waitForDrainOrClose(outgoing)) {
				await reader.cancel().catch(() => {})
				return
			}
		}
	} finally {
		reader.releaseLock()
	}
}

async function serve(options, handler) {
	const server = createServer(async (incoming, outgoing) => {
		try {
			const url = `http://${incoming.headers.host || "localhost"}${incoming.url}`
			let body = null
			if (incoming.method !== "GET" && incoming.method !== "HEAD") {
				body = new ReadableStream({
					start(controller) {
						incoming.on("data", (chunk) => controller.enqueue(chunk))
						incoming.on("end", () => controller.close())
						incoming.on("error", (err) => controller.error(err))
					},
					cancel() {
						incoming.destroy()
					},
				})
			}
			const response = await handler(new Request(url, {
				method: incoming.method,
				headers: incoming.headers,
				body,
				duplex: body ? "half" : undefined,
			}))
			response.headers.forEach((value, key) => outgoing.setHeader(key, value))
			outgoing.writeHead(response.status)
			await writeResponseBody(incoming, outgoing, response)
			outgoing.end()
		} catch (err) {
			console.error("web serve error:", err)
			if (!outgoing.headersSent) outgoing.writeHead(500)
			outgoing.end("Internal Server Error")
		}
	})

	return new Promise((resolve, reject) => {
		server.on("error", reject)
		server.listen(options.port ?? 0, options.hostname ?? "127.0.0.1", () => {
			server.removeListener("error", reject)
			resolve({
				address: () => server.address(),
				close: () => server.close(),
			})
		})
	})
}

function abortError() {
	const err = new Error("Web UI bundle was aborted")
	err.name = "AbortError"
	return err
}

function bundleOptions(dev, outdir) {
	return {
		entrypoints: [join(uiDir, "main.tsx")],
		outdir,
		format: "esm",
		target: "browser",
		jsxImportSource: "preact",
		alias: { react: "preact/compat", "react-dom": "preact/compat" },
		define: {
			"process.env.NODE_ENV": dev ? "\"development\"" : "\"production\"",
			"DEV": dev ? "true" : "false",
			"PROD": dev ? "false" : "true",
			"global": "globalThis",
		},
	}
}

function runBundleHelper(optionsPath, signal) {
	if (signal?.aborted) return Promise.reject(abortError())
	return new Promise((resolve, reject) => {
		const child = spawn("qn", [bundleHelperPath, optionsPath], { stdio: ["ignore", "ignore", "pipe"] })
		let stderr = ""
		let settled = false
		let aborted = false
		const cleanup = () => signal?.removeEventListener("abort", onAbort)
		const finish = (fn, value) => {
			if (settled) return
			settled = true
			cleanup()
			fn(value)
		}
		const onAbort = () => {
			aborted = true
			child.kill("SIGTERM")
		}
		signal?.addEventListener("abort", onAbort, { once: true })
		child.stderr?.setEncoding("utf8")
		child.stderr?.on("data", (chunk) => {
			stderr += chunk
		})
		child.on("error", (err) => {
			if (aborted) return finish(reject, abortError())
			const message = err?.code === "ENOENT"
				? "web mode needs qn on PATH to bundle the browser UI"
				: `web UI bundler failed to start: ${err?.message ?? err}`
			finish(reject, new Error(message))
		})
		child.on("close", (code, signalName) => {
			if (settled) return
			if (aborted) finish(reject, abortError())
			else if (code === 0) finish(resolve)
			else finish(reject, new Error(`web UI bundler failed${signalName ? ` (${signalName})` : code === null ? "" : ` with exit code ${code}`}${stderr.trim() ? `:\n${stderr.trim()}` : ""}`))
		})
	})
}

async function bundleUi(dev, { signal } = {}) {
	if (signal?.aborted) throw abortError()
	const outdir = join(dataRoot(), "web-build")
	await rm(outdir, { recursive: true, force: true })
	await mkdir(outdir, { recursive: true })
	const optionsPath = join(outdir, "options.json")
	await writeFile(optionsPath, JSON.stringify(bundleOptions(dev, outdir), null, "\t"))
	await runBundleHelper(optionsPath, signal)
	if (signal?.aborted) throw abortError()
	return readFile(join(outdir, "main.js"), "utf8")
}

function routeSessionId(c) {
	return c.req.param?.("id")
}

async function jsonBody(c) {
	return c.req.json().catch(() => ({}))
}

function isApiPath(url) {
	const { pathname } = new URL(url)
	return pathname === "/api" || pathname.startsWith("/api/")
}

async function serveIndexHtml(c) {
	if (isApiPath(c.req.url)) return error("Not Found", 404)
	return c.html(await readFile(join(publicDir, "index.html"), "utf-8"), 200, noStoreHeaders())
}

function routeError(err) {
	return error(/** @type {any} */ (err)?.message ?? String(err), /** @type {any} */ (err)?.status ?? 400)
}

async function codexUsageWebStatus(settings) {
	const credential = await getCredential("openai-codex")
	if (credential?.kind !== "codex") return { available: false }
	const payload = await fetchCodexUsage({ baseUrl: codexUsageBaseUrlFromSettings(settings) })
	return {
		available: true,
		summary: formatCodexUsageSummary(payload),
		tone: codexUsageStatusTone(payload),
		lowStatus: formatCodexUsageLowStatus(payload),
		details: formatCodexUsage(payload),
		warnings: codexUsageThresholdMessages(payload, new Set()),
	}
}

async function promptSession(manager, sessionId, body) {
	const message = typeof body.message === "string" ? body.message : ""
	if (!message.trim()) return error("message is required")
	const runtime = await manager.getRuntime(sessionId)
	await runtime.prompt(message, body.streamingBehavior)
	manager.setPromptDraft(sessionId, "", { clientId: body.draftClientId, clientSeq: body.draftClientSeq })
	return json({ ok: true, snapshot: await manager.snapshot(sessionId) })
}

async function abortSession(manager, sessionId) {
	const runtime = await manager.getRuntime(sessionId)
	await runtime.abort()
	return json({ ok: true, snapshot: await manager.snapshot(sessionId) })
}

async function rewindSession(manager, sessionId, body) {
	const id = typeof body.id === "string" ? body.id : ""
	if (!id) return error("id is required")
	const runtime = await manager.getRuntime(sessionId)
	if (body.kind === "leaf" || body.targetKind === "leaf") {
		await runtime.switchBranchTip(id)
		return json({ ok: true, targetKind: "leaf", editorText: "", snapshot: await manager.snapshot(sessionId) })
	}
	const editorText = await runtime.rewind(id, {
		restoreFiles: body.restoreFiles === true,
		restoreConversation: body.restoreConversation !== false,
	})
	return json({ ok: true, targetKind: "message", editorText, snapshot: await manager.snapshot(sessionId) })
}

async function createBaseWebApp(opts, appOptions = {}) {
	const app = new WebRouter()
	const token = appOptions.token || opts.token || await getOrCreateWebToken()
	let bundleJs = appOptions.bundleJs ?? await bundleUi(!!appOptions.dev)
	if (appOptions.dev) {
		let buildGeneration = 0
		let activeBuild
		const rebuild = async (filename) => {
			console.log(`web ui change (${filename}); rebuilding…`)
			const generation = ++buildGeneration
			const previous = activeBuild
			previous?.controller.abort()
			await previous?.done.catch(() => {})
			if (generation !== buildGeneration) return

			const controller = new AbortController()
			const done = bundleUi(true, { signal: controller.signal })
			activeBuild = { controller, done }
			try {
				const nextBundle = await done
				if (generation === buildGeneration) bundleJs = nextBundle
			} catch (err) {
				if (!controller.signal.aborted) console.error("web ui rebuild failed:", /** @type {any} */ (err)?.message ?? err)
			} finally {
				if (activeBuild?.done === done) activeBuild = undefined
			}
		}
		watch(uiDir, { recursive: true }, (_event, filename) => {
			void rebuild(filename)
		})
	}

	app.use("*", async (c, next) => {
		await next()
		c.res.headers.set("X-Content-Type-Options", "nosniff")
		c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
		c.res.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		c.res.headers.set("X-Frame-Options", "SAMEORIGIN")
	})

	app.use("/api/*", async (c, next) => {
		const auth = authenticateRequestParts({
			url: c.req.url,
			authorization: c.req.header("authorization"),
			origin: c.req.header("origin"),
		}, token, { checkOrigin: true })
		if (!auth.ok) return c.json({ error: auth.error }, auth.status)
		return next()
	})

	app.get("/api/model-io/enabled", (c) => c.json({ enabled: isModelIoLogEnabled() }))
	app.get("/api/model-io/requests/:id", (c) => {
		if (!isModelIoLogEnabled()) return error("model I/O logging is not enabled", 404)
		const id = c.req.param?.("id")
		const log = getModelRequestLog(id)
		if (!log) return error("model I/O request not found", 404)
		return c.json({ log })
	})

	app.get("/main.js", (c) => c.body(bundleJs, 200, noStoreHeaders({ "content-type": "application/javascript; charset=utf-8" })))
	app.get("/main.css", async (c) => c.body(await readFile(join(publicDir, "main.css"), "utf-8"), 200, noStoreHeaders({ "content-type": "text/css; charset=utf-8" })))
	app.get("/assets/katex/katex.min.css", async (c) => c.body(await readFile(join(katexDir, "katex.min.css"), "utf-8"), 200, noStoreHeaders({ "content-type": "text/css; charset=utf-8" })))
	app.get("/assets/katex/fonts/:file", async (c) => {
		const file = c.req.param?.("file") || ""
		if (!/^[A-Za-z0-9_.-]+\.(woff2?|ttf)$/.test(file)) return error("font not found", 404)
		const type = file.endsWith(".ttf") ? "font/ttf" : file.endsWith(".woff") ? "font/woff" : "font/woff2"
		try {
			return c.body(await readFile(join(katexDir, "fonts", file)), 200, noStoreHeaders({ "content-type": type }))
		} catch {
			return error("font not found", 404)
		}
	})

	return { app, token }
}

/**
 * Service-backed browser gateway. This is the production web path: the web
 * router serves static assets/auth, while all session state and live runtimes are owned by
 * the same service used by the TUI.
 * @param {WebModeOptions} opts
 * @param {WebAppOptions} [appOptions]
 */
export async function createServiceWebApp(opts, appOptions = {}) {
	const { app, token } = await createBaseWebApp(opts, appOptions)
	const client = appOptions.client ?? await openServiceClient({
		cwd: opts.cwd,
		noContextFiles: opts.noContextFiles,
	})
	let initialSessionId = opts.initialSessionId || opts.sessionId || ""

	const sessions = () => client.sessions()
	const ensureInitialSessionId = async () => {
		if (initialSessionId) return initialSessionId
		const list = await sessions()
		if (list[0]?.id) {
			initialSessionId = list[0].id
			return initialSessionId
		}
		const created = await client.createSession()
		initialSessionId = created.sessionId || created.snapshot?.sessionId
		return initialSessionId
	}
	const snapshot = async (id = undefined) => client.snapshot(id || await ensureInitialSessionId(), { includeSessions: true })
	const currentSettings = async () => (await client.getSettings?.())?.settings ?? await loadSettings()
	const snapshotFromResponse = async (sessionId, response) => {
		const snap = response?.snapshot
		if (snap?.sessions) return snap
		return snapshot(snap?.sessionId || sessionId)
	}
	const streamEvents = async (requestedSessionId) => {
		let unsubscribe = () => {}
		return new Response(new ReadableStream({
			async start(controller) {
				let closed = false
				const send = (event) => {
					if (closed) return
					try {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
					} catch {
						closed = true
						unsubscribe()
					}
				}
				try {
					if (requestedSessionId) send({ type: "snapshot", sessionId: requestedSessionId, snapshot: await snapshot(requestedSessionId) })
					else send({ type: "sessions", sessions: await sessions() })
					unsubscribe = client.subscribe((event) => send(event))
				} catch (err) {
					send({ type: "error", error: /** @type {any} */ (err)?.message ?? String(err) })
					closed = true
					controller.close()
				}
			},
			cancel() {
				unsubscribe()
			},
		}), {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				"connection": "keep-alive",
			},
		})
	}

	app.get("/api/events", async (c) => {
		const url = new URL(c.req.url)
		return streamEvents(url.searchParams.get("sessionId") || undefined)
	})
	app.get("/api/snapshot", async (c) => {
		const url = new URL(c.req.url)
		try {
			return c.json(await snapshot(url.searchParams.get("sessionId") || undefined))
		} catch (err) {
			return routeError(err)
		}
	})
	app.get("/api/sessions", async (c) => c.json({ sessions: await sessions() }))
	app.get("/api/usage/codex", async (c) => {
		try {
			return c.json(await codexUsageWebStatus(await currentSettings()))
		} catch (err) {
			return routeError(err)
		}
	})
	app.get("/api/settings", async (c) => c.json(await client.getSettings()))
	app.post("/api/settings", async (c) => {
		try {
			const body = await jsonBody(c)
			if (Object.hasOwn(body, "model")) return json(await client.setDefaultModel(body.model))
			return error("no supported settings provided")
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions", async (c) => {
		try {
			const body = await jsonBody(c)
			const prompt = typeof body.prompt === "string" ? body.prompt : undefined
			const created = await client.createSession({ prompt })
			const id = created.sessionId || created.snapshot?.sessionId
			return json({ ok: true, snapshot: await snapshot(id) })
		} catch (err) {
			return routeError(err)
		}
	})
	app.get("/api/sessions/:id/snapshot", async (c) => {
		try {
			return c.json(await snapshot(routeSessionId(c)))
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/prompt", async (c) => {
		try {
			const id = routeSessionId(c)
			const body = await jsonBody(c)
			const message = typeof body.message === "string" ? body.message : ""
			if (!message.trim()) return error("message is required")
			const result = await client.prompt(id, message, body.streamingBehavior, { draftClientId: body.draftClientId, draftClientSeq: body.draftClientSeq })
			return json({ ok: true, snapshot: await snapshotFromResponse(id, result) })
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/draft", async (c) => {
		try {
			const id = routeSessionId(c)
			const body = await jsonBody(c)
			const text = typeof body.text === "string" ? body.text : ""
			return json(await client.setPromptDraft(id, text, { clientId: body.clientId, clientSeq: body.clientSeq }))
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/abort", async (c) => {
		try {
			const id = routeSessionId(c)
			const result = await client.abort(id)
			return json({ ok: true, snapshot: await snapshotFromResponse(id, result) })
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/fast", async (c) => {
		try {
			const id = routeSessionId(c)
			const body = await jsonBody(c)
			const result = await client.setFast(id, typeof body.args === "string" ? body.args : "")
			return json({ ok: true, message: result.message, snapshot: await snapshotFromResponse(id, result) })
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/compact", async (c) => {
		try {
			const id = routeSessionId(c)
			const result = await client.compact(id)
			return json({ ok: true, result: result.result, snapshot: await snapshotFromResponse(id, result) })
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/complete", async (c) => {
		try {
			return json(await client.markCompleted(routeSessionId(c)))
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/defer", async (c) => {
		try {
			return json(await client.markDeferred(routeSessionId(c)))
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/review", async (c) => {
		try {
			return json(await client.markReadyForReview(routeSessionId(c)))
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/delete", async (c) => {
		try {
			return json(await client.deleteSession(routeSessionId(c)))
		} catch (err) {
			return routeError(err)
		}
	})
	app.get("/api/sessions/:id/rewind-targets", async (c) => {
		try {
			return c.json({ targets: await client.rewindTargets(routeSessionId(c)) })
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/rewind", async (c) => {
		try {
			const id = routeSessionId(c)
			const body = await jsonBody(c)
			const entryId = typeof body.id === "string" ? body.id : ""
			if (!entryId) return error("id is required")
			const targetKind = body.kind === "leaf" || body.targetKind === "leaf" ? "leaf" : undefined
			const result = await client.rewind(id, entryId, {
				targetKind,
				summary: body.summary === true,
				restoreFiles: body.restoreFiles === true,
				restoreConversation: body.restoreConversation !== false,
			})
			return json({ ok: true, targetKind: result.targetKind ?? targetKind ?? "message", editorText: result.text ?? "", snapshot: await snapshotFromResponse(id, result) })
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/branch", async (c) => {
		try {
			const id = routeSessionId(c)
			const result = await client.branchSession(id)
			return json({ ok: true, sessionId: result.sessionId, snapshot: await snapshotFromResponse(result.sessionId, result), sessions: await sessions() })
		} catch (err) {
			return routeError(err)
		}
	})
	app.get("/api/commands", (c) => c.json({ commands: WEB_COMMANDS }))

	app.get("*", serveIndexHtml)

	return {
		app,
		token,
		client,
		snapshot,
		sendSnapshot: () => {},
		manager: undefined,
		db: undefined,
	}
}

/**
 * Create a web app against the RuntimeManager owned by the service.
 * @param {WebModeOptions & { manager: RuntimeManager, hub: { send: (event: any) => void, stream: (initialEvent: any) => Response }, db: ServerDb, sessionListCwd?: string, getSettings?: () => any | Promise<any>, setDefaultModel?: (model: string) => any | Promise<any> }} opts
 * @param {WebAppOptions} [appOptions]
 */
export async function createManagerWebApp(opts, appOptions = {}) {
	const { app, token } = await createBaseWebApp(opts, appOptions)
	const { manager, hub, db } = opts
	const sessionListCwd = opts.sessionListCwd
	const sessions = () => manager.sessions(sessionListCwd)
	const snapshot = (id = manager.initialSessionId) => manager.snapshot(id, { includeSessions: true })
	const currentSettings = () => opts.getSettings?.() ?? loadSettings()

	if (appOptions.dev) {
		watch(uiDir, { recursive: true }, async (event, filename) => {
			void event
			console.log(`web ui change (${filename}); rebuilding…`)
			try {
				await manager.sendSnapshot(manager.initialSessionId, { includeSessions: true })
			} catch (err) {
				console.error("web ui reload notification failed:", /** @type {any} */ (err)?.message ?? err)
			}
		})
	}

	app.get("/api/events", async (c) => {
		const url = new URL(c.req.url)
		const id = url.searchParams.get("sessionId") || undefined
		return hub.stream(id
			? { type: "snapshot", sessionId: id, snapshot: await snapshot(id) }
			: { type: "sessions", sessions: await sessions() })
	})
	app.get("/api/snapshot", async (c) => {
		const url = new URL(c.req.url)
		try {
			return c.json(await snapshot(url.searchParams.get("sessionId") || undefined))
		} catch (err) {
			return routeError(err)
		}
	})
	app.get("/api/sessions", async (c) => c.json({ sessions: await sessions() }))
	app.get("/api/usage/codex", async (c) => {
		try {
			return c.json(await codexUsageWebStatus(await currentSettings()))
		} catch (err) {
			return routeError(err)
		}
	})
	app.get("/api/settings", async (c) => c.json({ settings: await currentSettings() }))
	app.post("/api/settings", async (c) => {
		try {
			const body = await jsonBody(c)
			if (Object.hasOwn(body, "model")) {
				const model = typeof body.model === "string" ? body.model.trim() : ""
				if (!model) return error("model is required")
				const settings = await (opts.setDefaultModel?.(model) ?? updateSetting("model", model))
				return c.json({ ok: true, settings })
			}
			return error("no supported settings provided")
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions", async (c) => {
		try {
			const body = await jsonBody(c)
			const runtime = await manager.createSession(sessionListCwd || opts.cwd)
			if (typeof body.prompt === "string" && body.prompt.trim()) await runtime.prompt(body.prompt)
			return c.json({ ok: true, snapshot: await snapshot(runtime.sessionId) })
		} catch (err) {
			return routeError(err)
		}
	})
	app.get("/api/sessions/:id/snapshot", async (c) => {
		try {
			return c.json(await snapshot(routeSessionId(c)))
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/prompt", async (c) => {
		try {
			return await promptSession(manager, routeSessionId(c), await jsonBody(c))
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/draft", async (c) => {
		try {
			const body = await jsonBody(c)
			const text = typeof body.text === "string" ? body.text : ""
			return c.json({ ok: true, draft: manager.setPromptDraft(routeSessionId(c), text, { clientId: body.clientId, clientSeq: body.clientSeq }) })
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/abort", async (c) => {
		try {
			return await abortSession(manager, routeSessionId(c))
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/fast", async (c) => {
		try {
			const id = routeSessionId(c)
			const body = await jsonBody(c)
			const runtime = await manager.getRuntime(id)
			const message = await runtime.setFastMode(typeof body.args === "string" ? body.args : "")
			await manager.sendSnapshot(id)
			return c.json({ ok: true, message, snapshot: await runtime.snapshot() })
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/compact", async (c) => {
		try {
			const id = routeSessionId(c)
			const runtime = await manager.getRuntime(id)
			const result = await runtime.compact()
			await manager.sendSnapshot(id)
			return c.json({ ok: true, result, snapshot: await runtime.snapshot() })
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/complete", async (c) => {
		try {
			const metadata = await manager.markCompleted(routeSessionId(c))
			return c.json({ ok: true, metadata, sessions: await sessions() })
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/defer", async (c) => {
		try {
			const metadata = await manager.markDeferred(routeSessionId(c))
			return c.json({ ok: true, metadata, sessions: await sessions() })
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/review", async (c) => {
		try {
			const metadata = await manager.markReadyForReview(routeSessionId(c))
			return c.json({ ok: true, metadata, sessions: await sessions() })
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/delete", async (c) => {
		try {
			await manager.deleteStoppedSession(routeSessionId(c))
			return c.json({ ok: true, sessions: await sessions() })
		} catch (err) {
			return routeError(err)
		}
	})
	app.get("/api/sessions/:id/rewind-targets", async (c) => {
		try {
			return c.json({ targets: (await manager.getRuntime(routeSessionId(c))).rewindTargets() })
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/rewind", async (c) => {
		try {
			return await rewindSession(manager, routeSessionId(c), await jsonBody(c))
		} catch (err) {
			return routeError(err)
		}
	})
	app.post("/api/sessions/:id/branch", async (c) => {
		try {
			const runtime = await manager.branchSession(routeSessionId(c))
			return c.json({ ok: true, sessionId: runtime.sessionId, snapshot: await runtime.snapshot(), sessions: await sessions() })
		} catch (err) {
			return routeError(err)
		}
	})
	app.get("/api/commands", (c) => c.json({ commands: WEB_COMMANDS }))

	app.get("*", serveIndexHtml)

	return {
		app,
		token,
		snapshot,
		sendSnapshot: (id) => manager.sendSnapshot(id ?? manager.initialSessionId, { includeSessions: true }),
		manager,
		db,
	}
}

export function webPublicUrl({ host, port, token, publicUrl }) {
	const displayHost = safeAddressHost(host)
	const url = new URL(publicUrl || `http://${displayHost}:${port}/`)
	url.searchParams.set("token", token)
	return url.href
}

/**
 * @param {WebModeOptions & { manager: RuntimeManager, hub: { send: (event: any) => void, stream: (initialEvent: any) => Response }, db: ServerDb, sessionListCwd?: string, getSettings?: () => any | Promise<any>, setDefaultModel?: (model: string) => any | Promise<any> }} opts
 * @param {WebAppOptions} [appOptions]
 */
export async function startManagerWebServer(opts, appOptions = {}) {
	const webApp = await createManagerWebApp(opts, appOptions)
	const host = opts.host || "127.0.0.1"
	const server = await serve({ port: opts.port ?? 0, hostname: host }, (req) => webApp.app.fetch(req))
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : opts.port
	const url = webPublicUrl({ host, port, token: webApp.token, publicUrl: opts.publicUrl })
	return {
		...webApp,
		server,
		host,
		port,
		url,
		close: () => server.close(),
	}
}


/**
 * @param {WebModeOptions} opts
 * @returns {Promise<void>}
 */
function printWebStatus(web) {
	console.log(`pinano web running at ${web.url}`)
	if (web.host === "0.0.0.0" || web.host === "::") {
		console.warn("pinano web is listening on a non-loopback host; keep the token secret.")
	}
}

export async function runWebMode(opts) {
	const client = await openServiceClient({
		cwd: opts.cwd,
		noContextFiles: opts.noContextFiles,
	})
	const status = await client.webStatus()
	if (status.web?.running) {
		printWebStatus(status.web)
		return
	}
	const result = await client.startWeb({})
	printWebStatus(result.web)
}
