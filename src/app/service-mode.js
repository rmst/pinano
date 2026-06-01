// Local supervisor service for background Pinano agent sessions.
//
// The service owns RuntimeManager and all live Agent runtimes for one Pinano home.
// Frontends (agent view, open routes, shell helpers, and web) talk to it over
// one authenticated local HTTP/SSE endpoint over loopback TCP.

import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { appendFile, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import * as http from "node:http"
import { createInterface } from "node:readline/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { normalizeReasoningLevel } from "../reasoning.js"
import { dataRoot } from "./paths.js"
import { parseBashShortcut, runBashShortcut, recordBashShortcut } from "./bash-shortcut.js"
import { loadSettings, updateSetting } from "./settings.js"
import { RuntimeManager } from "./server-runtime.js"
import { authenticateRequest } from "./http-auth.js"
import { configuredServiceDiagnostics, configuredServiceEndpointDefaults, configuredServiceToken, configuredWebDefaults } from "./service-config.js"
import { createServiceDiagnostics } from "./service-diagnostics.js"

/** @typedef {import("./agent-runtime.js").AgentRuntime} Agent */

export const SERVICE_PROTOCOL_VERSION = 4

const SERVICE_IDLE_SHUTDOWN_DELAY_MS = 1000
const DESIRED_RUNTIME_LOCK_TTL_MS = 10000
const DESIRED_RUNTIME_LOCK_TIMEOUT_MS = DESIRED_RUNTIME_LOCK_TTL_MS + 2000
const SERVICE_UPGRADE_SOFT_WAIT_MS = 5000
const SERVICE_UPGRADE_BLOCKED_POLL_MS = 1000
const processStartedAtMs = Date.now()

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = join(here, "..")
const packageRoot = join(sourceRoot, "..")
const mainPath = join(here, "main.js")
const encoder = new TextEncoder()
const INFO_PATH = Symbol("serviceInfoPath")

function configuredServiceDir() {
	return process.env.PINANO_SERVICE_DIR || process.env.PINANO_DAEMON_DIR
}

function serviceDir() {
	const root = configuredServiceDir() || join(dataRoot(), "services")
	return join(root, "global")
}

function serviceInfoPath() {
	return join(serviceDir(), "service.json")
}

function legacyServiceInfoPath() {
	const root = process.env.PINANO_DAEMON_DIR || join(dataRoot(), "daemons")
	return join(root, "global", "daemon.json")
}

function desiredRuntimeIdentityPath() {
	return join(serviceDir(), "desired-runtime.json")
}

function legacyDesiredRuntimeIdentityPath() {
	const root = process.env.PINANO_DAEMON_DIR || join(dataRoot(), "daemons")
	return join(root, "global", "desired-runtime.json")
}

function desiredRuntimeLockPath() {
	return join(serviceDir(), "desired-runtime.lock")
}

function serviceLogPath() {
	return join(serviceDir(), "service.log")
}

async function appendServiceLog(event, details = {}) {
	try {
		await mkdir(serviceDir(), { recursive: true })
		await appendFile(serviceLogPath(), `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`)
	} catch {}
}

async function openOwnedServerDb(options) {
	const { openServerDb } = await import("./server-db.js")
	return openServerDb(options)
}

function servicePid(info) {
	const pid = Number(info?.pid)
	return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

function processExists(pid) {
	if (!pid) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (/** @type {any} */ err) {
		return err?.code === "EPERM"
	}
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForProcessExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (!processExists(pid)) return true
		await delay(50)
	}
	return !processExists(pid)
}

async function terminateProcess(pid) {
	if (!processExists(pid)) return true
	try { process.kill(pid, "SIGTERM") } catch {}
	if (await waitForProcessExit(pid, 2000)) return true
	try { process.kill(pid, "SIGKILL") } catch {}
	return waitForProcessExit(pid, 1000)
}

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	})
}

function authError(auth) {
	return json({ error: auth.error || "Unauthorized" }, auth.status || 401)
}

function createServiceToken() {
	return configuredServiceToken() || randomUUID()
}

async function writePrivateJson(path, value) {
	await writeFile(path, JSON.stringify(value, null, "\t"), { mode: 0o600 })
	await chmod(path, 0o600).catch(() => {})
}

const SERVICE_ROUTE_PREFIX = "/service"

function stripServiceRoutePrefix(pathname) {
	if (pathname === SERVICE_ROUTE_PREFIX) return "/"
	if (pathname.startsWith(`${SERVICE_ROUTE_PREFIX}/`)) return pathname.slice(SERVICE_ROUTE_PREFIX.length) || "/"
	return pathname
}

function isServiceRequestPath(pathname) {
	if (pathname === SERVICE_ROUTE_PREFIX || pathname.startsWith(`${SERVICE_ROUTE_PREFIX}/`)) return true
	return pathname === "/health"
		|| pathname === "/events"
		|| pathname === "/interrupt"
		|| pathname === "/settings"
		|| pathname === "/sessions"
		|| pathname.startsWith("/sessions/")
		|| pathname.startsWith("/web/")
		|| pathname.startsWith("/event-clients/")
}

function serviceHostForListen(host) {
	return typeof host === "string" && host ? host : "127.0.0.1"
}

function serviceHostForConnect(host) {
	if (host === "0.0.0.0") return "127.0.0.1"
	if (host === "::") return "::1"
	return serviceHostForListen(host)
}

function listenServer(server, port, host) {
	return new Promise((resolve, reject) => {
		const cleanup = () => server.off("error", onError)
		const onError = (err) => {
			cleanup()
			reject(err)
		}
		server.once("error", onError)
		try {
			server.listen(port, host, () => {
				cleanup()
				resolve(undefined)
			})
		} catch (err) {
			cleanup()
			reject(err)
		}
	})
}

function configuredPortInUseMessage(host, port) {
	return `Configured Pinano service/web port ${port} on ${host} is already in use; falling back to an ephemeral service port for TUI clients. Pinano Web will not start until the configured port is available.`
}

async function listenTcpEndpoint(server, host, requestedPort) {
	const port = Number.isInteger(requestedPort) ? Math.max(0, requestedPort) : 0
	try {
		await listenServer(server, port, host)
		return { requestedPort: port, portFallback: false }
	} catch (err) {
		if (port <= 0 || err?.code !== "EADDRINUSE") throw err
		const message = configuredPortInUseMessage(host, port)
		console.error(message)
		await appendServiceLog("service_configured_port_unavailable", { host, port, error: err?.message ?? String(err) })
		await listenServer(server, 0, host)
		return { requestedPort: port, portFallback: true }
	}
}

async function readPackageMetadata() {
	try {
		const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf-8"))
		return {
			packageName: typeof pkg.name === "string" ? pkg.name : undefined,
			packageVersion: typeof pkg.version === "string" ? pkg.version : undefined,
		}
	} catch {
		return {}
	}
}

// Runtime identity is path/version based rather than a source-tree hash. Jix and
// packaged installs materialize immutable runtime paths, so this avoids making
// every TUI startup walk the source tree while still distinguishing deployments.
function canonicalRuntimeKey(identity) {
	return JSON.stringify({
		packageName: identity?.packageName,
		packageVersion: identity?.packageVersion,
		mainPath: identity?.mainPath,
		packageRoot: identity?.packageRoot,
		execPath: identity?.execPath,
	})
}

function runtimeKey(identity) {
	return typeof identity?.runtimeKey === "string" && identity.runtimeKey ? identity.runtimeKey : canonicalRuntimeKey(identity)
}

function runtimeKeyFingerprint(key) {
	return createHash("sha256").update(key).digest("hex")
}

function serviceRuntimeIdentity(metadata) {
	const identity = { ...metadata, mainPath, sourceRoot, packageRoot, execPath: process.execPath, processStartedAtMs }
	const key = canonicalRuntimeKey(identity)
	return { ...identity, runtimeKey: key, codeFingerprint: runtimeKeyFingerprint(key) }
}

function runtimePathsMatch(candidate, expected) {
	return candidate?.mainPath === expected?.mainPath
		&& candidate?.sourceRoot === expected?.sourceRoot
		&& candidate?.packageRoot === expected?.packageRoot
		&& candidate?.execPath === expected?.execPath
}

function runtimeIdentityMatches(candidate, expected) {
	if (!candidate || !expected) return false
	if (candidate.runtimeKey && expected.runtimeKey) {
		return runtimeKey(candidate) === runtimeKey(expected) && runtimePathsMatch(candidate, expected)
	}
	return runtimePathsMatch(candidate, expected)
}

async function currentRuntimeIdentity() {
	return serviceRuntimeIdentity(await readPackageMetadata())
}

// Capture this process's runtime identity once. Source roots are deployment dirs,
// but the important invariant is still process-local: an already-running TUI must
// not later re-identify itself as another runtime after a newer deployment wins.
const processRuntimeIdentityPromise = currentRuntimeIdentity()

async function processRuntimeIdentity() {
	return processRuntimeIdentityPromise
}

async function readDesiredRuntimeIdentityUnlocked() {
	try {
		return JSON.parse(await readFile(desiredRuntimeIdentityPath(), "utf-8"))
	} catch {
		return null
	}
}

export async function readDesiredRuntimeIdentity() {
	return readDesiredRuntimeIdentityUnlocked()
}

// The desired-runtime document is the single source of truth for both current
// ownership and activation history. Keeping history inside the same locked file
// avoids split-brain rules between separate "current" documents.
function emptyRuntimeState() {
	return { version: 1, currentGeneration: 0, runtimes: {} }
}

function runtimeStateFromDesired(desired) {
	const state = desired?.runtimeState
	return state && typeof state === "object" && state.runtimes && typeof state.runtimes === "object"
		? { ...emptyRuntimeState(), ...state, runtimes: { ...state.runtimes } }
		: emptyRuntimeState()
}

function runtimeSummary(identity) {
	return {
		runtimeKey: runtimeKey(identity),
		codeFingerprint: identity?.codeFingerprint,
		packageName: identity?.packageName,
		packageVersion: identity?.packageVersion,
		mainPath: identity?.mainPath,
		sourceRoot: identity?.sourceRoot,
		packageRoot: identity?.packageRoot,
		execPath: identity?.execPath,
	}
}

function parseSemver(version) {
	const match = String(version ?? "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
	return match ? match.slice(1, 4).map(Number) : null
}

function compareSemver(a, b) {
	const parsedA = parseSemver(a)
	const parsedB = parseSemver(b)
	if (!parsedA || !parsedB) return null
	for (let i = 0; i < 3; i++) {
		if (parsedA[i] > parsedB[i]) return 1
		if (parsedA[i] < parsedB[i]) return -1
	}
	return 0
}

function lowerPackageVersion(candidate, current) {
	if (!candidate?.packageName || candidate.packageName !== current?.packageName) return false
	const compared = compareSemver(candidate.packageVersion, current.packageVersion)
	return compared !== null && compared < 0
}

function desiredHasRuntimeState(desired) {
	return Boolean(desired?.runtimeState && typeof desired.runtimeState === "object" && desired.runtimeState.runtimes && typeof desired.runtimeState.runtimes === "object")
}

function desiredClaimedAfterProcessStarted(desired, identity) {
	const claimedAtMs = Number(desired?.claimedAtMs ?? Date.parse(desired?.writtenAt ?? ""))
	const startedAtMs = Number(identity?.processStartedAtMs ?? processStartedAtMs)
	return Number.isFinite(claimedAtMs) && Number.isFinite(startedAtMs) && claimedAtMs > startedAtMs
}

function runtimeActivationDecision(identity, desired) {
	if (!desired) return { ok: true }
	if (runtimeIdentityMatches(desired, identity)) return { ok: true }
	const key = runtimeKey(identity)
	const currentKey = runtimeKey(desired)
	if (!desiredHasRuntimeState(desired)) {
		if (desiredClaimedAfterProcessStarted(desired, identity)) return { ok: false, reason: "newer_desired", desired }
		return lowerPackageVersion(identity, desired) ? { ok: false, reason: "older_version", desired } : { ok: true }
	}
	const state = runtimeStateFromDesired(desired)
	const seen = state.runtimes?.[key]
	if (seen && currentKey && key !== currentKey) {
		return { ok: false, reason: "superseded", desired }
	}
	if (lowerPackageVersion(identity, desired)) {
		return { ok: false, reason: "older_version", desired }
	}
	return { ok: true }
}

function runtimeStateForActivation(identity, previousDesired = null) {
	const state = runtimeStateFromDesired(previousDesired)
	const key = runtimeKey(identity)
	let generation = Number(state.currentGeneration ?? 0)
	const now = new Date().toISOString()
	const previousKey = previousDesired ? runtimeKey(previousDesired) : null
	if (previousDesired && previousKey && !state.runtimes[previousKey]) {
		generation += 1
		state.runtimes[previousKey] = {
			firstGeneration: generation,
			lastGeneration: generation,
			firstSeenAt: previousDesired.writtenAt ?? previousDesired.startedAt ?? now,
			lastSeenAt: previousDesired.writtenAt ?? previousDesired.startedAt ?? now,
			identity: runtimeSummary(previousDesired),
		}
	}
	if (!state.runtimes[key]) {
		generation += 1
		state.runtimes[key] = { firstGeneration: generation, firstSeenAt: now, identity: runtimeSummary(identity) }
	}
	const entry = state.runtimes[key]
	entry.lastGeneration = entry.lastGeneration ?? entry.firstGeneration ?? generation
	entry.lastSeenAt = now
	entry.identity = runtimeSummary(identity)
	if (previousKey && previousKey !== key && state.runtimes[previousKey]) {
		state.runtimes[previousKey].supersededAt = now
	}
	state.version = 1
	state.currentGeneration = Math.max(generation, Number(entry.lastGeneration ?? 0), Number(state.currentGeneration ?? 0))
	return state
}

async function acquireDesiredRuntimeLock(timeoutMs = DESIRED_RUNTIME_LOCK_TIMEOUT_MS) {
	await mkdir(serviceDir(), { recursive: true })
	const lockPath = desiredRuntimeLockPath()
	const deadline = Date.now() + timeoutMs
	for (;;) {
		try {
			await mkdir(lockPath)
			return async () => rm(lockPath, { recursive: true, force: true }).catch(() => {})
		} catch (/** @type {any} */ err) {
			if (err?.code !== "EEXIST") throw err
			try {
				const s = await stat(lockPath)
				if (Date.now() - s.mtimeMs > DESIRED_RUNTIME_LOCK_TTL_MS) {
					await rm(lockPath, { recursive: true, force: true })
					continue
				}
			} catch {}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for desired runtime lock: ${lockPath}`)
			await delay(25)
		}
	}
}

async function withDesiredRuntimeLock(fn) {
	const release = await acquireDesiredRuntimeLock()
	try {
		return await fn()
	} finally {
		await release()
	}
}

async function writeDesiredRuntimeIdentityUnlocked(identity, claim = {}, previousDesired = null) {
	const claimedAtMs = Date.now()
	const claimedIdentity = {
		...identity,
		claimId: claim.claimId ?? randomUUID(),
		claimedAtMs,
		claimantPid: process.pid,
		clientStartedAtMs: processStartedAtMs,
		claimantStartedAtMs: processStartedAtMs,
		writtenAt: new Date(claimedAtMs).toISOString(),
	}
	const payload = JSON.stringify({
		...claimedIdentity,
		runtimeState: runtimeStateForActivation(claimedIdentity, previousDesired),
	}, null, "\t")
	await writeFile(desiredRuntimeIdentityPath(), payload, { mode: 0o600 })
	const legacyPath = legacyDesiredRuntimeIdentityPath()
	if (legacyPath !== desiredRuntimeIdentityPath()) {
		try {
			await mkdir(dirname(legacyPath), { recursive: true })
			await writeFile(legacyPath, payload, { mode: 0o600 })
		} catch {}
	}
}

function staleRuntimeError(desired, reason = "mismatch") {
	return Object.assign(new Error(`This pinano client is stale (${reason}); desired runtime is ${desired?.mainPath || desired?.packageRoot || "unknown"}. Restart pinano.`), {
		code: "PINANO_STALE_RUNTIME",
		reason,
		desiredRuntime: desired,
	})
}

export async function claimCurrentRuntimeIdentity() {
	const identity = await processRuntimeIdentity()
	return withDesiredRuntimeLock(async () => {
		const desired = await readDesiredRuntimeIdentityUnlocked()
		const decision = runtimeActivationDecision(identity, desired)
		if (!decision.ok) throw staleRuntimeError(decision.desired ?? desired, decision.reason)
		const claimId = randomUUID()
		await writeDesiredRuntimeIdentityUnlocked(identity, { claimId }, desired)
		return { ...identity, claimId }
	})
}

async function ensureCurrentRuntimeIsDesired(identity, expectedClaimId) {
	return withDesiredRuntimeLock(async () => {
		const desired = await readDesiredRuntimeIdentityUnlocked()
		if (!desired) {
			await writeDesiredRuntimeIdentityUnlocked(identity, expectedClaimId ? { claimId: expectedClaimId } : {})
			return
		}
		if (!runtimeIdentityMatches(desired, identity)) {
			const decision = runtimeActivationDecision(identity, desired)
			if (!decision.ok) throw staleRuntimeError(decision.desired ?? desired, decision.reason)
			await writeDesiredRuntimeIdentityUnlocked(identity, expectedClaimId ? { claimId: expectedClaimId } : {}, desired)
			return
		}
		if (expectedClaimId && desired.claimId && desired.claimId !== expectedClaimId) throw staleRuntimeError(desired, "superseded_claim")
	})
}

function routeError(err) {
	return json({ error: /** @type {any} */ (err)?.message ?? String(err) }, /** @type {any} */ (err)?.status ?? 400)
}

/** @param {Request} req */
async function readJson(req) {
	return req.json().catch(() => ({}))
}

function createEventHub(onActivity = () => {}) {
	/** @type {Map<string, ReadableStreamDefaultController<Uint8Array>>} */
	const clients = new Map()
	let nextClientId = 1
	const sendTo = (controller, event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
	return {
		stream(initialEvent, signal) {
			/** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */
			let streamController
			const clientId = String(nextClientId++)
			let released = false
			const release = () => {
				if (released) return
				released = true
				clients.delete(clientId)
				signal?.removeEventListener?.("abort", release)
				try { streamController?.close() } catch {}
				onActivity()
			}
			const response = new Response(new ReadableStream({
				start(controller) {
					streamController = controller
					clients.set(clientId, controller)
					signal?.addEventListener?.("abort", release, { once: true })
					onActivity()
					if (signal?.aborted) release()
					else sendTo(controller, { ...initialEvent, eventClientId: clientId })
				},
				cancel() {
					release()
				},
			}), {
				headers: {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache",
					"connection": "keep-alive",
				},
			})
			return response
		},
		send(event) {
			for (const [clientId, controller] of [...clients]) {
				try {
					sendTo(controller, event)
				} catch {
					clients.delete(clientId)
				}
			}
			onActivity()
		},
		closeClient(clientId) {
			const controller = clients.get(clientId)
			clients.delete(clientId)
			try { controller?.close() } catch {}
			onActivity()
		},
		clientCount() {
			return clients.size
		},
	}
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {string} [options.token]
 * @param {boolean} [options.noContextFiles]
 * @param {string} [options.serviceRunId]
 * @param {string} [options.serviceClaimId]
 * @param {() => void | Promise<void>} [options.onIdle]
 * @param {any} [options.webAppOptions]
 * @param {(info: { sessionId: string, session: any, cwd: string }) => Agent} options.createAgent
 */
export async function runService(options) {
	const diagnosticsOptions = configuredServiceDiagnostics()
	const diagnostics = createServiceDiagnostics({
		...diagnosticsOptions,
		path: diagnosticsOptions.path || join(serviceDir(), "diagnostics.jsonl"),
		processName: "pinano service",
	})
	const runtimeIdentity = await processRuntimeIdentity()
	const codeFingerprint = runtimeIdentity.codeFingerprint
	if (options.serviceClaimId) await ensureCurrentRuntimeIsDesired(runtimeIdentity, options.serviceClaimId)
	else await claimCurrentRuntimeIdentity()
	const serviceRunId = options.serviceRunId ?? randomUUID()
	const serviceStartedAt = new Date().toISOString()
	const serviceToken = typeof options.token === "string" && options.token ? options.token : createServiceToken()
	let activeRequests = 0
	let idleTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
	let closed = false
	let shutdownReason = "clean_shutdown"
	const clearIdleTimer = () => {
		if (!idleTimer) return
		clearTimeout(idleTimer)
		idleTimer = undefined
	}
	const hub = createEventHub(() => scheduleIdleCheck())
	const db = await openOwnedServerDb({ recoverRunningRuns: true })
	db.recoverServiceRuns(undefined, serviceRunId)
	db.startServiceRun({
		id: serviceRunId,
		pid: process.pid,
		cwd: options.cwd,
		transport: "tcp",
		port: options.port,
		codeFingerprint,
		startedAt: serviceStartedAt,
	})
	let serviceSettings = await loadSettings()
	let serviceModelOverride = false
	const manager = await RuntimeManager.create({
		cwd: options.cwd,
		createAgent: options.createAgent,
		getSettings: () => ({ ...serviceSettings, model: serviceModelOverride ? serviceSettings.model : undefined }),
		noContextFiles: options.noContextFiles === true,
		diagnostics,
	}, db, hub)
	manager.resumeRunnableInterruptedRuns().catch((err) => console.error("service auto-resume error", err))
	let server
	let serviceEndpoint = /** @type {{ host?: string, port?: number, requestedPort?: number, portFallback?: boolean }} */ ({ host: options.host, port: options.port, requestedPort: options.port, portFallback: false })
	let webServer = /** @type {any} */ (undefined)
	let webOptions = /** @type {any} */ (undefined)
	const runningRuntimes = () => [...manager.runtimes.values()].filter((runtime) => runtime.isStreaming())
	const backgroundRuntimes = () => [...manager.runtimes.values()].filter((runtime) => runtime.hasBackgroundWork?.())
	const waitingInfos = () => runningRuntimes().map((runtime) => runtime.waitingInfo())
	diagnostics.setContextProvider?.(() => ({
		activeRequests,
		eventClients: hub.clientCount(),
		webActive: Boolean(webServer),
		runningSessions: runningRuntimes().length,
		runningSessionIds: runningRuntimes().map((runtime) => runtime.sessionId),
		backgroundSessions: backgroundRuntimes().length,
		waiting: waitingInfos().length,
	}))
	diagnostics.addProbe?.("noop", () => ({}))
	const isBusy = () => {
		if (activeRequests > 0) return true
		if (hub.clientCount() > 0) return true
		if (webServer) return true
		return runningRuntimes().length > 0 || backgroundRuntimes().length > 0
	}
	async function stopForIdle() {
		if (closed) return
		if (isBusy()) {
			scheduleIdleCheck()
			return
		}
		shutdownReason = "idle_shutdown"
		await cleanup()
		if (options.onIdle) await options.onIdle()
		else process.exit(0)
	}
	async function waitForNoRunning(deadline) {
		while (Date.now() < deadline && (runningRuntimes().length > 0 || backgroundRuntimes().length > 0)) {
			await Promise.race([
				Promise.allSettled([
					...runningRuntimes().map((runtime) => runtime.waitForIdle()),
					...backgroundRuntimes().map((runtime) => runtime.waitForBackgroundWork?.()),
				]),
				new Promise((resolve) => setTimeout(resolve, 25)),
			])
		}
	}
	function scheduleIdleCheck() {
		clearIdleTimer()
		if (closed || isBusy()) return
		idleTimer = setTimeout(() => {
			stopForIdle().catch((err) => {
				console.error("service idle shutdown error", err)
				process.exit(1)
			})
		}, SERVICE_IDLE_SHUTDOWN_DELAY_MS)
		idleTimer.unref?.()
	}
	const resolveId = (id) => {
		const matches = db.findSessionIdsByPrefix(id)
		if (matches.length === 1) return matches[0]
		if (matches.length > 1) throw Object.assign(new Error(`ambiguous session id ${id}`), { status: 400 })
		return id
	}
	const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
	const webStatus = (includeSecret = true) => {
		if (!webServer) return { running: false }
		const status = {
			running: true,
			host: webOptions.host,
			port: webOptions.port,
			requestedPort: webOptions.requestedPort,
			publicUrl: webOptions.publicUrl,
			dev: webOptions.dev,
			startedAt: webOptions.startedAt,
		}
		if (includeSecret) {
			status.url = webServer.url
			status.token = webServer.token
		}
		return status
	}
	const stopWeb = async () => {
		if (!webServer) return false
		try { webServer.close() } catch {}
		webServer = undefined
		webOptions = undefined
		scheduleIdleCheck()
		return true
	}
	const startWeb = async (requestBody = {}) => {
		const bodyInput = requestBody && typeof requestBody === "object" ? requestBody : {}
		const defaults = configuredWebDefaults()
		const body = { ...defaults, ...bodyInput }
		const explicit = {
			host: hasOwn(bodyInput, "host"),
			port: hasOwn(bodyInput, "port"),
			token: hasOwn(bodyInput, "token"),
			publicUrl: hasOwn(bodyInput, "publicUrl"),
			dev: hasOwn(bodyInput, "dev"),
		}
		const anyExplicit = Object.values(explicit).some(Boolean)
		const endpointHost = serviceHostForListen(serviceEndpoint.host)
		const endpointPort = Number(serviceEndpoint.port)
		if (!Number.isInteger(endpointPort) || endpointPort <= 0) throw new Error("Pinano service endpoint is not ready")
		const configuredHost = typeof defaults.host === "string" && defaults.host ? defaults.host : undefined
		const configuredFixedPort = Number.isInteger(defaults.port) && defaults.port > 0 ? defaults.port : undefined
		const fallbackPort = Number(serviceEndpoint.requestedPort)
		if (configuredHost && configuredHost !== endpointHost) throw Object.assign(new Error(`Pinano Web is configured for host ${configuredHost}, but the running service is bound to ${endpointHost}; restart the service after updating $PINANO_HOME/config/service.json.`), { status: 409 })
		if (configuredFixedPort && configuredFixedPort !== endpointPort) throw Object.assign(new Error(`Pinano Web is configured for port ${configuredFixedPort}, but the running service is on ${endpointHost}:${endpointPort}. Free the configured port and restart the service, or update $PINANO_HOME/config/service.json.`), { status: 409 })
		if (serviceEndpoint.portFallback && fallbackPort > 0) throw Object.assign(new Error(`Pinano Web cannot start on fallback service port ${endpointPort}; requested port ${fallbackPort} was unavailable when the service started. Free the requested port and restart the service, or update $PINANO_HOME/config/service.json.`), { status: 409 })
		const requestedPort = Number.isInteger(body.port) ? Math.max(0, body.port) : undefined
		const requestedToken = typeof body.token === "string" && body.token ? body.token : undefined
		if (explicit.host && body.host && body.host !== endpointHost) throw Object.assign(new Error("Pinano Web shares the service endpoint; restart the service to change its host."), { status: 409 })
		if (explicit.port && requestedPort && requestedPort !== endpointPort) throw Object.assign(new Error("Pinano Web shares the service endpoint; restart the service to change its port."), { status: 409 })
		if (explicit.token && requestedToken && requestedToken !== serviceToken) throw Object.assign(new Error("Pinano Web shares the service endpoint token; restart the service to change it."), { status: 409 })
		const desired = {
			host: endpointHost,
			requestedPort: endpointPort,
			port: endpointPort,
			publicUrl: typeof body.publicUrl === "string" && body.publicUrl ? body.publicUrl : undefined,
			dev: body.dev === true,
		}
		if (webServer) {
			if (!anyExplicit) return { ok: true, web: webStatus() }
			const same = desired.publicUrl === webOptions.publicUrl && desired.dev === webOptions.dev
			if (same && body.replace !== true) return { ok: true, web: webStatus() }
			if (body.replace !== true) throw Object.assign(new Error(`Web app already active at ${webServer.url}`), { status: 409 })
			await stopWeb()
		}
		const { createManagerWebApp, webPublicUrl } = await import("./web-mode.js")
		const appOptions = { ...(options.webAppOptions || {}), token: serviceToken, dev: desired.dev }
		const webApp = await createManagerWebApp({
			cwd: options.cwd,
			manager,
			hub,
			db,
			host: desired.host,
			port: desired.port,
			token: serviceToken,
			publicUrl: desired.publicUrl,
			dev: desired.dev,
			getSettings: () => serviceSettings,
			setDefaultModel: async (model) => {
				serviceModelOverride = true
				serviceSettings = await updateSetting("model", model)
				return serviceSettings
			},
		}, appOptions)
		webServer = {
			...webApp,
			host: desired.host,
			port: desired.port,
			token: serviceToken,
			url: webPublicUrl({ host: desired.host, port: desired.port, token: serviceToken, publicUrl: desired.publicUrl }),
			close: () => {},
		}
		webOptions = { ...desired, startedAt: new Date().toISOString() }
		scheduleIdleCheck()
		return { ok: true, web: webStatus() }
	}

	/** @param {Request} req */
	const handleServiceRequest = async (req) => {
		const url = new URL(req.url)
		const pathname = stripServiceRoutePrefix(url.pathname)
		try {
			if (req.method === "GET" && pathname === "/health") {
				return json({
					ok: true,
					pid: process.pid,
					serviceRunId,
					cwd: options.cwd,
					transport: "tcp",
					host: serviceEndpoint.host,
					port: serviceEndpoint.port,
					requestedPort: serviceEndpoint.requestedPort,
					portFallback: serviceEndpoint.portFallback === true,
					protocolVersion: SERVICE_PROTOCOL_VERSION,
					codeFingerprint,
					runtimeKey: runtimeIdentity.runtimeKey,
					packageName: runtimeIdentity.packageName,
					packageVersion: runtimeIdentity.packageVersion,
					mainPath,
					sourceRoot,
					packageRoot,
					execPath: process.execPath,
					argv: process.argv,
					activeRequests,
					eventClients: hub.clientCount(),
					web: webStatus(false),
					runningSessions: runningRuntimes().map((runtime) => runtime.sessionId),
					backgroundSessions: backgroundRuntimes().map((runtime) => runtime.sessionId),
					waiting: waitingInfos(),
					diagnostics: diagnostics.status(),
				})
			}
			if (req.method === "GET" && pathname === "/events") {
				return hub.stream({ type: "sessions", sessions: await manager.sessions() }, req.signal)
			}
			if (req.method === "GET" && pathname === "/web/status") return json({ ok: true, web: webStatus() })
			if (req.method === "POST" && pathname === "/web/start") return json(await startWeb(await readJson(req)))
			if (req.method === "POST" && pathname === "/web/stop") return json({ ok: true, stopped: await stopWeb(), web: webStatus() })
			if (req.method === "GET" && pathname === "/settings") return json({ settings: serviceSettings })
			if (req.method === "POST" && pathname === "/settings") {
				const body = await readJson(req)
				if (Object.hasOwn(body, "model")) {
					const model = typeof body.model === "string" ? body.model.trim() : ""
					if (!model) return json({ error: "model is required" }, 400)
					serviceModelOverride = true
					serviceSettings = await updateSetting("model", model)
					return json({ ok: true, settings: serviceSettings })
				}
				if (Object.hasOwn(body, "thinkingLevel")) {
					const level = normalizeReasoningLevel(typeof body.thinkingLevel === "string" ? body.thinkingLevel.trim() : "")
					if (!level) return json({ error: "valid reasoning level is required" }, 400)
					serviceSettings = await updateSetting("thinkingLevel", /** @type {any} */ (level))
					return json({ ok: true, settings: serviceSettings })
				}
				return json({ error: "no supported settings provided" }, 400)
			}
			if (req.method === "GET" && pathname === "/sessions") {
				return json({ sessions: await manager.sessions(url.searchParams.get("cwd") || undefined) })
			}
			if (req.method === "POST" && pathname === "/sessions") {
				const body = await readJson(req)
				const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : options.cwd
				const runtime = await manager.createSession(cwd)
				if (typeof body.prompt === "string" && body.prompt.trim()) await runtime.prompt(body.prompt)
				return json({ ok: true, sessionId: runtime.sessionId, snapshot: await runtime.snapshot() })
			}
			const eventClientMatch = pathname.match(/^\/event-clients\/([^/]+)\/close$/)
			if (req.method === "POST" && eventClientMatch) {
				hub.closeClient(decodeURIComponent(eventClientMatch[1]))
				return json({ ok: true })
			}

			const sessionMatch = pathname.match(/^\/sessions\/([^/]+)(?:\/(snapshot|prompt|draft|continue|abort|cancel-prompt|complete|defer|review|delete|reasoning|fast|compact|bash|rewind-targets|rewind|branch))?$/)
			if (sessionMatch) {
				const id = resolveId(decodeURIComponent(sessionMatch[1]))
				const action = sessionMatch[2] ?? "snapshot"
				if (req.method === "GET" && action === "snapshot") return json(await manager.snapshot(id, { includeSessions: url.searchParams.get("includeSessions") === "1" }))
				if (req.method === "POST" && action === "prompt") {
					const body = await readJson(req)
					const message = typeof body.message === "string" ? body.message : ""
					if (!message.trim()) return json({ error: "message is required" }, 400)
					const runtime = await manager.getRuntime(id)
					await runtime.prompt(message, body.streamingBehavior)
					manager.setPromptDraft(id, "", { clientId: body.draftClientId, clientSeq: body.draftClientSeq })
					return json({ ok: true, snapshot: await runtime.snapshot() })
				}
				if (req.method === "POST" && action === "draft") {
					const body = await readJson(req)
					const text = typeof body.text === "string" ? body.text : ""
					const draft = manager.setPromptDraft(id, text, { clientId: body.clientId, clientSeq: body.clientSeq })
					return json({ ok: true, draft })
				}
				if (req.method === "POST" && action === "continue") {
					const runtime = await manager.getRuntime(id)
					await runtime.continueRun()
					return json({ ok: true, snapshot: await runtime.snapshot() })
				}
				if (req.method === "POST" && action === "abort") {
					const runtime = await manager.getRuntime(id)
					await runtime.abort()
					return json({ ok: true, snapshot: await runtime.snapshot() })
				}
				if (req.method === "POST" && action === "cancel-prompt") {
					const runtime = await manager.getRuntime(id)
					return json(await runtime.cancelCurrentPrompt())
				}
				if (req.method === "POST" && action === "complete") {
					const metadata = await manager.markCompleted(id)
					return json({ ok: true, metadata, sessions: await manager.sessions(url.searchParams.get("cwd") || undefined) })
				}
				if (req.method === "POST" && action === "defer") {
					const metadata = await manager.markDeferred(id)
					return json({ ok: true, metadata, sessions: await manager.sessions(url.searchParams.get("cwd") || undefined) })
				}
				if (req.method === "POST" && action === "review") {
					const metadata = await manager.markReadyForReview(id)
					return json({ ok: true, metadata, sessions: await manager.sessions(url.searchParams.get("cwd") || undefined) })
				}
				if (req.method === "POST" && action === "delete") {
					await manager.deleteStoppedSession(id)
					return json({ ok: true, sessions: await manager.sessions(url.searchParams.get("cwd") || undefined) })
				}
				if (req.method === "POST" && action === "reasoning") {
					const body = await readJson(req)
					const level = normalizeReasoningLevel(typeof body.level === "string" ? body.level.trim() : "")
					if (!level) return json({ error: "valid reasoning level is required" }, 400)
					const runtime = await manager.getRuntime(id)
					runtime.agent.state.thinkingLevel = /** @type {any} */ (level)
					await runtime.session.appendConfigPatch({ version: 1, thinkingLevel: runtime.agent.state.thinkingLevel })
					await manager.sendSnapshot(id)
					return json({ ok: true, snapshot: await runtime.snapshot() })
				}
				if (req.method === "POST" && action === "fast") {
					const body = await readJson(req)
					const args = typeof body.args === "string" ? body.args : ""
					const runtime = await manager.getRuntime(id)
					const message = await runtime.setFastMode(args)
					await manager.sendSnapshot(id)
					return json({ ok: true, message, snapshot: await runtime.snapshot() })
				}
				if (req.method === "POST" && action === "compact") {
					const runtime = await manager.getRuntime(id)
					const result = await runtime.compact()
					await manager.sendSnapshot(id)
					return json({ ok: true, result, snapshot: await runtime.snapshot() })
				}
				if (req.method === "POST" && action === "bash") {
					const body = await readJson(req)
					const text = typeof body.text === "string" ? body.text : ""
					const shortcut = parseBashShortcut(text)
					if (!shortcut) return json({ error: "valid bash shortcut is required" }, 400)
					const runtime = await manager.getRuntime(id)
					const result = await runBashShortcut(runtime.agent, shortcut.command, { excludeFromContext: shortcut.excludeFromContext })
					await recordBashShortcut(runtime.agent, runtime.session, result)
					await manager.sendSnapshot(id)
					return json({ ok: true, result, snapshot: await runtime.snapshot() })
				}
				if (req.method === "GET" && action === "rewind-targets") {
					const runtime = await manager.getRuntime(id)
					return json({ targets: runtime.rewindTargets() })
				}
				if (req.method === "POST" && action === "rewind") {
					const body = await readJson(req)
					const runtime = await manager.getRuntime(id)
					if (body.targetKind === "leaf") {
						await runtime.switchBranchTip(String(body.entryId ?? ""))
						return json({ ok: true, text: "", targetKind: "leaf", snapshot: await runtime.snapshot() })
					}
					const text = await runtime.rewind(String(body.entryId ?? ""), {
						summary: body.summary === true,
						restoreFiles: body.restoreFiles === true,
						restoreConversation: body.restoreConversation !== false,
					})
					return json({ ok: true, text, targetKind: "message", snapshot: await runtime.snapshot() })
				}
				if (req.method === "POST" && action === "branch") {
					const runtime = await manager.branchSession(id)
					return json({ ok: true, sessionId: runtime.sessionId, snapshot: await runtime.snapshot(), sessions: await manager.sessions(url.searchParams.get("cwd") || undefined) })
				}
			}

			if (req.method === "POST" && pathname === "/interrupt") {
				const body = await readJson(req)
				const mode = body.mode === "hard" ? "hard" : "soft"
				if (mode === "hard") {
					for (const runtime of runningRuntimes()) runtime.agent.abort()
					shutdownReason = "hard_interrupt"
					setTimeout(() => { cleanup().finally(() => process.exit(0)) }, 20)
					return json({ ok: true, mode, exiting: true, waiting: waitingInfos() })
				}

				for (const runtime of runningRuntimes()) runtime.softInterrupt()
				const waitMs = Number.isFinite(body.waitMs) ? Math.max(0, body.waitMs) : 0
				if (waitMs > 0) await waitForNoRunning(Date.now() + waitMs)
				const waiting = waitingInfos()
				if (waiting.length > 0) return json({ ok: false, mode, exiting: false, waiting })
				shutdownReason = "soft_interrupt"
				setTimeout(() => { cleanup().finally(() => process.exit(0)) }, 20)
				return json({ ok: true, mode, exiting: true, waiting })
			}

			return json({ error: "Not Found" }, 404)
		} catch (err) {
			return routeError(err)
		}
	}

	/** @param {Request} req */
	const handle = async (req) => {
		const url = new URL(req.url)
		if (isServiceRequestPath(url.pathname)) {
			const auth = authenticateRequest(req, serviceToken, { checkOrigin: true })
			if (!auth.ok) return authError(auth)
			return handleServiceRequest(req)
		}
		if (webServer?.app) return webServer.app.fetch(req)
		return json({ error: "Not Found" }, 404)
	}

	server = http.createServer(async (incoming, outgoing) => {
		const requestUrl = `http://${incoming.headers.host || "pinano.local"}${incoming.url}`
		const requestPath = stripServiceRoutePrefix(new URL(requestUrl).pathname)
		activeRequests++
		if (requestPath !== "/health") clearIdleTimer()
		let endRequest = () => {}
		let requestEnded = false
		let activeRequestOpen = true
		const finishRequest = (args) => {
			if (requestEnded) return
			requestEnded = true
			endRequest(args)
		}
		const finishActiveRequest = (schedule = true) => {
			if (!activeRequestOpen) return
			activeRequestOpen = false
			if (activeRequests > 0) activeRequests--
			if (schedule) scheduleIdleCheck()
		}
		try {
			const requestAbort = new AbortController()
			const abortRequest = () => requestAbort.abort()
			incoming.once("aborted", abortRequest)
			incoming.once("close", abortRequest)
			outgoing.once("close", abortRequest)
			endRequest = diagnostics.span("service.request", {
				method: incoming.method,
				path: requestPath,
				activeRequests,
			})
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
			const response = await handle(new Request(requestUrl, {
				method: incoming.method,
				headers: incoming.headers,
				body,
				duplex: body ? "half" : undefined,
				signal: requestAbort.signal,
			}))
			finishRequest({ status: response.status })
			const headers = Object.fromEntries(response.headers)
			if (headers["content-type"]?.startsWith("text/event-stream")) {
				outgoing.writeHead(response.status, headers)
				finishActiveRequest(false)
				if (response.body) {
					const reader = response.body.getReader()
					for (;;) {
						const { done, value } = await reader.read()
						if (done || outgoing.destroyed) break
						outgoing.write(value)
					}
				}
				if (!outgoing.destroyed) await new Promise((resolve) => outgoing.end(resolve))
			} else {
				const bodyText = await response.text()
				headers["content-length"] = String(Buffer.byteLength(bodyText))
				outgoing.writeHead(response.status, headers)
				await new Promise((resolve) => outgoing.end(bodyText, resolve))
			}
			finishActiveRequest(requestPath !== "/health")
		} catch (err) {
			finishRequest({ error: true })
			finishActiveRequest()
			console.error("service request error", err)
			if (!outgoing.headersSent) outgoing.writeHead(500)
			outgoing.end("Internal Server Error")
		}
	})

	const listenHost = serviceHostForListen(options.host)
	const listenResult = await listenTcpEndpoint(server, listenHost, options.port ?? 0)
	const address = server.address()
	const host = serviceHostForListen(options.host)
	const port = typeof address === "object" && address ? address.port : options.port
	const requestedPort = listenResult.requestedPort
	const portFallback = listenResult.portFallback
	serviceEndpoint = { host, port, requestedPort, portFallback }
	db.startServiceRun({
		id: serviceRunId,
		pid: process.pid,
		cwd: options.cwd,
		transport: "tcp",
		port,
		codeFingerprint,
		runtimeKey: runtimeIdentity.runtimeKey,
		packageName: runtimeIdentity.packageName,
		packageVersion: runtimeIdentity.packageVersion,
		mainPath,
		sourceRoot,
		packageRoot,
		execPath: process.execPath,
		argv: process.argv,
		startedAt: serviceStartedAt,
	})
	await mkdir(serviceDir(), { recursive: true })
	await writePrivateJson(serviceInfoPath(), {
		pid: process.pid,
		cwd: options.cwd,
		transport: "tcp",
		host,
		port,
		requestedPort,
		portFallback,
		token: serviceToken,
		serviceRunId,
		protocolVersion: SERVICE_PROTOCOL_VERSION,
		codeFingerprint,
		runtimeKey: runtimeIdentity.runtimeKey,
		packageName: runtimeIdentity.packageName,
		packageVersion: runtimeIdentity.packageVersion,
		mainPath,
		sourceRoot,
		packageRoot,
		execPath: process.execPath,
		argv: process.argv,
		startedAt: serviceStartedAt,
	})
	await appendServiceLog("service_started", { pid: process.pid, serviceRunId, cwd: options.cwd, transport: "tcp", host, port, requestedPort, portFallback, codeFingerprint, runtimeKey: runtimeIdentity.runtimeKey })

	const cleanup = async () => {
		if (closed) return
		closed = true
		clearIdleTimer()
		try { await stopWeb() } catch {}
		try { server.close() } catch {}
		try { manager.dispose() } catch {}
		try { db.finishServiceRun(serviceRunId, { status: "clean_exit", reason: shutdownReason }) } catch {}
		try { db.close() } catch {}
		try { await diagnostics.close() } catch {}
		const info = await readInfo()
		const ownsInfo = !info || info.serviceRunId === serviceRunId
		await appendServiceLog("service_cleanup", { serviceRunId, reason: shutdownReason, ownsInfo, ownerServiceRunId: info?.serviceRunId, ownerPid: info?.pid })
		if (ownsInfo) {
			try { await rm(serviceInfoPath(), { force: true }) } catch {}
		} else {
			await appendServiceLog("cleanup_skipped_foreign_service_info", { serviceRunId, ownerServiceRunId: info.serviceRunId, ownerPid: info.pid })
		}
	}
	process.once("SIGINT", () => {
		shutdownReason = "signal_SIGINT"
		cleanup().finally(() => process.exit(0))
	})
	process.once("SIGTERM", () => {
		shutdownReason = "signal_SIGTERM"
		cleanup().finally(() => process.exit(0))
	})
	process.once("exit", () => {
		if (!closed) {
			try { db.finishServiceRun(serviceRunId, { status: "process_exit", reason: "process_exit_without_cleanup" }) } catch {}
		}
		try { manager.dispose() } catch {}
		try { db.close() } catch {}
	})
	scheduleIdleCheck()
	return { manager, db, close: cleanup }
}

function normalizeServiceInfo(info, path) {
	if (!info || typeof info !== "object") return null
	const normalized = { ...info, serviceRunId: info.serviceRunId ?? info.daemonRunId }
	Object.defineProperty(normalized, INFO_PATH, { value: path, enumerable: false })
	return normalized
}

async function readInfo() {
	for (const path of [serviceInfoPath(), legacyServiceInfoPath()]) {
		try {
			return normalizeServiceInfo(JSON.parse(await readFile(path, "utf-8")), path)
		} catch {}
	}
	return null
}

function serviceHttpOptions(info, path) {
	if (info.transport === "tcp") return { host: serviceHostForConnect(info.host), port: info.port, path }
	throw Object.assign(new Error(`Unsupported Pinano service transport: ${info.transport || "unknown"}`), { code: "PINANO_UNSUPPORTED_SERVICE_TRANSPORT" })
}

/**
 * @param {any} info
 * @param {string} path
 * @param {{ method?: string, body?: string, headers?: Record<string, string>, signal?: AbortSignal }} [options]
 * @returns {Promise<{ status: number, headers: import("node:http").IncomingHttpHeaders, body: string }>}
 */
function requestText(info, path, options = {}) {
	return new Promise((resolve, reject) => {
		const body = options.body ?? ""
		const req = http.request({
			...serviceHttpOptions(info, path),
			method: options.method ?? "GET",
			headers: {
				"host": "pinano.local",
				"connection": "close",
				...(info.token ? { "authorization": `Bearer ${info.token}` } : {}),
				...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}),
				...(options.headers || {}),
			},
		}, (res) => {
			const chunks = []
			res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
			res.on("end", () => {
				const result = {
					status: res.statusCode ?? 0,
					headers: res.headers ?? {},
					body: Buffer.concat(chunks).toString("utf-8"),
				}
				req.destroy?.()
				resolve(result)
			})
		})
		req.on("error", reject)
		options.signal?.addEventListener("abort", () => req.destroy())
		if (body) req.write(body)
		req.end()
	})
}

async function requestJson(info, path, options = {}) {
	const res = await requestText(info, path, {
		...options,
		headers: {
			"content-type": "application/json",
			...(options.headers || {}),
		},
	})
	const data = res.body ? JSON.parse(res.body) : {}
	if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status })
	return data
}

async function ping(info, expectedIdentity) {
	if (!info || info.protocolVersion !== SERVICE_PROTOCOL_VERSION) return false
	if (expectedIdentity && !runtimeIdentityMatches(info, expectedIdentity)) return false
	try {
		const res = await requestJson(info, "/health")
		return res.ok === true &&
			res.protocolVersion === SERVICE_PROTOCOL_VERSION &&
			(!expectedIdentity || runtimeIdentityMatches(res, expectedIdentity))
	} catch {
		return false
	}
}

async function interruptOldService(info, mode = "soft", waitMs = 0) {
	try {
		return await requestJson(info, "/interrupt", { method: "POST", body: JSON.stringify({ mode, waitMs }) })
	} catch (err) {
		return { ok: false, error: /** @type {any} */ (err)?.message ?? String(err), status: /** @type {any} */ (err)?.status }
	}
}

function formatWaitElapsed(ms) {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000))
	if (totalSeconds < 60) return `${totalSeconds}s`
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = String(totalSeconds % 60).padStart(2, "0")
	return `${minutes}m ${seconds}s`
}

function waitingToolNames(item) {
	return item.pendingToolCalls?.map((t) => t.name).join(", ") || "model stream"
}

function upgradeWaitLines(waiting, startedAtMs, { prompt = true } = {}) {
	const elapsed = formatWaitElapsed(Date.now() - startedAtMs)
	const lines = [
		`pinano service upgrade has waited ${elapsed} for running tool calls:`,
		...waiting.map((item) => `  ${item.sessionId.slice(0, 8)} ${waitingToolNames(item)}`),
	]
	if (prompt) lines.push(`Waited ${elapsed}. Hard interrupt and replace the service? [y/N] `)
	return lines
}

function terminalRenderedLineCount(lines) {
	const columns = Math.max(1, process.stderr.columns || 80)
	return lines.reduce((count, line) => count + Math.max(1, Math.ceil(String(line).length / columns)), 0)
}

function clearRenderedLines(count) {
	for (let i = 0; i < count; i++) {
		if (i > 0) process.stderr.write("\x1b[1A")
		process.stderr.write("\r\x1b[K")
	}
}

async function waitForUpgradeBlockageDecision(info, initialWaiting, startedAtMs) {
	if (process.env.PINANO_SERVICE_HARD_INTERRUPT === "1" || process.env.PINANO_DAEMON_HARD_INTERRUPT === "1") return { action: "hard" }
	if (!process.stdin.isTTY || !process.stderr.isTTY) {
		for (const line of upgradeWaitLines(initialWaiting, startedAtMs, { prompt: false })) console.error(line)
		return { action: "busy" }
	}

	let waiting = initialWaiting
	let renderedLineCount = 0
	let finished = false
	let inputSubmitted = false
	const wasPaused = process.stdin.isPaused?.() ?? false
	let input = ""

	const render = () => {
		if (finished) return
		clearRenderedLines(renderedLineCount)
		const lines = upgradeWaitLines(waiting, startedAtMs)
		process.stderr.write(lines.join("\n"))
		renderedLineCount = terminalRenderedLineCount(lines)
	}

	return await new Promise((resolve) => {
		const finish = (result) => {
			if (finished) return
			finished = true
			clearInterval(renderTimer)
			process.stdin.off("data", onData)
			if (wasPaused) process.stdin.pause()
			clearRenderedLines(renderedLineCount + (inputSubmitted ? 1 : 0))
			renderedLineCount = 0
			resolve(result)
		}
		const onData = (chunk) => {
			const text = String(chunk)
			if (text.includes("\u0003")) {
				process.kill(process.pid, "SIGINT")
				return
			}
			input += text
			if (process.stdin.isRaw && /^[yn]$/i.test(text.trim())) {
				finish({ action: /^y$/i.test(text.trim()) ? "hard" : "busy" })
				return
			}
			if (!/[\r\n]/.test(input)) return
			inputSubmitted = true
			const answer = input.split(/[\r\n]/, 1)[0].trim()
			finish({ action: /^y(es)?$/i.test(answer) ? "hard" : "busy" })
		}
		const poll = async () => {
			while (!finished) {
				const interrupted = await interruptOldService(info, "soft", SERVICE_UPGRADE_BLOCKED_POLL_MS)
				if (finished) return
				if (interrupted?.error) {
					finish({ action: "error", interrupted })
					return
				}
				if (!interrupted?.waiting?.length) {
					finish({ action: "cleared", interrupted })
					return
				}
				waiting = interrupted.waiting
				render()
			}
		}
		const renderTimer = setInterval(render, 1000)
		process.stdin.on("data", onData)
		process.stdin.resume()
		render()
		poll().catch((err) => finish({ action: "error", interrupted: { ok: false, error: err?.message ?? String(err) } }))
	})
}

async function shouldHardInterruptForUpgrade(prompt = "Hard interrupt these running tool calls and replace the service? [y/N] ") {
	if (process.env.PINANO_SERVICE_HARD_INTERRUPT === "1" || process.env.PINANO_DAEMON_HARD_INTERRUPT === "1") return true
	if (!process.stdin.isTTY || !process.stderr.isTTY) return false
	const rl = createInterface({ input: process.stdin, output: process.stderr })
	try {
		const answer = await rl.question(prompt)
		return /^y(es)?$/i.test(answer.trim())
	} finally {
		rl.close()
	}
}

async function removeStaleServiceInfo() {
	await rm(serviceInfoPath(), { force: true }).catch(() => {})
	await rm(legacyServiceInfoPath(), { force: true }).catch(() => {})
}

async function ensureOldServiceStopped(existing, interrupted) {
	const pid = servicePid(existing)
	if (!pid || !processExists(pid)) return true
	if (interrupted?.ok && interrupted.exiting) {
		if (await waitForProcessExit(pid, 3000)) return true
		await appendServiceLog("service_interrupt_timeout", { pid, serviceRunId: existing.serviceRunId, transport: existing.transport, host: existing.host, port: existing.port })
		if (await shouldHardInterruptForUpgrade(`Pinano service pid ${pid} did not exit after interrupt. Kill it and replace it? [y/N] `)) {
			return terminateProcess(pid)
		}
		return false
	}
	await appendServiceLog("service_unreachable", { pid, serviceRunId: existing.serviceRunId, transport: existing.transport, host: existing.host, port: existing.port, error: interrupted?.error, status: interrupted?.status })
	if (await shouldHardInterruptForUpgrade(`Pinano service pid ${pid} is alive but unreachable. Kill it and replace it? [y/N] `)) {
		return terminateProcess(pid)
	}
	return false
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {boolean} [options.noContextFiles]
 * @param {string} [options.serviceClaimId]
 * @param {number} [options.startupTimeoutMs]
 */
export async function ensureService(options) {
	const runtimeIdentity = await processRuntimeIdentity()
	const codeFingerprint = runtimeIdentity.codeFingerprint
	await ensureCurrentRuntimeIsDesired(runtimeIdentity, options.serviceClaimId)
	const endpoint = configuredServiceEndpointDefaults()
	let existing = await readInfo()
	if (existing && existing.transport !== "tcp") {
		const pid = servicePid(existing)
		const pidAlive = processExists(pid)
		await appendServiceLog("service_unsupported_transport", { pid, pidAlive, serviceRunId: existing.serviceRunId, transport: existing.transport })
		if (pidAlive) throw new Error(`Existing Pinano service uses unsupported ${existing.transport || "unknown"} transport at pid ${pid}. Stop it before starting this version.`)
		await removeStaleServiceInfo()
		existing = null
	} else if (existing && await ping(existing, runtimeIdentity)) return existing
	if (existing) {
		let pid = servicePid(existing)
		let pidAlive = processExists(pid)
		let replacementTarget = existing
		await appendServiceLog("service_replacement_requested", { pid, pidAlive, serviceRunId: existing.serviceRunId, transport: existing.transport, host: existing.host, port: existing.port, storedCodeFingerprint: existing.codeFingerprint, codeFingerprint, storedRuntimeKey: existing.runtimeKey, runtimeKey: runtimeIdentity.runtimeKey, storedMainPath: existing.mainPath, mainPath, storedExecPath: existing.execPath, execPath: process.execPath })
		if (pidAlive || replacementTarget !== existing) {
			const upgradeWaitStartedAt = Date.now()
			const interrupted = await interruptOldService(replacementTarget, "soft", SERVICE_UPGRADE_SOFT_WAIT_MS)
			if (interrupted?.waiting?.length) {
				const decision = await waitForUpgradeBlockageDecision(replacementTarget, interrupted.waiting, upgradeWaitStartedAt)
				if (decision.action === "cleared") {
					console.error("Running tool calls finished; continuing service replacement…")
					if (!await ensureOldServiceStopped(replacementTarget, decision.interrupted)) {
						throw new Error(`Existing pinano service pid ${pid} did not exit after running tool calls finished`)
					}
				} else if (decision.action === "hard") {
					console.error("Hard-interrupting old service…")
					await interruptOldService(replacementTarget, "hard", 0)
					if (!await waitForProcessExit(pid, 3000) && !await terminateProcess(pid)) {
						throw new Error(`Existing pinano service pid ${pid} did not exit after hard interrupt`)
					}
				} else if (decision.action === "error") {
					if (!await ensureOldServiceStopped(replacementTarget, decision.interrupted)) {
						throw new Error(`Existing pinano service pid ${pid} is alive but unreachable (${decision.interrupted?.error || "ping failed"}). Stop it, or set PINANO_SERVICE_HARD_INTERRUPT=1 to force replacement.`)
					}
				} else {
					console.error("Run again after they finish, or set PINANO_SERVICE_HARD_INTERRUPT=1 to replace the service.")
					throw new Error("Existing pinano service is busy")
				}
			} else if (!await ensureOldServiceStopped(replacementTarget, interrupted)) {
				throw new Error(`Existing pinano service pid ${pid} is alive but unreachable (${interrupted?.error || "ping failed"}). Stop it, or set PINANO_SERVICE_HARD_INTERRUPT=1 to force replacement.`)
			}
		}
		await removeStaleServiceInfo()
	}
	await mkdir(serviceDir(), { recursive: true })
	const logPath = serviceLogPath()
	const logFd = openSync(logPath, "a")
	const serviceRunId = randomUUID()
	await ensureCurrentRuntimeIsDesired(runtimeIdentity, options.serviceClaimId)
	const argv = [mainPath, "service", "run", "--service-host", endpoint.host, "--service-port", String(endpoint.port), "--service-run-id", serviceRunId]
	if (options.serviceClaimId) argv.push("--service-claim-id", options.serviceClaimId)
	if (options.noContextFiles) argv.push("--no-context-files")
	const child = spawn(process.execPath, argv, {
		cwd: options.cwd,
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: process.env,
	})
	let childStartupFailure = ""
	const onChildStartupError = (err) => {
		childStartupFailure = `spawn failed: ${err.message}`
		appendServiceLog("service_spawn_error", { serviceRunId, error: err.message }).catch(() => {})
	}
	const onChildStartupExit = (code, signal) => {
		childStartupFailure = `process exited before startup${signal ? ` from ${signal}` : ` with code ${code ?? 0}`}`
		appendServiceLog("service_spawned_child_exit", { serviceRunId, code, signal }).catch(() => {})
	}
	child.once("error", onChildStartupError)
	child.once("exit", onChildStartupExit)
	child.unref?.()
	closeSync(logFd)

	const deadline = Date.now() + (options.startupTimeoutMs ?? 5000)
	while (Date.now() < deadline) {
		const info = await readInfo()
		if (info?.serviceRunId === serviceRunId && info.transport === "tcp" && await ping(info, runtimeIdentity)) {
			child.off("error", onChildStartupError)
			child.off("exit", onChildStartupExit)
			return info
		}
		if (childStartupFailure) throw new Error(`Pinano service ${childStartupFailure}. See ${logPath}`)
		await delay(100)
	}
	throw new Error(`Timed out starting pinano service. See ${logPath}`)
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {boolean} [options.noContextFiles]
 * @param {string} [options.sessionListCwd]
 */
export async function openServiceClient(options) {
	const runtimeIdentity = await claimCurrentRuntimeIdentity()
	const info = await ensureService({ ...options, serviceClaimId: runtimeIdentity.claimId })
	return createServiceClient(info, {
		cwd: options.cwd,
		sessionListCwd: options.sessionListCwd,
		noContextFiles: options.noContextFiles,
		runtimeIdentity,
		reconnect: true,
	})
}

export function createServiceClient(info, options = {}) {
	let currentInfo = info
	const clientCwd = options.cwd
	const sessionListCwd = options.sessionListCwd
	const runtimeIdentity = options.runtimeIdentity
	const canReconnect = options.reconnect === true
	const sessionsPath = () => sessionListCwd ? `/sessions?cwd=${encodeURIComponent(sessionListCwd)}` : "/sessions"
	const sessionActionPath = (id, action) => `/sessions/${encodeURIComponent(id)}/${action}${sessionListCwd ? `?cwd=${encodeURIComponent(sessionListCwd)}` : ""}`
	const filterSessionEvent = (event) => {
		if (!sessionListCwd || !Array.isArray(event?.sessions)) return event
		return { ...event, sessions: event.sessions.filter((session) => session.cwd === sessionListCwd) }
	}
	const reconnectOptions = () => ({
		cwd: clientCwd || currentInfo.cwd || process.cwd(),
		noContextFiles: options.noContextFiles === true,
	})
	const isServiceTransportError = (err) => {
		const code = /** @type {any} */ (err)?.code
		if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code)) return true
		const message = String(/** @type {any} */ (err)?.message ?? err)
		return /\b(ENOENT|ECONNREFUSED|ECONNRESET|EPIPE)\b|no such file or directory|socket hang up/i.test(message)
	}
	const reconnect = async () => {
		if (!canReconnect) return false
		currentInfo = await ensureService(reconnectOptions())
		return true
	}
	const verifyCurrentRuntimeDesired = async () => {
		if (runtimeIdentity) await ensureCurrentRuntimeIsDesired(runtimeIdentity)
	}
	const serviceApiPath = (path) => path.startsWith(SERVICE_ROUTE_PREFIX) ? path : `${SERVICE_ROUTE_PREFIX}${path}`
	const request = async (path, requestOptions = {}) => {
		await verifyCurrentRuntimeDesired()
		try {
			return await requestJson(currentInfo, serviceApiPath(path), requestOptions)
		} catch (err) {
			if (!isServiceTransportError(err) || !await reconnect()) throw err
			return requestJson(currentInfo, serviceApiPath(path), requestOptions)
		}
	}
	return {
		get info() {
			return currentInfo
		},
		async sessions() {
			return (await request(sessionsPath())).sessions
		},
		async webStatus() {
			return request("/web/status")
		},
		async desiredRuntime() {
			return readDesiredRuntimeIdentity()
		},
		async startWeb(options = {}) {
			return request("/web/start", {
				method: "POST",
				body: JSON.stringify(options),
			})
		},
		async stopWeb() {
			return request("/web/stop", { method: "POST", body: "{}" })
		},
		async getSettings() {
			return request("/settings")
		},
		async createSession(options = {}) {
			return request("/sessions", {
				method: "POST",
				body: JSON.stringify({ prompt: options.prompt, cwd: clientCwd }),
			})
		},
		async setDefaultModel(model) {
			return request("/settings", {
				method: "POST",
				body: JSON.stringify({ model }),
			})
		},
		async setDefaultReasoning(level) {
			return request("/settings", {
				method: "POST",
				body: JSON.stringify({ thinkingLevel: level }),
			})
		},
		async branchSession(id) {
			return request(sessionActionPath(id, "branch"), { method: "POST", body: "{}" })
		},
		async snapshot(id, options = {}) {
			const includeSessions = options.includeSessions === true ? "?includeSessions=1" : ""
			return request(`/sessions/${encodeURIComponent(id)}/snapshot${includeSessions}`)
		},
		async prompt(id, message, streamingBehavior, options = {}) {
			return request(`/sessions/${encodeURIComponent(id)}/prompt`, {
				method: "POST",
				body: JSON.stringify({
					message,
					streamingBehavior,
					draftClientId: options.draftClientId,
					draftClientSeq: options.draftClientSeq,
				}),
			})
		},
		async setPromptDraft(id, text, options = {}) {
			return request(`/sessions/${encodeURIComponent(id)}/draft`, {
				method: "POST",
				body: JSON.stringify({ text, clientId: options.clientId, clientSeq: options.clientSeq }),
			})
		},
		async continueRun(id) {
			return request(`/sessions/${encodeURIComponent(id)}/continue`, { method: "POST", body: "{}" })
		},
		async abort(id) {
			return request(`/sessions/${encodeURIComponent(id)}/abort`, { method: "POST", body: "{}" })
		},
		async cancelPrompt(id) {
			return request(`/sessions/${encodeURIComponent(id)}/cancel-prompt`, { method: "POST", body: "{}" })
		},
		async markCompleted(id) {
			return request(sessionActionPath(id, "complete"), { method: "POST", body: "{}" })
		},
		async markDeferred(id) {
			return request(sessionActionPath(id, "defer"), { method: "POST", body: "{}" })
		},
		async markReadyForReview(id) {
			return request(sessionActionPath(id, "review"), { method: "POST", body: "{}" })
		},
		async deleteSession(id) {
			return request(sessionActionPath(id, "delete"), { method: "POST", body: "{}" })
		},
		async setThinking(id, level) {
			return request(`/sessions/${encodeURIComponent(id)}/reasoning`, {
				method: "POST",
				body: JSON.stringify({ level }),
			})
		},
		async setFast(id, args) {
			return request(`/sessions/${encodeURIComponent(id)}/fast`, {
				method: "POST",
				body: JSON.stringify({ args }),
			})
		},
		async compact(id) {
			return request(`/sessions/${encodeURIComponent(id)}/compact`, { method: "POST", body: "{}" })
		},
		async bash(id, text) {
			return request(`/sessions/${encodeURIComponent(id)}/bash`, {
				method: "POST",
				body: JSON.stringify({ text }),
			})
		},
		async rewindTargets(id) {
			return (await request(`/sessions/${encodeURIComponent(id)}/rewind-targets`)).targets
		},
		async rewind(id, entryId, options = {}) {
			return request(`/sessions/${encodeURIComponent(id)}/rewind`, {
				method: "POST",
				body: JSON.stringify({
					entryId,
					targetKind: options.targetKind,
					summary: options.summary === true,
					restoreFiles: options.restoreFiles === true,
					restoreConversation: options.restoreConversation !== false,
				}),
			})
		},
		async interrupt(mode = "soft", waitMs = 0) {
			return request("/interrupt", {
				method: "POST",
				body: JSON.stringify({ mode, waitMs }),
			})
		},
		subscribe(onEvent) {
			let closed = false
			let eventClientId = ""
			let sseBuffer = ""
			let req = /** @type {import("node:http").ClientRequest | undefined} */ (undefined)
			let reconnectTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
			let runtimeCheckTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
			const bodyDecoder = new TextDecoder()
			const emitSse = (text) => {
				sseBuffer += text
				for (;;) {
					const match = /\r?\n\r?\n/.exec(sseBuffer)
					if (!match) break
					const event = sseBuffer.slice(0, match.index)
					sseBuffer = sseBuffer.slice(match.index + match[0].length)
					const data = event
						.replaceAll("\r", "")
						.split("\n")
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.startsWith("data: ") ? line.slice(6) : line.slice(5))
						.join("\n")
					if (!data) continue
					const parsed = JSON.parse(data)
					if (parsed.eventClientId) eventClientId = parsed.eventClientId
					onEvent(filterSessionEvent(parsed))
				}
			}
			const scheduleReconnect = (err) => {
				if (closed || !canReconnect) return false
				if (err && !isServiceTransportError(err)) return false
				if (reconnectTimer) return true
				reconnectTimer = setTimeout(() => {
					reconnectTimer = undefined
					reconnect()
						.then(() => {
							if (!closed) connect()
						})
						.catch((nextErr) => {
							if (!closed) onEvent({ type: "error", error: nextErr?.message ?? String(nextErr) })
						})
				}, 250)
				reconnectTimer.unref?.()
				return true
			}
			const fail = (err) => {
				if (!closed && !scheduleReconnect(err)) onEvent({ type: "error", error: err?.message ?? String(err) })
			}
			if (runtimeIdentity) {
				runtimeCheckTimer = setInterval(() => {
					verifyCurrentRuntimeDesired().catch(fail)
				}, 1000)
				runtimeCheckTimer.unref?.()
			}
			const connect = () => {
				if (closed) return
				eventClientId = ""
				sseBuffer = ""
				req = http.request({
					...serviceHttpOptions(currentInfo, serviceApiPath("/events")),
					method: "GET",
					headers: {
						"host": "pinano.local",
						"accept": "text/event-stream",
						"connection": "keep-alive",
						...(currentInfo.token ? { "authorization": `Bearer ${currentInfo.token}` } : {}),
					},
				}, (res) => {
					if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
						fail(new Error(`service event stream HTTP ${res.statusCode ?? 0}`))
						res.resume()
						return
					}
					res.on("data", (chunk) => {
						try {
							emitSse(bodyDecoder.decode(Buffer.from(chunk), { stream: true }))
						} catch (err) {
							fail(err)
							req?.destroy()
						}
					})
					res.on("end", () => {
						try {
							const tail = bodyDecoder.decode()
							if (tail) emitSse(tail)
						} catch (err) {
							fail(err)
							return
						}
						scheduleReconnect()
					})
				})
				req.on("error", fail)
				req.end()
			}
			connect()
			return async () => {
				if (closed) return
				closed = true
				if (reconnectTimer) clearTimeout(reconnectTimer)
				if (runtimeCheckTimer) clearInterval(runtimeCheckTimer)
				const closePromise = eventClientId
					? requestJson(currentInfo, serviceApiPath(`/event-clients/${encodeURIComponent(eventClientId)}/close`), { method: "POST", body: "{}" }).catch(() => {})
					: Promise.resolve()
				req?.destroy()
				await closePromise
			}
		},
	}
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.prompt
 * @param {boolean} [options.noContextFiles]
 */
export async function dispatchBackground(options) {
	const client = await openServiceClient(options)
	const created = await client.createSession({ prompt: options.prompt })
	return { sessionId: created.sessionId, service: client.info }
}

/**
 * @param {object} options
 * @param {string} options.cwd
 */
export async function serviceStatus(options) {
	const info = await readInfo()
	let health = null
	if (info) {
		try {
			health = await requestJson(info, "/health")
		} catch {}
	}
	const desiredRuntime = await readDesiredRuntimeIdentity()
	return {
		info,
		alive: health?.ok === true,
		pidAlive: processExists(servicePid(info)),
		health,
		desiredRuntime,
		logPath: serviceLogPath(),
		serviceInfoPath: info?.[INFO_PATH] ?? serviceInfoPath(),
		desiredRuntimeIdentityPath: desiredRuntimeIdentityPath(),
	}
}

function valueOrDash(value) {
	return value === undefined || value === null || value === "" ? "-" : String(value)
}

function shortId(value) {
	return typeof value === "string" && value.length > 12 ? value.slice(0, 12) : valueOrDash(value)
}

function formatWebStatus(web) {
	if (!web?.running) return "stopped"
	const host = web.host ?? "127.0.0.1"
	const port = web.port ?? web.requestedPort ?? "?"
	const publicUrl = web.publicUrl ? ` (${web.publicUrl})` : ""
	return `${host}:${port}${publicUrl}`
}

function formatTransport(info) {
	if (!info) return "-"
	if (info.transport === "tcp") {
		const fallback = info.portFallback && info.requestedPort ? ` (fallback from ${info.requestedPort})` : ""
		return `tcp:${valueOrDash(info.host || "127.0.0.1")}:${valueOrDash(info.port)}${fallback}`
	}
	return `unsupported:${valueOrDash(info.transport)}`
}

/** @param {Awaited<ReturnType<typeof serviceStatus>>} status */
export function formatServiceStatus(status) {
	const info = status.info
	const health = status.health
	const state = status.alive ? "alive" : info ? (status.pidAlive ? "unhealthy" : "stopped") : "not running"
	const lines = [
		`pinano service: ${state}`,
		`pid: ${valueOrDash(info?.pid)}${status.pidAlive ? " (alive)" : info ? " (not running)" : ""}`,
		`run: ${shortId(info?.serviceRunId ?? health?.serviceRunId)}`,
		`started: ${valueOrDash(info?.startedAt)}`,
		`cwd: ${valueOrDash(info?.cwd ?? health?.cwd)}`,
		`main: ${valueOrDash(info?.mainPath ?? health?.mainPath)}`,
		`exec: ${valueOrDash(info?.execPath ?? health?.execPath)}`,
		`desired: ${valueOrDash(status.desiredRuntime?.mainPath ?? status.desiredRuntime?.packageRoot)}`,
		`transport: ${formatTransport(info)}`,
		`web: ${formatWebStatus(health?.web)}`,
		`active requests: ${valueOrDash(health?.activeRequests)}`,
		`running sessions: ${health?.runningSessions?.length ?? 0}`,
		`background sessions: ${health?.backgroundSessions?.length ?? 0}`,
		`diagnostics: ${health?.diagnostics?.enabled ? valueOrDash(health.diagnostics.path) : "disabled"}`,
		`info: ${status.serviceInfoPath}`,
		`desired info: ${status.desiredRuntimeIdentityPath}`,
		`log: ${status.logPath}`,
	]
	return lines.join("\n")
}
