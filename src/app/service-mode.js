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

import { dataRoot, runtimeSourceReferencePath, serviceStateDir } from "./paths.js"
import { ensureRuntimeSourceReference } from "./runtime-source-reference.js"
import { canonicalModelRef, parseModelRef } from "./models.js"
import { loadSettings, updateSetting, updateSettings } from "./settings.js"
import { RuntimeManager } from "./server-runtime.js"
import { authenticateRequest } from "./http-auth.js"
import { configuredServiceDebug, configuredServiceDiagnostics, configuredServiceEndpointDefaults, configuredServiceToken, configuredWebDefaults } from "./service-config.js"
import { createServiceDiagnostics } from "./service-diagnostics.js"
import { createDebugInspectApp, isDebugRequestPath } from "./debug-inspect.js"
import { WebRouter } from "./web-router.js"
import { createManagerClientApi, json, jsonBody, registerClientApiRoutes, routeError } from "./client-api.js"
import { writeResponseBody } from "./http-response.js"
import { createEventHub } from "./sse-event-hub.js"
import { startCodexUsagePoller } from "./codex-usage-poller.js"

/** @typedef {import("./agent-runtime.js").AgentRuntime} Agent */

export const SERVICE_PROTOCOL_VERSION = 4

const SERVICE_IDLE_SHUTDOWN_DELAY_MS = 1000
const DESIRED_RUNTIME_LOCK_TTL_MS = 10000
const DESIRED_RUNTIME_LOCK_TIMEOUT_MS = DESIRED_RUNTIME_LOCK_TTL_MS + 2000
const SERVICE_LIFECYCLE_LOCK_TTL_MS = 30000
const SERVICE_LIFECYCLE_LOCK_TIMEOUT_MS = 5 * 60 * 1000
const SERVICE_OWNERSHIP_CHECK_INTERVAL_MS = 1000
const SERVICE_UPGRADE_SOFT_WAIT_MS = 5000
const SERVICE_UPGRADE_BLOCKED_POLL_MS = 1000
const SERVICE_CONNECTIVITY_TIMEOUT_MS = 1500
const SERVICE_REQUEST_TIMEOUT_MS = 30000
const SERVICE_EVENT_HEARTBEAT_INTERVAL_MS = 10000
const SERVICE_EVENT_STALL_TIMEOUT_MS = 30000
const SERVICE_SSE_PARSE_ERROR_CODE = "PINANO_SERVICE_SSE_PARSE_ERROR"
const processStartedAtMs = Date.now()

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = join(here, "..")
const packageRoot = join(sourceRoot, "..")
const mainPath = join(here, "main.js")
const INFO_PATH = Symbol("serviceInfoPath")

function serviceDir() {
	return serviceStateDir()
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

function serviceLifecycleLockPath() {
	return join(serviceDir(), "service-lifecycle.lock")
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

function authError(auth) {
	return json({ error: auth.error || "Unauthorized" }, auth.status || 401)
}

function createServiceToken() {
	return configuredServiceToken() || randomUUID()
}

/**
 * @param {string} ref
 * @param {import("./settings.js").Settings} current
 */
async function updateDefaultModel(ref, current) {
	const currentProvider = parseModelRef(current.defaultModel).provider
	return updateSettings({ defaultModel: canonicalModelRef(ref, { provider: currentProvider, providers: current.providers }) })
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

async function acquireDirectoryLock(lockPath, { timeoutMs, ttlMs, label }) {
	await mkdir(dirname(lockPath), { recursive: true })
	const deadline = Date.now() + timeoutMs
	for (;;) {
		try {
			await mkdir(lockPath)
			let released = false
			const lockId = randomUUID()
			const ownerPath = join(lockPath, "owner.json")
			const heartbeatPath = join(lockPath, "heartbeat")
			await writeFile(ownerPath, JSON.stringify({
				lockId,
				pid: process.pid,
				startedAtMs: processStartedAtMs,
				startedAt: new Date().toISOString(),
			}, null, "\t"), { mode: 0o600 })
			const writeHeartbeat = () => writeFile(heartbeatPath, new Date().toISOString(), { mode: 0o600 }).catch(() => {})
			await writeHeartbeat()
			const heartbeatTimer = setInterval(writeHeartbeat, Math.max(1000, Math.floor(ttlMs / 3)))
			heartbeatTimer.unref?.()
			return async () => {
				if (released) return
				released = true
				clearInterval(heartbeatTimer)
				try {
					const owner = JSON.parse(await readFile(ownerPath, "utf-8"))
					if (owner?.lockId !== lockId) return
				} catch {
					return
				}
				await rm(lockPath, { recursive: true, force: true }).catch(() => {})
			}
		} catch (/** @type {any} */ err) {
			if (err?.code !== "EEXIST") throw err
			try {
				const s = await stat(join(lockPath, "heartbeat"))
					.catch(() => stat(join(lockPath, "owner.json")))
					.catch(() => stat(lockPath))
				if (Date.now() - s.mtimeMs > ttlMs) {
					await rm(lockPath, { recursive: true, force: true })
					continue
				}
			} catch {}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}: ${lockPath}`)
			await delay(25)
		}
	}
}

async function acquireDesiredRuntimeLock(timeoutMs = DESIRED_RUNTIME_LOCK_TIMEOUT_MS) {
	return acquireDirectoryLock(desiredRuntimeLockPath(), {
		timeoutMs,
		ttlMs: DESIRED_RUNTIME_LOCK_TTL_MS,
		label: "desired runtime lock",
	})
}

async function acquireServiceLifecycleLock(timeoutMs = SERVICE_LIFECYCLE_LOCK_TIMEOUT_MS) {
	return acquireDirectoryLock(serviceLifecycleLockPath(), {
		timeoutMs,
		ttlMs: SERVICE_LIFECYCLE_LOCK_TTL_MS,
		label: "service lifecycle lock",
	})
}

async function withDesiredRuntimeLock(fn) {
	const release = await acquireDesiredRuntimeLock()
	try {
		return await fn()
	} finally {
		await release()
	}
}

async function withServiceLifecycleLock(fn) {
	const release = await acquireServiceLifecycleLock()
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
		if (runtimeIdentityMatches(desired, identity) && desiredHasRuntimeState(desired) && desired.claimId) return { ...identity, claimId: desired.claimId }
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
	})
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
 * @param {number} [options.eventHeartbeatIntervalMs]
 * @param {number} [options.serviceOwnershipCheckIntervalMs]
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
	const serviceToken = typeof options.token === "string" && options.token ? options.token : createServiceToken()
	const runtimeIdentity = await processRuntimeIdentity()
	const codeFingerprint = runtimeIdentity.codeFingerprint
	if (options.serviceClaimId) await ensureCurrentRuntimeIsDesired(runtimeIdentity, options.serviceClaimId)
	else await claimCurrentRuntimeIdentity()
	const sourceReference = await ensureRuntimeSourceReference(runtimeIdentity)
	await appendServiceLog("runtime_source_reference_ready", { path: sourceReference.path, generation: sourceReference.generation })
	const serviceRunId = options.serviceRunId ?? randomUUID()
	const serviceStartedAt = new Date().toISOString()
	let activeRequests = 0
	let idleTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
	let ownershipCheckTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
	let closed = false
	let lostServiceOwnership = false
	let shutdownReason = "clean_shutdown"
	const clearIdleTimer = () => {
		if (!idleTimer) return
		clearTimeout(idleTimer)
		idleTimer = undefined
	}
	const clearOwnershipCheckTimer = () => {
		if (!ownershipCheckTimer) return
		clearInterval(ownershipCheckTimer)
		ownershipCheckTimer = undefined
	}
	const hub = createEventHub(() => scheduleIdleCheck(), { heartbeatIntervalMs: options.eventHeartbeatIntervalMs })
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
		getSettings: () => serviceModelOverride ? serviceSettings : { ...serviceSettings, defaultModel: undefined },
		noContextFiles: options.noContextFiles === true,
		diagnostics,
	}, db, hub)
	manager.resumeRunnableInterruptedRuns().catch((err) => console.error("service auto-resume error", err))
	let server
	let serviceEndpoint = /** @type {{ host?: string, port?: number, requestedPort?: number, portFallback?: boolean }} */ ({ host: options.host, port: options.port, requestedPort: options.port, portFallback: false })
	let webServer = /** @type {any} */ (undefined)
	let webOptions = /** @type {any} */ (undefined)
	let codexUsagePoller = { close() {} }
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
		await exitAfterCleanup(0)
	}
	async function exitAfterCleanup(exitCode = 0) {
		await cleanup()
		if (options.onIdle) await options.onIdle()
		else process.exit(exitCode)
	}
	function scheduleExitAfterCleanup(exitCode = 0) {
		setTimeout(() => {
			exitAfterCleanup(exitCode).catch((err) => {
				console.error("service shutdown error", err)
				if (!options.onIdle) process.exit(1)
			})
		}, 20)
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
	const hasAgentWork = () => runningRuntimes().length > 0 || backgroundRuntimes().length > 0
	async function readServiceInfoOwnership() {
		try {
			return { info: normalizeServiceInfo(JSON.parse(await readFile(serviceInfoFile, "utf-8")), serviceInfoFile) }
		} catch (/** @type {any} */ err) {
			if (err?.code === "ENOENT") return { missing: true }
			return { error: err?.message ?? String(err) }
		}
	}
	async function handleLostServiceOwnership(owner) {
		if (!lostServiceOwnership) {
			lostServiceOwnership = true
			shutdownReason = "lost_service_ownership"
			await appendServiceLog("service_lost_ownership", {
				serviceRunId,
				ownerServiceRunId: owner?.info?.serviceRunId,
				ownerPid: owner?.info?.pid,
				missingInfo: owner?.missing === true || undefined,
			})
			try { hub.send({ type: "error", error: "Pinano service lost ownership; reconnecting." }) } catch {}
			try { hub.closeAll?.() } catch {}
			try { await stopWeb() } catch {}
			try { server?.close?.() } catch {}
		}
		if (hasAgentWork()) return
		await exitAfterCleanup(0)
	}
	async function checkServiceOwnership() {
		if (closed) return
		const owner = await readServiceInfoOwnership()
		if (owner.error) return
		if (owner.info?.serviceRunId === serviceRunId) return
		await handleLostServiceOwnership(owner)
	}
	function startOwnershipChecks() {
		clearOwnershipCheckTimer()
		const intervalMs = Number.isFinite(options.serviceOwnershipCheckIntervalMs)
			? Math.max(25, Number(options.serviceOwnershipCheckIntervalMs))
			: SERVICE_OWNERSHIP_CHECK_INTERVAL_MS
		ownershipCheckTimer = setInterval(() => {
			checkServiceOwnership().catch((err) => {
				console.error("service ownership check error", err)
			})
		}, intervalMs)
		ownershipCheckTimer.unref?.()
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
		if (configuredHost && configuredHost !== endpointHost) throw Object.assign(new Error(`Pinano Web is configured for host ${configuredHost}, but the running service is bound to ${endpointHost}; restart the service after updating service.web in Pinano settings.`), { status: 409 })
		if (configuredFixedPort && configuredFixedPort !== endpointPort) throw Object.assign(new Error(`Pinano Web is configured for port ${configuredFixedPort}, but the running service is on ${endpointHost}:${endpointPort}. Free the configured port and restart the service, or update service.web in Pinano settings.`), { status: 409 })
		if (serviceEndpoint.portFallback && fallbackPort > 0) throw Object.assign(new Error(`Pinano Web cannot start on fallback service port ${endpointPort}; requested port ${fallbackPort} was unavailable when the service started. Free the requested port and restart the service, or update service.web in Pinano settings.`), { status: 409 })
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
				serviceSettings = await updateDefaultModel(model, serviceSettings)
				return serviceSettings
			},
			setDefaultReasoning: async (level) => {
				serviceSettings = await updateSetting("thinkingLevel", /** @type {any} */ (level))
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

	const serviceApi = createManagerClientApi({
		cwd: options.cwd,
		manager,
		hub,
		resolveId,
		getSettings: () => serviceSettings,
		setDefaultModel: async (model) => {
			serviceModelOverride = true
			serviceSettings = await updateDefaultModel(model, serviceSettings)
			return serviceSettings
		},
		setDefaultReasoning: async (level) => {
			serviceSettings = await updateSetting("thinkingLevel", /** @type {any} */ (level))
			return serviceSettings
		},
	})
	const serviceApp = new WebRouter()
	const debugApp = createDebugInspectApp({
		getConfig: configuredServiceDebug,
		getEndpoint: () => serviceEndpoint,
		getDiagnostics: () => diagnostics,
		getEventHub: () => hub,
		getManager: () => manager,
		resolveSessionId: resolveId,
		heapSnapshotDir: () => join(serviceDir(), "heap-snapshots"),
		getServiceState: () => ({
			serviceRunId,
			serviceStartedAt,
			processStartedAtMs,
			cwd: options.cwd,
			endpoint: serviceEndpoint,
			protocolVersion: SERVICE_PROTOCOL_VERSION,
			codeFingerprint,
			runtimeKey: runtimeIdentity.runtimeKey,
			packageName: runtimeIdentity.packageName,
			packageVersion: runtimeIdentity.packageVersion,
			mainPath,
			sourceRoot,
			packageRoot,
			activeRequests,
			web: webStatus(false),
		}),
	})
	const serviceRoutePath = (prefix, suffix) => prefix ? `${prefix}${suffix}` : suffix
	const safeServiceRoute = (handler) => async (context) => {
		try {
			return await handler(context)
		} catch (err) {
			return routeError(err)
		}
	}
	const registerServiceManagementRoutes = (prefix) => {
		const path = (suffix) => serviceRoutePath(prefix, suffix)
		serviceApp.get(path("/health"), safeServiceRoute(async () => json({
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
		})))
		serviceApp.get(path("/web/status"), safeServiceRoute(async () => json({ ok: true, web: webStatus() })))
		serviceApp.post(path("/web/start"), safeServiceRoute(async (context) => json(await startWeb(await jsonBody(context)))))
		serviceApp.post(path("/web/stop"), safeServiceRoute(async () => json({ ok: true, stopped: await stopWeb(), web: webStatus() })))
		serviceApp.post(path("/event-clients/:id/close"), safeServiceRoute(async (context) => {
			hub.closeClient(context.req.param("id") ?? "")
			return json({ ok: true })
		}))
		serviceApp.post(path("/interrupt"), safeServiceRoute(async (context) => {
			const body = await jsonBody(context)
			const mode = body.mode === "hard" ? "hard" : "soft"
			if (mode === "hard") {
				for (const runtime of runningRuntimes()) runtime.agent.abort()
				shutdownReason = "hard_interrupt"
				scheduleExitAfterCleanup(0)
				return json({ ok: true, mode, exiting: true, waiting: waitingInfos() })
			}

			for (const runtime of runningRuntimes()) runtime.softInterrupt()
			const waitMs = Number.isFinite(body.waitMs) ? Math.max(0, body.waitMs) : 0
			if (waitMs > 0) await waitForNoRunning(Date.now() + waitMs)
			const waiting = waitingInfos()
			if (waiting.length > 0) return json({ ok: false, mode, exiting: false, waiting })
			shutdownReason = "soft_interrupt"
			scheduleExitAfterCleanup(0)
			return json({ ok: true, mode, exiting: true, waiting })
		}))
	}
	registerClientApiRoutes(serviceApp, serviceApi, { prefix: SERVICE_ROUTE_PREFIX, includeSnapshotRoute: true })
	registerClientApiRoutes(serviceApp, serviceApi)
	registerServiceManagementRoutes(SERVICE_ROUTE_PREFIX)
	registerServiceManagementRoutes("")
	serviceApp.use("*", () => json({ error: "Not Found" }, 404))

	/** @param {Request} req */
	const handleServiceRequest = (req) => serviceApp.fetch(req)

	/** @param {Request} req */
	const handle = async (req) => {
		const url = new URL(req.url)
		if (isDebugRequestPath(url.pathname)) return debugApp.fetch(req)
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
				await writeResponseBody(incoming, outgoing, response)
				if (!outgoing.destroyed) await new Promise((resolve) => outgoing.end(resolve))
			} else {
				outgoing.writeHead(response.status, headers)
				await writeResponseBody(incoming, outgoing, response)
				if (!outgoing.destroyed) await new Promise((resolve) => outgoing.end(resolve))
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
	const serviceInfoDir = serviceDir()
	const serviceInfoFile = join(serviceInfoDir, "service.json")
	const serviceInfo = {
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
	}
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
	await mkdir(serviceInfoDir, { recursive: true })
	await writePrivateJson(serviceInfoFile, serviceInfo)
	await appendServiceLog("service_started", { pid: process.pid, serviceRunId, cwd: options.cwd, transport: "tcp", host, port, requestedPort, portFallback, codeFingerprint, runtimeKey: runtimeIdentity.runtimeKey })
	startOwnershipChecks()
	codexUsagePoller = startCodexUsagePoller({ getSettings: () => serviceSettings })

	const cleanup = async () => {
		if (closed) return
		closed = true
		clearIdleTimer()
		clearOwnershipCheckTimer()
		try { codexUsagePoller.close() } catch {}
		try { hub.closeAll?.() } catch {}
		try { await stopWeb() } catch {}
		try { server.close() } catch {}
		try { manager.dispose() } catch {}
		try { db.finishServiceRun(serviceRunId, { status: "clean_exit", reason: shutdownReason }) } catch {}
		try { db.close() } catch {}
		try { await diagnostics.close() } catch {}
		let info = null
		try {
			info = normalizeServiceInfo(JSON.parse(await readFile(serviceInfoFile, "utf-8")), serviceInfoFile)
		} catch {}
		const ownsInfo = !info || info.serviceRunId === serviceRunId
		await appendServiceLog("service_cleanup", { serviceRunId, reason: shutdownReason, ownsInfo, ownerServiceRunId: info?.serviceRunId, ownerPid: info?.pid })
		if (ownsInfo) {
			try { await rm(serviceInfoFile, { force: true }) } catch {}
		} else {
			await appendServiceLog("cleanup_skipped_foreign_service_info", { serviceRunId, ownerServiceRunId: info.serviceRunId, ownerPid: info.pid })
		}
	}
	process.once("SIGINT", () => {
		shutdownReason = "signal_SIGINT"
		exitAfterCleanup(0).catch((err) => {
			console.error("service shutdown error", err)
			if (!options.onIdle) process.exit(1)
		})
	})
	process.once("SIGTERM", () => {
		shutdownReason = "signal_SIGTERM"
		exitAfterCleanup(0).catch((err) => {
			console.error("service shutdown error", err)
			if (!options.onIdle) process.exit(1)
		})
	})
	process.once("exit", () => {
		if (!closed) {
			try { db.finishServiceRun(serviceRunId, { status: "process_exit", reason: "process_exit_without_cleanup" }) } catch {}
		}
		try { manager.dispose() } catch {}
		try { db.close() } catch {}
	})
	scheduleIdleCheck()
	return { manager, db, info: normalizeServiceInfo(serviceInfo, serviceInfoFile), close: cleanup }
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

function serviceTimeoutError(kind, path, timeoutMs) {
	const suffix = path ? ` (${path})` : ""
	return Object.assign(new Error(`Pinano service ${kind} timed out after ${timeoutMs}ms${suffix}`), { code: "PINANO_SERVICE_TIMEOUT" })
}

function serviceSseParseError(err, data) {
	const text = String(data)
	const message = err?.message ?? String(err)
	const dataSha256 = createHash("sha256").update(text).digest("hex")
	return Object.assign(new Error(`Pinano service event stream JSON parse failed after ${text.length} bytes (sha256=${dataSha256}): ${message}`), {
		code: SERVICE_SSE_PARSE_ERROR_CODE,
		dataLength: text.length,
		dataSha256,
		cause: err instanceof Error ? err : undefined,
	})
}

function isServiceTimeoutError(err) {
	if (/** @type {any} */ (err)?.code === "PINANO_SERVICE_TIMEOUT") return true
	return /timed out/i.test(String(/** @type {any} */ (err)?.message ?? err))
}

/**
 * @param {any} info
 * @param {string} path
 * @param {{ method?: string, body?: string, headers?: Record<string, string>, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, headers: import("node:http").IncomingHttpHeaders, body: string }>}
 */
function requestText(info, path, options = {}) {
	return new Promise((resolve, reject) => {
		const body = options.body ?? ""
		const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 0
		let settled = false
		let timeoutTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
		let req = /** @type {import("node:http").ClientRequest | undefined} */ (undefined)
		const cleanup = () => {
			if (timeoutTimer) clearTimeout(timeoutTimer)
			options.signal?.removeEventListener?.("abort", abortRequest)
		}
		const settle = (fn, value) => {
			if (settled) return
			settled = true
			cleanup()
			fn(value)
		}
		const fail = (err) => settle(reject, err)
		const abortRequest = () => {
			const err = Object.assign(new Error(`Pinano service request aborted (${path})`), { code: "ABORT_ERR" })
			fail(err)
			req?.destroy?.(err)
		}
		req = http.request({
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
			const decoder = new TextDecoder()
			let responseBody = ""
			res.on("data", (chunk) => {
				responseBody += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
			})
			res.on("end", () => {
				responseBody += decoder.decode()
				const result = {
					status: res.statusCode ?? 0,
					headers: res.headers ?? {},
					body: responseBody,
				}
				settle(resolve, result)
				req.destroy?.()
			})
			res.on("aborted", () => fail(Object.assign(new Error(`Pinano service response aborted (${path})`), { code: "ECONNRESET" })))
			res.on("error", fail)
		})
		req.on("error", fail)
		if (timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				const err = serviceTimeoutError("request", path, timeoutMs)
				fail(err)
				req?.destroy?.(err)
			}, timeoutMs)
			timeoutTimer.unref?.()
		}
		if (options.signal?.aborted) {
			abortRequest()
			return
		}
		options.signal?.addEventListener("abort", abortRequest, { once: true })
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

async function ping(info, expectedIdentity, timeoutMs = SERVICE_CONNECTIVITY_TIMEOUT_MS) {
	if (!info || info.protocolVersion !== SERVICE_PROTOCOL_VERSION) return false
	if (expectedIdentity && !runtimeIdentityMatches(info, expectedIdentity)) return false
	try {
		const res = await requestJson(info, "/health", { timeoutMs })
		return res.ok === true &&
			res.protocolVersion === SERVICE_PROTOCOL_VERSION &&
			(!expectedIdentity || runtimeIdentityMatches(res, expectedIdentity))
	} catch {
		return false
	}
}

async function interruptOldService(info, mode = "soft", waitMs = 0) {
	try {
		return await requestJson(info, "/interrupt", { method: "POST", body: JSON.stringify({ mode, waitMs }), timeoutMs: waitMs + SERVICE_CONNECTIVITY_TIMEOUT_MS })
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
		`pinano service upgrade has waited ${elapsed} for running sessions:`,
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

async function shouldHardInterruptForUpgrade(prompt = "Hard interrupt these running sessions and replace the service? [y/N] ") {
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
	return withServiceLifecycleLock(async () => {
		await ensureCurrentRuntimeIsDesired(runtimeIdentity, options.serviceClaimId)
		return ensureServiceUnlocked(options, runtimeIdentity)
	})
}

async function ensureServiceUnlocked(options, runtimeIdentity) {
	const codeFingerprint = runtimeIdentity.codeFingerprint
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
					console.error("Running sessions finished; continuing service replacement…")
					if (!await ensureOldServiceStopped(replacementTarget, decision.interrupted)) {
						throw new Error(`Existing pinano service pid ${pid} did not exit after running sessions finished`)
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
		const remainingMs = Math.max(1, deadline - Date.now())
		if (info?.serviceRunId === serviceRunId && info.transport === "tcp" && await ping(info, runtimeIdentity, Math.min(SERVICE_CONNECTIVITY_TIMEOUT_MS, remainingMs))) {
			child.off("error", onChildStartupError)
			child.off("exit", onChildStartupExit)
			return info
		}
		if (childStartupFailure) throw new Error(`Pinano service ${childStartupFailure}. See ${logPath}`)
		await delay(100)
	}
	if (child.pid) await terminateProcess(child.pid)
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

/**
 * @param {any} info
 * @param {{ cwd?: string, sessionListCwd?: string, noContextFiles?: boolean, runtimeIdentity?: any, reconnect?: boolean, requestTimeoutMs?: number, eventStallTimeoutMs?: number }} [options]
 */
export function createServiceClient(info, options = {}) {
	let currentInfo = info
	const clientCwd = options.cwd
	const sessionListCwd = options.sessionListCwd
	const runtimeIdentity = options.runtimeIdentity
	const canReconnect = options.reconnect === true
	const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? Math.max(0, options.requestTimeoutMs) : SERVICE_REQUEST_TIMEOUT_MS
	const eventStallTimeoutMs = Number.isFinite(options.eventStallTimeoutMs) ? Math.max(0, options.eventStallTimeoutMs) : SERVICE_EVENT_STALL_TIMEOUT_MS
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
		if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "PINANO_SERVICE_TIMEOUT", SERVICE_SSE_PARSE_ERROR_CODE].includes(code)) return true
		const message = String(/** @type {any} */ (err)?.message ?? err)
		return /\b(ENOENT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE)\b|no such file or directory|socket hang up|timed out/i.test(message)
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
		const method = String(requestOptions.method ?? "GET").toUpperCase()
		const retryOnTimeout = requestOptions.retryOnTimeout ?? method === "GET"
		const requestOptionsWithTimeout = requestOptions.timeoutMs === undefined
			? { ...requestOptions, timeoutMs: requestTimeoutMs }
			: requestOptions
		try {
			return await requestJson(currentInfo, serviceApiPath(path), requestOptionsWithTimeout)
		} catch (err) {
			if (isServiceTimeoutError(err) && !retryOnTimeout) throw err
			if (!isServiceTransportError(err) || !await reconnect()) throw err
			return requestJson(currentInfo, serviceApiPath(path), requestOptionsWithTimeout)
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
				body: JSON.stringify({ prompt: options.prompt, cwd: clientCwd, images: options.images }),
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
			const params = new URLSearchParams()
			if (options.includeSessions === true) params.set("includeSessions", "1")
			if (options.includeContextMessages === true) params.set("includeContextMessages", "1")
			const query = params.size > 0 ? `?${params}` : ""
			return request(`/sessions/${encodeURIComponent(id)}/snapshot${query}`)
		},
		async contextReport(id) {
			return (await request(`/sessions/${encodeURIComponent(id)}/context-report`)).lines ?? []
		},
		async systemReport(id) {
			return (await request(`/sessions/${encodeURIComponent(id)}/system-report`)).lines ?? []
		},
		async worktrees(id) {
			return (await request(`/sessions/${encodeURIComponent(id)}/worktrees`)).worktrees ?? []
		},
		async prompt(id, message, streamingBehavior, options = {}) {
			return request(`/sessions/${encodeURIComponent(id)}/prompt`, {
				method: "POST",
				body: JSON.stringify({
					message,
					streamingBehavior,
					draftClientId: options.draftClientId,
					draftClientSeq: options.draftClientSeq,
					images: options.images,
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
			return request(`/sessions/${encodeURIComponent(id)}/compact`, { method: "POST", body: "{}", timeoutMs: 0 })
		},
		async bash(id, text) {
			return request(`/sessions/${encodeURIComponent(id)}/bash`, {
				method: "POST",
				body: JSON.stringify({ text }),
				timeoutMs: 0,
			})
		},
		async rewindTargets(id) {
			return (await request(`/sessions/${encodeURIComponent(id)}/rewind-targets`)).targets
		},
		async rewind(id, entryId, options = {}) {
			return request(`/sessions/${encodeURIComponent(id)}/rewind`, {
				method: "POST",
				timeoutMs: 0,
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
			const timeoutMs = requestTimeoutMs > 0 ? Math.max(requestTimeoutMs, waitMs + SERVICE_CONNECTIVITY_TIMEOUT_MS) : 0
			return request("/interrupt", {
				method: "POST",
				body: JSON.stringify({ mode, waitMs }),
				timeoutMs,
			})
		},
		subscribe(onEvent) {
			let closed = false
			let eventClientId = ""
			let sseBuffer = ""
			let req = /** @type {import("node:http").ClientRequest | undefined} */ (undefined)
			let reconnectTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
			let runtimeCheckTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
			let stallTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
			let bodyDecoder = new TextDecoder()
			const clearStallTimer = () => {
				if (stallTimer) clearTimeout(stallTimer)
				stallTimer = undefined
			}
			const reportEventHandlerError = (err) => {
				const message = err?.message ?? String(err)
				const stack = err?.stack ? String(err.stack) : ""
				console.error("service event handler error:", stack.includes(message) ? stack : `${message}${stack ? `\n${stack}` : ""}`)
			}
			const dispatchEvent = (event) => {
				try {
					Promise.resolve(onEvent(event)).catch(reportEventHandlerError)
				} catch (err) {
					reportEventHandlerError(err)
				}
			}
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
					let parsed
					try {
						parsed = JSON.parse(data)
					} catch (err) {
						throw serviceSseParseError(err, data)
					}
					if (parsed.eventClientId) eventClientId = parsed.eventClientId
					dispatchEvent(filterSessionEvent(parsed))
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
							if (!closed) {
								connect()
								dispatchEvent({
									type: "service_event_stream_reconnected",
									reason: err?.code === SERVICE_SSE_PARSE_ERROR_CODE ? "sse_parse_error" : "transport",
									errorCode: err?.code,
								})
							}
						})
						.catch((nextErr) => {
							if (!closed) dispatchEvent({ type: "error", error: nextErr?.message ?? String(nextErr) })
						})
				}, 250)
				reconnectTimer.unref?.()
				return true
			}
			const fail = (err) => {
				clearStallTimer()
				if (err?.code === SERVICE_SSE_PARSE_ERROR_CODE) console.error(err.message)
				if (!closed && !scheduleReconnect(err)) dispatchEvent({ type: "error", error: err?.message ?? String(err) })
			}
			const resetStallTimer = () => {
				if (closed || eventStallTimeoutMs <= 0) return
				clearStallTimer()
				stallTimer = setTimeout(() => {
					const err = serviceTimeoutError("event stream", serviceApiPath("/events"), eventStallTimeoutMs)
					req?.destroy?.(err)
					fail(err)
				}, eventStallTimeoutMs)
				stallTimer.unref?.()
			}
			if (runtimeIdentity) {
				runtimeCheckTimer = setInterval(() => {
					verifyCurrentRuntimeDesired().catch(fail)
				}, 1000)
				runtimeCheckTimer.unref?.()
			}
			const connect = () => {
				if (closed) return
				clearStallTimer()
				eventClientId = ""
				sseBuffer = ""
				bodyDecoder = new TextDecoder()
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
					resetStallTimer()
					if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
						clearStallTimer()
						fail(new Error(`service event stream HTTP ${res.statusCode ?? 0}`))
						res.resume()
						return
					}
					res.on("data", (chunk) => {
						resetStallTimer()
						try {
							emitSse(bodyDecoder.decode(Buffer.from(chunk), { stream: true }))
						} catch (err) {
							fail(err)
							req?.destroy()
						}
					})
					res.on("end", () => {
						clearStallTimer()
						try {
							const tail = bodyDecoder.decode()
							if (tail) emitSse(tail)
						} catch (err) {
							fail(err)
							return
						}
						scheduleReconnect()
					})
					res.on("aborted", () => fail(Object.assign(new Error("service event stream aborted"), { code: "ECONNRESET" })))
					res.on("error", fail)
				})
				req.on("error", fail)
				req.end()
				resetStallTimer()
			}
			connect()
			return async () => {
				if (closed) return
				closed = true
				if (reconnectTimer) clearTimeout(reconnectTimer)
				if (runtimeCheckTimer) clearInterval(runtimeCheckTimer)
				clearStallTimer()
				const closePromise = eventClientId
					? requestJson(currentInfo, serviceApiPath(`/event-clients/${encodeURIComponent(eventClientId)}/close`), { method: "POST", body: "{}", timeoutMs: SERVICE_CONNECTIVITY_TIMEOUT_MS }).catch(() => {})
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
			health = await requestJson(info, "/health", { timeoutMs: SERVICE_CONNECTIVITY_TIMEOUT_MS })
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
		runtimeSourceReferencePath: runtimeSourceReferencePath(),
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
		`runtime source: ${status.runtimeSourceReferencePath}`,
		`info: ${status.serviceInfoPath}`,
		`desired info: ${status.desiredRuntimeIdentityPath}`,
		`log: ${status.logPath}`,
	]
	return lines.join("\n")
}
