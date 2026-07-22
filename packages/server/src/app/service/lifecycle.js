// Shared service state, runtime identity, and lifecycle lock helpers.

import { createHash, randomUUID } from "node:crypto"
import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { serviceStateDir } from "../paths.js"
import { canonicalModelRef, parseModelRef } from "../models.js"
import { updateSettings } from "../settings.js"
import { json } from "../client-api.js"
import { clearStaleRuntimeReexecDepth } from "../reexec-runtime.js"
import { WEB_BROWSER_UI_NAME } from "../../../../protocol/src/web-branding.js"

export const SERVICE_PROTOCOL_VERSION = 6

export const DEFAULT_SERVICE_IDLE_SHUTDOWN_DELAY_MS = 30 * 1000
export const DESIRED_RUNTIME_LOCK_TTL_MS = 10000
export const DESIRED_RUNTIME_LOCK_TIMEOUT_MS = DESIRED_RUNTIME_LOCK_TTL_MS + 2000
export const SERVICE_LIFECYCLE_LOCK_TTL_MS = 30000
export const SERVICE_LIFECYCLE_LOCK_TIMEOUT_MS = 5 * 60 * 1000
export const SERVICE_LIFECYCLE_OPERATION_VERSION = 1
export const SERVICE_LIFECYCLE_OPERATION_TTL_MS = SERVICE_LIFECYCLE_LOCK_TTL_MS
export const SERVICE_LIFECYCLE_WAIT_POLL_MS = 100
export const SERVICE_OWNERSHIP_CHECK_INTERVAL_MS = 1000
export const SERVICE_UPGRADE_SOFT_WAIT_MS = 5000
export const SERVICE_UPGRADE_BLOCKED_POLL_MS = 1000
export const SERVICE_UPGRADE_EXIT_GRACE_MS = 15000
export const SERVICE_UPGRADE_EXIT_POLL_MS = 100
export const SERVICE_STOP_SOFT_WAIT_MS = 5000
export const SERVICE_STOP_EXIT_WAIT_MS = 5000
export const SERVICE_STARTUP_TIMEOUT_MS = 15000
export const SERVICE_CONNECTIVITY_TIMEOUT_MS = 1500
export const SERVICE_REQUEST_TIMEOUT_MS = 30000
export const SERVICE_CLIENT_RUNTIME_CHECK_INTERVAL_MS = 1000
export const SERVICE_SAME_RUNTIME_HEALTH_RETRY_MS = 500
export const SERVICE_SAME_RUNTIME_HEALTH_RETRY_POLL_MS = 100
export const FALSE_VALUES = new Set(["0", "false", "no", "off"])

export const ACTIVE_SERVICE_LIFECYCLE_PHASES = new Set(["stopping-old", "starting-new", "verifying-new"])
export const processStartedAtMs = Date.now()

export const here = dirname(fileURLToPath(import.meta.url))
export const packageRoot = join(here, "..", "..", "..", "..", "..")
export const sourceRoot = join(packageRoot, "packages", "server", "src")
export const mainPath = join(packageRoot, "cli", "main.js")
export const INFO_PATH = Symbol("serviceInfoPath")

export function serviceDir() {
	return serviceStateDir()
}

export function serviceInfoPath() {
	return join(serviceDir(), "service.json")
}

export function desiredRuntimeIdentityPath() {
	return join(serviceDir(), "desired-runtime.json")
}

export function desiredRuntimeLockPath() {
	return join(serviceDir(), "desired-runtime.lock")
}

export function serviceLifecycleLockPath() {
	return join(serviceDir(), "service-lifecycle.lock")
}

export function serviceLifecycleOperationPath() {
	return join(serviceDir(), "service-lifecycle.json")
}

export function serviceLogPath() {
	return join(serviceDir(), "service.log")
}

export async function appendServiceLog(event, details = {}) {
	try {
		await mkdir(serviceDir(), { recursive: true })
		await appendFile(serviceLogPath(), `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`)
	} catch {}
}

export async function openOwnedServerDb(options) {
	const { openServerDb } = await import("../database/index.js")
	return openServerDb(options)
}

export function servicePid(info) {
	const pid = Number(info?.pid)
	return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

export function processExists(pid) {
	if (!pid) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (/** @type {any} */ err) {
		return err?.code === "EPERM"
	}
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function serviceIdleShutdownDelayMs(options = {}) {
	if (options.idleShutdown === false) return null
	const envEnabledRaw = process.env.PINANO_SERVICE_IDLE_SHUTDOWN
	if (envEnabledRaw !== undefined && FALSE_VALUES.has(envEnabledRaw.trim().toLowerCase())) return null
	if (Number.isFinite(options.idleShutdownDelayMs)) return Math.max(0, Number(options.idleShutdownDelayMs))
	const envRaw = process.env.PINANO_SERVICE_IDLE_SHUTDOWN_DELAY_MS
	const envValue = envRaw === undefined || envRaw.trim() === "" ? NaN : Number(envRaw)
	return Number.isFinite(envValue) ? Math.max(0, envValue) : DEFAULT_SERVICE_IDLE_SHUTDOWN_DELAY_MS
}

export function serviceIdleShutdownInfo(delayMs) {
	return {
		idleShutdown: delayMs !== null,
		idleShutdownDelayMs: delayMs,
	}
}

export async function waitForProcessExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (!processExists(pid)) return true
		await delay(50)
	}
	return !processExists(pid)
}

export async function terminateProcess(pid) {
	if (!processExists(pid)) return true
	try { process.kill(pid, "SIGTERM") } catch {}
	if (await waitForProcessExit(pid, 2000)) return true
	try { process.kill(pid, "SIGKILL") } catch {}
	return waitForProcessExit(pid, 1000)
}

export function authError(auth) {
	return json({ error: auth.error || "Unauthorized" }, auth.status || 401)
}

/**
 * @param {string} ref
 * @param {import("../settings.js").Settings} current
 */
export async function updateDefaultModel(ref, current) {
	const currentProvider = parseModelRef(current.defaultModel).provider
	return updateSettings({ defaultModel: canonicalModelRef(ref, { provider: currentProvider, providers: current.providers }) })
}

export async function writePrivateJson(path, value) {
	await writeFile(path, JSON.stringify(value, null, "\t"), { mode: 0o600 })
	await chmod(path, 0o600).catch(() => {})
}

export async function writePrivateJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true })
	const tmp = join(dirname(path), `.${process.pid}.${randomUUID()}.tmp`)
	try {
		await writePrivateJson(tmp, value)
		await rename(tmp, path)
		await chmod(path, 0o600).catch(() => {})
	} catch (err) {
		await rm(tmp, { force: true }).catch(() => {})
		throw err
	}
}

export const APP_API_ROUTE_PREFIX = "/api"
export const SERVICE_ROUTE_PREFIX = "/service"

export function stripKnownRoutePrefix(pathname) {
	if (pathname === APP_API_ROUTE_PREFIX || pathname === SERVICE_ROUTE_PREFIX) return "/"
	if (pathname.startsWith(`${APP_API_ROUTE_PREFIX}/`)) return pathname.slice(APP_API_ROUTE_PREFIX.length) || "/"
	if (pathname.startsWith(`${SERVICE_ROUTE_PREFIX}/`)) return pathname.slice(SERVICE_ROUTE_PREFIX.length) || "/"
	return pathname
}

export function incomingRequestUrl(incoming) {
	const path = incoming.url || "/"
	const host = typeof incoming.headers.host === "string" && incoming.headers.host ? incoming.headers.host : "pinano.local"
	const raw = `http://${host}${path}`
	try {
		return new URL(raw).href
	} catch {
		return new URL(path, "http://pinano.local").href
	}
}

export function isAppApiRequestPath(pathname) {
	return pathname === APP_API_ROUTE_PREFIX || pathname.startsWith(`${APP_API_ROUTE_PREFIX}/`)
}

export function isServiceControlRequestPath(pathname) {
	return pathname === SERVICE_ROUTE_PREFIX || pathname.startsWith(`${SERVICE_ROUTE_PREFIX}/`)
}

export function listenServer(server, port, host) {
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

export function configuredPortInUseMessage(host, port) {
	return `Configured Pinano service/web port ${port} on ${host} is already in use; falling back to an ephemeral service port for TUI clients. ${WEB_BROWSER_UI_NAME} will not start until the configured port is available.`
}

export function strictConfiguredPortInUseMessage(host, port) {
	return `Configured Pinano service/web port ${port} on ${host} is already in use. Stop the existing service or change service.web.port in Pinano settings.`
}

export async function listenTcpEndpoint(server, host, requestedPort, options = {}) {
	const port = Number.isInteger(requestedPort) ? Math.max(0, requestedPort) : 0
	try {
		await listenServer(server, port, host)
		return { requestedPort: port, portFallback: false }
	} catch (err) {
		if (port <= 0 || err?.code !== "EADDRINUSE") throw err
		if (options.allowPortFallback === false) {
			const message = strictConfiguredPortInUseMessage(host, port)
			await appendServiceLog("service_configured_port_unavailable", { host, port, error: err?.message ?? String(err), fallback: false })
			throw Object.assign(new Error(message), { code: err.code, cause: err })
		}
		const message = configuredPortInUseMessage(host, port)
		console.error(message)
		await appendServiceLog("service_configured_port_unavailable", { host, port, error: err?.message ?? String(err), fallback: true })
		await listenServer(server, 0, host)
		return { requestedPort: port, portFallback: true }
	}
}

export async function readPackageMetadata() {
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
export function canonicalRuntimeKey(identity) {
	return JSON.stringify({
		packageName: identity?.packageName,
		packageVersion: identity?.packageVersion,
		mainPath: identity?.mainPath,
		packageRoot: identity?.packageRoot,
		execPath: identity?.execPath,
	})
}

export function runtimeKey(identity) {
	return typeof identity?.runtimeKey === "string" && identity.runtimeKey ? identity.runtimeKey : canonicalRuntimeKey(identity)
}

export function runtimeKeyFingerprint(key) {
	return createHash("sha256").update(key).digest("hex")
}

export function serviceRuntimeIdentity(metadata) {
	const identity = { ...metadata, mainPath, sourceRoot, packageRoot, execPath: process.execPath, processStartedAtMs }
	const key = canonicalRuntimeKey(identity)
	return { ...identity, runtimeKey: key, codeFingerprint: runtimeKeyFingerprint(key) }
}

export function runtimePathsMatch(candidate, expected) {
	return candidate?.mainPath === expected?.mainPath
		&& candidate?.sourceRoot === expected?.sourceRoot
		&& candidate?.packageRoot === expected?.packageRoot
		&& candidate?.execPath === expected?.execPath
}

export function runtimeIdentityMatches(candidate, expected) {
	if (!candidate || !expected) return false
	if (candidate.runtimeKey && expected.runtimeKey) {
		return runtimeKey(candidate) === runtimeKey(expected) && runtimePathsMatch(candidate, expected)
	}
	return runtimePathsMatch(candidate, expected)
}

export async function currentRuntimeIdentity() {
	return serviceRuntimeIdentity(await readPackageMetadata())
}

// Capture this process's runtime identity once. Source roots are deployment dirs,
// but the important invariant is still process-local: an already-running TUI must
// not later re-identify itself as another runtime after a newer deployment wins.
export const processRuntimeIdentityPromise = currentRuntimeIdentity()

export async function processRuntimeIdentity() {
	return processRuntimeIdentityPromise
}

export async function readDesiredRuntimeIdentityUnlocked() {
	try {
		return JSON.parse(await readFile(desiredRuntimeIdentityPath(), "utf-8"))
	} catch {
		return null
	}
}

export async function readDesiredRuntimeIdentity() {
	return readDesiredRuntimeIdentityUnlocked()
}

export function desiredRuntimeStatSignature(s) {
	return `${s.dev}:${s.ino}:${s.mtimeMs}:${s.size}`
}

export function createDesiredRuntimeReadCache() {
	let cachedSignature = /** @type {string | undefined} */ (undefined)
	let cachedDesired = /** @type {any} */ (null)
	let inFlight = /** @type {Promise<any> | undefined} */ (undefined)
	return async () => {
		if (inFlight) return inFlight
		inFlight = (async () => {
			let signature
			try {
				signature = desiredRuntimeStatSignature(await stat(desiredRuntimeIdentityPath()))
			} catch (/** @type {any} */ err) {
				if (err?.code !== "ENOENT") return readDesiredRuntimeIdentityUnlocked()
				signature = "missing"
			}
			if (signature === cachedSignature) return cachedDesired
			cachedSignature = signature
			cachedDesired = signature === "missing" ? null : await readDesiredRuntimeIdentityUnlocked()
			return cachedDesired
		})()
		try {
			return await inFlight
		} finally {
			inFlight = undefined
		}
	}
}

// The desired-runtime document is the single source of truth for both current
// ownership and activation history. Keeping history inside the same locked file
// avoids split-brain rules between separate "current" documents.
export function emptyRuntimeState() {
	return { version: 1, currentGeneration: 0, runtimes: {} }
}

export function runtimeStateFromDesired(desired) {
	const state = desired?.runtimeState
	return state && typeof state === "object" && state.runtimes && typeof state.runtimes === "object"
		? { ...emptyRuntimeState(), ...state, runtimes: { ...state.runtimes } }
		: emptyRuntimeState()
}

export function runtimeSummary(identity) {
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

export function parseSemver(version) {
	const match = String(version ?? "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
	return match ? match.slice(1, 4).map(Number) : null
}

export function compareSemver(a, b) {
	const parsedA = parseSemver(a)
	const parsedB = parseSemver(b)
	if (!parsedA || !parsedB) return null
	for (let i = 0; i < 3; i++) {
		if (parsedA[i] > parsedB[i]) return 1
		if (parsedA[i] < parsedB[i]) return -1
	}
	return 0
}

export function lowerPackageVersion(candidate, current) {
	if (!candidate?.packageName || candidate.packageName !== current?.packageName) return false
	const compared = compareSemver(candidate.packageVersion, current.packageVersion)
	return compared !== null && compared < 0
}

export function desiredHasRuntimeState(desired) {
	return Boolean(desired?.runtimeState && typeof desired.runtimeState === "object" && desired.runtimeState.runtimes && typeof desired.runtimeState.runtimes === "object")
}

export function desiredClaimedAfterProcessStarted(desired, identity) {
	const claimedAtMs = Number(desired?.claimedAtMs ?? Date.parse(desired?.writtenAt ?? ""))
	const startedAtMs = Number(identity?.processStartedAtMs ?? processStartedAtMs)
	return Number.isFinite(claimedAtMs) && Number.isFinite(startedAtMs) && claimedAtMs > startedAtMs
}

export function runtimeActivationDecision(identity, desired) {
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

export function runtimeReadOnlyValidationDecision(identity, desired) {
	if (!desired || runtimeIdentityMatches(desired, identity)) return { ok: true }
	const decision = runtimeActivationDecision(identity, desired)
	if (!decision.ok) return decision
	if (lowerPackageVersion(desired, identity)) return { ok: true }
	return { ok: false, reason: "desired_changed", desired }
}

export function runtimeStateForActivation(identity, previousDesired = null) {
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

export async function acquireDirectoryLock(lockPath, { timeoutMs, ttlMs, label }) {
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

export async function acquireDesiredRuntimeLock(timeoutMs = DESIRED_RUNTIME_LOCK_TIMEOUT_MS) {
	return acquireDirectoryLock(desiredRuntimeLockPath(), {
		timeoutMs,
		ttlMs: DESIRED_RUNTIME_LOCK_TTL_MS,
		label: "desired runtime lock",
	})
}

export async function acquireServiceLifecycleLock(timeoutMs = SERVICE_LIFECYCLE_LOCK_TIMEOUT_MS) {
	return acquireDirectoryLock(serviceLifecycleLockPath(), {
		timeoutMs,
		ttlMs: SERVICE_LIFECYCLE_LOCK_TTL_MS,
		label: "service lifecycle lock",
	})
}

export async function withDesiredRuntimeLock(fn) {
	const release = await acquireDesiredRuntimeLock()
	try {
		return await fn()
	} finally {
		await release()
	}
}

export async function withServiceLifecycleLock(fn) {
	const release = await acquireServiceLifecycleLock()
	try {
		return await fn()
	} finally {
		await release()
	}
}

export function nowIso(ms = Date.now()) {
	return new Date(ms).toISOString()
}

export function parseIsoMs(value) {
	const ms = Date.parse(String(value ?? ""))
	return Number.isFinite(ms) ? ms : NaN
}

export function normalizeLifecycleOperation(operation) {
	if (!operation || typeof operation !== "object" || typeof operation.operationId !== "string" || !operation.operationId) return null
	return {
		...operation,
		version: Number(operation.version) || SERVICE_LIFECYCLE_OPERATION_VERSION,
		phase: typeof operation.phase === "string" && operation.phase ? operation.phase : "unknown",
	}
}

export async function readLifecycleOperationUnlocked() {
	try {
		return normalizeLifecycleOperation(JSON.parse(await readFile(serviceLifecycleOperationPath(), "utf-8")))
	} catch {
		return null
	}
}

export async function writeLifecycleOperationUnlocked(operation) {
	await writePrivateJsonAtomic(serviceLifecycleOperationPath(), {
		...operation,
		version: SERVICE_LIFECYCLE_OPERATION_VERSION,
	})
}

export async function clearLifecycleOperationUnlocked(operationId) {
	const current = await readLifecycleOperationUnlocked()
	if (operationId && current?.operationId !== operationId) return false
	await rm(serviceLifecycleOperationPath(), { force: true }).catch(() => {})
	return true
}

export function lifecycleOperationIsActive(operation) {
	return ACTIVE_SERVICE_LIFECYCLE_PHASES.has(operation?.phase)
}

export function lifecycleOperationIsBlocked(operation) {
	return operation?.phase === "awaiting-hard-interrupt-confirmation"
}

export function lifecycleOperationIsFailed(operation) {
	return operation?.phase === "failed"
}

export function lifecycleOperationHeartbeatMs(operation) {
	return parseIsoMs(operation?.heartbeatAt ?? operation?.startedAt)
}

export function lifecycleOperationOwnerDead(operation) {
	const ownerPid = Number(operation?.ownerPid)
	return Number.isInteger(ownerPid) && ownerPid > 0 && !processExists(ownerPid)
}

export function lifecycleOperationIsStale(operation, nowMs = Date.now()) {
	if (!lifecycleOperationIsActive(operation)) return false
	const heartbeatMs = lifecycleOperationHeartbeatMs(operation)
	return !Number.isFinite(heartbeatMs)
		|| nowMs - heartbeatMs > SERVICE_LIFECYCLE_OPERATION_TTL_MS
		|| lifecycleOperationOwnerDead(operation)
}

export function lifecycleOperationState(operation, nowMs = Date.now()) {
	if (!operation) return "idle"
	if (lifecycleOperationIsActive(operation)) return lifecycleOperationIsStale(operation, nowMs) ? "stale" : "active"
	if (lifecycleOperationIsBlocked(operation)) return "blocked"
	if (lifecycleOperationIsFailed(operation)) return "failed"
	return "inactive"
}

export async function readDirectoryLockStatus(lockPath, ttlMs) {
	try {
		const ownerPath = join(lockPath, "owner.json")
		const heartbeatPath = join(lockPath, "heartbeat")
		const owner = JSON.parse(await readFile(ownerPath, "utf-8"))
		const heartbeatStat = await stat(heartbeatPath).catch(() => stat(ownerPath))
		const heartbeatText = await readFile(heartbeatPath, "utf-8").catch(() => "")
		const heartbeatAt = heartbeatText.trim() || nowIso(heartbeatStat.mtimeMs)
		return {
			path: lockPath,
			owner,
			heartbeatAt,
			stale: Date.now() - heartbeatStat.mtimeMs > ttlMs,
		}
	} catch {
		return null
	}
}

export function serviceInfoMatches(current, expected) {
	if (!current && !expected) return true
	if (!current || !expected) return false
	const currentRunId = current.serviceRunId
	const expectedRunId = expected.serviceRunId
	if (currentRunId || expectedRunId) return currentRunId === expectedRunId
	return servicePid(current) === servicePid(expected)
		&& current.transport === expected.transport
		&& current.host === expected.host
		&& current.port === expected.port
}

export function lifecycleOwnerFields() {
	return {
		ownerPid: process.pid,
		ownerStartedAtMs: processStartedAtMs,
	}
}

export function lifecycleOperationBase({ phase, runtimeIdentity, oldService, newServiceRunId = null, message, supersedesOperationId = null }) {
	const at = Date.now()
	return {
		version: SERVICE_LIFECYCLE_OPERATION_VERSION,
		operationId: randomUUID(),
		phase,
		...lifecycleOwnerFields(),
		startedAt: nowIso(at),
		heartbeatAt: nowIso(at),
		desiredRuntimeKey: runtimeKey(runtimeIdentity),
		desiredCodeFingerprint: runtimeIdentity.codeFingerprint,
		oldServiceRunId: oldService?.serviceRunId ?? null,
		oldPid: servicePid(oldService) ?? null,
		oldTransport: oldService?.transport ?? null,
		oldHost: oldService?.host ?? null,
		oldPort: oldService?.port ?? null,
		newServiceRunId,
		message,
		supersedesOperationId,
	}
}

export async function updateLifecycleOperation(operationId, update) {
	return withServiceLifecycleLock(async () => {
		const current = await readLifecycleOperationUnlocked()
		if (current?.operationId !== operationId) return null
		const next = typeof update === "function" ? update(current) : { ...current, ...update }
		if (!next) return null
		await writeLifecycleOperationUnlocked(next)
		return next
	})
}

export function startLifecycleOperationHeartbeat(operationId) {
	let stopped = false
	const heartbeat = () => {
		if (stopped) return
		updateLifecycleOperation(operationId, (operation) => {
			if (!lifecycleOperationIsActive(operation)) return operation
			return {
				...operation,
				...lifecycleOwnerFields(),
				heartbeatAt: nowIso(),
			}
		}).catch(() => {})
	}
	const timer = setInterval(heartbeat, Math.max(1000, Math.floor(SERVICE_LIFECYCLE_OPERATION_TTL_MS / 3)))
	timer.unref?.()
	heartbeat()
	return {
		stop() {
			stopped = true
			clearInterval(timer)
		},
	}
}

export async function beginLifecycleOperation({ runtimeIdentity, observedInfo, phase, newServiceRunId = null, message }) {
	return withServiceLifecycleLock(async () => {
		const currentOperation = await readLifecycleOperationUnlocked()
		if (lifecycleOperationIsActive(currentOperation) && !lifecycleOperationIsStale(currentOperation)) {
			return { action: "wait", operation: currentOperation }
		}
		const currentInfo = await readInfo()
		if (!serviceInfoMatches(currentInfo, observedInfo)) return { action: "retry", currentInfo }
		const operation = lifecycleOperationBase({
			phase,
			runtimeIdentity,
			oldService: observedInfo,
			newServiceRunId,
			message,
			supersedesOperationId: currentOperation?.operationId ?? null,
		})
		await writeLifecycleOperationUnlocked(operation)
		return { action: "started", operation }
	})
}

export async function claimLifecycleOperationPhase(operationId, { phase, expectedInfo, message, newServiceRunId = undefined }) {
	return withServiceLifecycleLock(async () => {
		const operation = await readLifecycleOperationUnlocked()
		if (operation?.operationId !== operationId) return { action: "lost", operation }
		const currentInfo = await readInfo()
		if (!serviceInfoMatches(currentInfo, expectedInfo)) return { action: "world-changed", currentInfo, operation }
		const next = {
			...operation,
			phase,
			...lifecycleOwnerFields(),
			heartbeatAt: lifecycleOperationIsActive({ phase }) ? nowIso() : operation.heartbeatAt,
			...(newServiceRunId !== undefined ? { newServiceRunId } : {}),
			...(message ? { message } : {}),
		}
		await writeLifecycleOperationUnlocked(next)
		return { action: "claimed", operation: next, currentInfo }
	})
}

export async function failLifecycleOperation(operationId, err) {
	await updateLifecycleOperation(operationId, (operation) => ({
		...operation,
		phase: "failed",
		message: err?.message ?? String(err),
		failedAt: nowIso(),
		heartbeatAt: operation.heartbeatAt,
	}))
}

export async function clearLifecycleOperation(operationId) {
	return withServiceLifecycleLock(() => clearLifecycleOperationUnlocked(operationId))
}

export async function writeDesiredRuntimeIdentityUnlocked(identity, claim = {}, previousDesired = null) {
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
	const desired = {
		...claimedIdentity,
		runtimeState: runtimeStateForActivation(claimedIdentity, previousDesired),
	}
	await writePrivateJsonAtomic(desiredRuntimeIdentityPath(), desired)
}

export function staleRuntimeError(desired, reason = "mismatch") {
	return Object.assign(new Error(`This pinano client is stale (${reason}); desired runtime is ${desired?.mainPath || desired?.packageRoot || "unknown"}. Restart pinano.`), {
		code: "PINANO_STALE_RUNTIME",
		reason,
		desiredRuntime: desired,
	})
}

export async function claimCurrentRuntimeIdentity() {
	const identity = await processRuntimeIdentity()
	const claimed = await withDesiredRuntimeLock(async () => {
		const desired = await readDesiredRuntimeIdentityUnlocked()
		if (runtimeIdentityMatches(desired, identity) && desiredHasRuntimeState(desired) && desired.claimId) return { ...identity, claimId: desired.claimId }
		const decision = runtimeActivationDecision(identity, desired)
		if (!decision.ok) throw staleRuntimeError(decision.desired ?? desired, decision.reason)
		const claimId = randomUUID()
		await writeDesiredRuntimeIdentityUnlocked(identity, { claimId }, desired)
		return { ...identity, claimId }
	})
	clearStaleRuntimeReexecDepth()
	return claimed
}

export async function ensureCurrentRuntimeIsDesired(identity, expectedClaimId) {
	await withDesiredRuntimeLock(async () => {
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
	clearStaleRuntimeReexecDepth()
}

export async function verifyCurrentRuntimeDesiredReadOnly(identity, readDesired = readDesiredRuntimeIdentityUnlocked) {
	const desired = await readDesired()
	const decision = runtimeReadOnlyValidationDecision(identity, desired)
	if (!decision.ok) throw staleRuntimeError(decision.desired ?? desired, decision.reason)
	clearStaleRuntimeReexecDepth()
}

export function serviceStartupLifecycleCurrent(operation, operationId, serviceRunId) {
	return operation?.operationId === operationId
		&& operation.newServiceRunId === serviceRunId
		&& (operation.phase === "starting-new" || operation.phase === "verifying-new")
}

export function serviceStartupLifecycleSupersededDetails(operationId, serviceRunId, operation) {
	return {
		pid: process.pid,
		serviceRunId,
		operationId,
		ownerOperationId: operation?.operationId,
		ownerServiceRunId: operation?.newServiceRunId,
		ownerPhase: operation?.phase,
	}
}

export async function assertServiceStartupLifecycleCurrent(operationId, serviceRunId) {
	if (!operationId) return
	let supersededDetails = null
	await withServiceLifecycleLock(async () => {
		const operation = await readLifecycleOperationUnlocked()
		if (!serviceStartupLifecycleCurrent(operation, operationId, serviceRunId)) {
			supersededDetails = serviceStartupLifecycleSupersededDetails(operationId, serviceRunId, operation)
		}
	})
	if (!supersededDetails) return
	await appendServiceLog("service_startup_lifecycle_superseded", supersededDetails)
	throw lifecycleSupersededError("Service startup lifecycle operation was superseded")
}

export function normalizeServiceInfo(info, path) {
	if (!info || typeof info !== "object") return null
	const normalized = { ...info }
	Object.defineProperty(normalized, INFO_PATH, { value: path, enumerable: false })
	return normalized
}

export async function readInfo() {
	const path = serviceInfoPath()
	try {
		return normalizeServiceInfo(JSON.parse(await readFile(path, "utf-8")), path)
	} catch {
		return null
	}
}
