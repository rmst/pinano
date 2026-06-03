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
import { RuntimeManager } from "./server-runtime.js"
import { WebRouter } from "./web-router.js"
import { createManagerClientApi, createServiceClientApi, registerClientApiRoutes } from "./client-api.js"
import { writeResponseBody } from "./http-response.js"

/** @typedef {import("./server-db.js").ServerDb} ServerDb */

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, "../web")
const uiDir = join(webRoot, "ui")
const publicDir = join(webRoot, "public")
const katexDir = join(webRoot, "node_modules/katex")
const bundleHelperPath = join(here, "web-bundle-helper.js")

const MIN_TOKEN_LENGTH = 16


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
			if (!outgoing.destroyed) outgoing.end()
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
	const api = createServiceClientApi({
		client,
		cwd: opts.cwd,
		initialSessionId: opts.initialSessionId || opts.sessionId,
	})

	registerClientApiRoutes(app, api, {
		prefix: "/api",
		includeCommands: true,
		includeSnapshotRoute: true,
		includeSessionsInSnapshots: true,
	})
	app.get("/api/usage/codex", async (c) => {
		try {
			return c.json(await codexUsageWebStatus((await api.getSettings()).settings))
		} catch (err) {
			return routeError(err)
		}
	})

	app.get("*", serveIndexHtml)

	return {
		app,
		token,
		client,
		snapshot: api.snapshot,
		invalidateSnapshot: () => {},
		manager: undefined,
		db: undefined,
	}
}

/**
 * Create a web app against the RuntimeManager owned by the service.
 * @param {WebModeOptions & { manager: RuntimeManager, hub: { send: (event: any) => void, stream: (initialEvent: any) => Response }, db: ServerDb, sessionListCwd?: string, getSettings?: () => any | Promise<any>, setDefaultModel?: (model: string) => any | Promise<any>, setDefaultReasoning?: (level: string) => any | Promise<any> }} opts
 * @param {WebAppOptions} [appOptions]
 */
export async function createManagerWebApp(opts, appOptions = {}) {
	const { app, token } = await createBaseWebApp(opts, appOptions)
	const { manager, hub, db } = opts
	const sessionListCwd = opts.sessionListCwd
	const api = createManagerClientApi({
		cwd: opts.cwd,
		manager,
		hub,
		sessionListCwd,
		getSettings: opts.getSettings,
		setDefaultModel: opts.setDefaultModel,
		setDefaultReasoning: opts.setDefaultReasoning,
	})

	if (appOptions.dev) {
		watch(uiDir, { recursive: true }, async (event, filename) => {
			void event
			console.log(`web ui change (${filename}); rebuilding…`)
			try {
				await manager.invalidateSnapshot(manager.initialSessionId, { includeSessions: true })
			} catch (err) {
				console.error("web ui reload notification failed:", /** @type {any} */ (err)?.message ?? err)
			}
		})
	}

	registerClientApiRoutes(app, api, {
		prefix: "/api",
		includeCommands: true,
		includeSnapshotRoute: true,
		includeSessionsInSnapshots: true,
	})
	app.get("/api/usage/codex", async (c) => {
		try {
			return c.json(await codexUsageWebStatus((await api.getSettings()).settings))
		} catch (err) {
			return routeError(err)
		}
	})

	app.get("*", serveIndexHtml)

	return {
		app,
		token,
		snapshot: api.snapshot,
		invalidateSnapshot: (id) => manager.invalidateSnapshot(id ?? manager.initialSessionId, { includeSessions: true }),
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
 * @param {WebModeOptions & { manager: RuntimeManager, hub: { send: (event: any) => void, stream: (initialEvent: any) => Response }, db: ServerDb, sessionListCwd?: string, getSettings?: () => any | Promise<any>, setDefaultModel?: (model: string) => any | Promise<any>, setDefaultReasoning?: (level: string) => any | Promise<any> }} opts
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
