// Client-side service lifecycle and HTTP/WebSocket access.
//
// This module starts, replaces, stops, and talks to the background Pinano service.

import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { mkdir, readFile, rm } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { join, resolve } from "node:path"

import { runtimeSourceReferencePath } from "../paths.js"
import { configuredServiceEndpointDefaults } from "../service-config.js"
import { withoutReexecSupervisorEnv } from "../reexec-runtime.js"
import { bestEffortAutoInstallBundledBubblewrap } from "../bundled-bwrap.js"
import { pathIsWithin } from "../sandbox-paths.js"
import { createWebSocketClient } from "../websocket-client.js"
import { WEB_BROWSER_UI_NAME } from "../../../../protocol/src/web-branding.js"
import { LiveResourceClient } from "../../../../protocol/src/live-resource-client.js"
import { isServiceTimeoutError, requestBytes, requestJson, serviceWebSocketUrl } from "./transport.js"
import {
	SERVICE_PROTOCOL_VERSION,
	SERVICE_LIFECYCLE_LOCK_TTL_MS,
	SERVICE_LIFECYCLE_LOCK_TIMEOUT_MS,
	SERVICE_LIFECYCLE_WAIT_POLL_MS,
	SERVICE_UPGRADE_SOFT_WAIT_MS,
	SERVICE_UPGRADE_BLOCKED_POLL_MS,
	SERVICE_UPGRADE_EXIT_GRACE_MS,
	SERVICE_UPGRADE_EXIT_POLL_MS,
	SERVICE_STOP_SOFT_WAIT_MS,
	SERVICE_STOP_EXIT_WAIT_MS,
	SERVICE_STARTUP_TIMEOUT_MS,
	SERVICE_CONNECTIVITY_TIMEOUT_MS,
	SERVICE_REQUEST_TIMEOUT_MS,
	SERVICE_CLIENT_RUNTIME_CHECK_INTERVAL_MS,
	SERVICE_SAME_RUNTIME_HEALTH_RETRY_MS,
	SERVICE_SAME_RUNTIME_HEALTH_RETRY_POLL_MS,
	mainPath,
	INFO_PATH,
	serviceDir,
	serviceInfoPath,
	desiredRuntimeIdentityPath,
	serviceLifecycleLockPath,
	serviceLifecycleOperationPath,
	serviceLogPath,
	appendServiceLog,
	servicePid,
	processExists,
	delay,
	waitForProcessExit,
	terminateProcess,
	APP_API_ROUTE_PREFIX,
	SERVICE_ROUTE_PREFIX,
	runtimeIdentityMatches,
	processRuntimeIdentity,
	readDesiredRuntimeIdentity,
	createDesiredRuntimeReadCache,
	withServiceLifecycleLock,
	readLifecycleOperationUnlocked,
	clearLifecycleOperationUnlocked,
	lifecycleOperationIsActive,
	lifecycleOperationIsStale,
	lifecycleOperationState,
	readDirectoryLockStatus,
	serviceInfoMatches,
	startLifecycleOperationHeartbeat,
	beginLifecycleOperation,
	claimLifecycleOperationPhase,
	failLifecycleOperation,
	clearLifecycleOperation,
	claimCurrentRuntimeIdentity,
	ensureCurrentRuntimeIsDesired,
	verifyCurrentRuntimeDesiredReadOnly,
	normalizeServiceInfo,
	readInfo,
} from "./lifecycle.js"

async function ping(info, expectedIdentity, timeoutMs = SERVICE_CONNECTIVITY_TIMEOUT_MS) {
	return Boolean(await serviceHealth(info, expectedIdentity, timeoutMs))
}

async function serviceHealth(info, expectedIdentity, timeoutMs = SERVICE_CONNECTIVITY_TIMEOUT_MS) {
	if (!info || info.protocolVersion !== SERVICE_PROTOCOL_VERSION) return false
	if (expectedIdentity && !runtimeIdentityMatches(info, expectedIdentity)) return false
	try {
		const res = await requestJson(info, `${SERVICE_ROUTE_PREFIX}/health`, { timeoutMs })
		if (res.ok !== true || res.protocolVersion !== SERVICE_PROTOCOL_VERSION) return null
		if (expectedIdentity && !runtimeIdentityMatches(res, expectedIdentity)) return null
		return res
	} catch {
		return null
	}
}

async function waitForSameRuntimeServiceHealth(info, runtimeIdentity, timeoutMs = SERVICE_SAME_RUNTIME_HEALTH_RETRY_MS) {
	if (!info || info.transport !== "tcp" || !runtimeIdentityMatches(info, runtimeIdentity)) return null
	if (!processExists(servicePid(info))) return null
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const current = await readInfo()
		if (!serviceInfoMatches(current, info)) return null
		const remainingMs = Math.max(1, deadline - Date.now())
		if (await ping(current, runtimeIdentity, Math.min(remainingMs, 250))) return current
		await delay(Math.min(SERVICE_SAME_RUNTIME_HEALTH_RETRY_POLL_MS, Math.max(1, deadline - Date.now())))
	}
	return null
}

async function waitForLifecycleOperation(operation, runtimeIdentity) {
	const deadline = Date.now() + SERVICE_LIFECYCLE_LOCK_TIMEOUT_MS
	while (Date.now() < deadline) {
		const info = await readInfo()
		if (info?.transport === "tcp" && await ping(info, runtimeIdentity, 250)) return info
		const current = await readLifecycleOperationUnlocked()
		if (!current || current.operationId !== operation.operationId || !lifecycleOperationIsActive(current) || lifecycleOperationIsStale(current)) return null
		await delay(SERVICE_LIFECYCLE_WAIT_POLL_MS)
	}
	throw new Error(`Timed out waiting for service lifecycle operation ${operation.operationId} (${operation.phase})`)
}

function serviceStartWebMode(options) {
	if (options.startWeb === true) return "required"
	if (options.startWeb === "best-effort") return "best-effort"
	return "off"
}

function serviceLaunchOptionsSatisfied(info, options, health = null) {
	if (options.idleShutdown === false && info?.idleShutdown !== false) return false
	if (serviceStartWebMode(options) !== "off" && health?.web?.running !== true) return false
	return true
}

async function applyIdleShutdownLaunchOption(info, options) {
	if (options.idleShutdown !== false || info?.idleShutdown === false) return info
	try {
		const updated = await requestJson(info, `${SERVICE_ROUTE_PREFIX}/idle-shutdown`, {
			method: "POST",
			body: JSON.stringify({ enabled: false }),
			timeoutMs: SERVICE_CONNECTIVITY_TIMEOUT_MS,
		})
		if (updated?.ok === true && updated.idleShutdown === false) {
			return normalizeServiceInfo({
				...info,
				idleShutdown: false,
				idleShutdownDelayMs: null,
			}, info?.[INFO_PATH])
		}
		await appendServiceLog("service_launch_options_update_rejected", { serviceRunId: info?.serviceRunId, requestedIdleShutdown: options.idleShutdown, response: updated })
	} catch (err) {
		await appendServiceLog("service_launch_options_update_failed", { serviceRunId: info?.serviceRunId, requestedIdleShutdown: options.idleShutdown, error: err?.message ?? String(err) })
	}
	return null
}

async function ensureServiceWebStarted(info, options, health = null) {
	const startWebMode = serviceStartWebMode(options)
	if (startWebMode === "off") return true
	try {
		const status = health?.web
			? { ok: true, web: health.web }
			: await requestJson(info, `${SERVICE_ROUTE_PREFIX}/web/status`, { timeoutMs: SERVICE_CONNECTIVITY_TIMEOUT_MS })
		if (status?.web?.running === true) return true
		const started = await requestJson(info, `${SERVICE_ROUTE_PREFIX}/web/start`, {
			method: "POST",
			body: "{}",
			timeoutMs: SERVICE_REQUEST_TIMEOUT_MS,
		})
		if (started?.web?.running === true) return true
		throw new Error(`${WEB_BROWSER_UI_NAME} did not report running after start`)
	} catch (err) {
		await appendServiceLog("service_web_start_failed", {
			serviceRunId: info?.serviceRunId,
			mode: startWebMode,
			error: err?.message ?? String(err),
			status: err?.status,
		})
		if (startWebMode === "best-effort") return false
		throw err
	}
}

async function applyServiceLaunchOptions(info, options, health = null) {
	if (serviceLaunchOptionsSatisfied(info, options, health)) return info
	const withIdleOptions = await applyIdleShutdownLaunchOption(info, options)
	if (!withIdleOptions) return null
	await ensureServiceWebStarted(withIdleOptions, options, health)
	return withIdleOptions
}

async function interruptOldService(info, mode = "soft", waitMs = 0) {
	try {
		return await requestJson(info, `${SERVICE_ROUTE_PREFIX}/interrupt`, { method: "POST", body: JSON.stringify({ mode, waitMs }), timeoutMs: waitMs + SERVICE_CONNECTIVITY_TIMEOUT_MS })
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
	if (process.env.PINANO_SERVICE_HARD_INTERRUPT === "1") return { action: "hard" }
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

function serviceHardInterruptForced() {
	return process.env.PINANO_SERVICE_HARD_INTERRUPT === "1"
}

async function hardInterruptDecisionForTarget(target, prompt) {
	if (serviceHardInterruptForced()) return "hard"
	if (await oldServiceStopped(target)) return "stopped"
	if (!process.stdin.isTTY || !process.stderr.isTTY) return "busy"

	const rl = createInterface({ input: process.stdin, output: process.stderr })
	let finished = false
	return await new Promise((resolve) => {
		const finish = (decision) => {
			if (finished) return
			finished = true
			clearInterval(pollTimer)
			rl.close()
			resolve(decision)
		}
		const pollTimer = setInterval(() => {
			oldServiceStopped(target)
				.then((stopped) => {
					if (stopped) finish("stopped")
				})
				.catch(() => {})
		}, SERVICE_UPGRADE_EXIT_POLL_MS)
		pollTimer.unref?.()
		rl.question(prompt)
			.then((answer) => finish(/^y(es)?$/i.test(answer.trim()) ? "hard" : "busy"))
			.catch(() => finish("busy"))
	})
}

async function removeStaleServiceInfo(expected = null) {
	const path = serviceInfoPath()
	if (expected) {
		try {
			const info = normalizeServiceInfo(JSON.parse(await readFile(path, "utf-8")), path)
			if (info?.serviceRunId && info.serviceRunId !== expected.serviceRunId) return
		} catch (/** @type {any} */ err) {
			if (err?.code === "ENOENT") return
		}
	}
	await rm(path, { force: true }).catch(() => {})
}

async function oldServiceStopped(existing) {
	const pid = servicePid(existing)
	if (pid && !processExists(pid)) return true
	const current = await readInfo()
	return !current || current.serviceRunId !== existing.serviceRunId
}

async function waitForOldServiceStopped(existing, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		if (await oldServiceStopped(existing)) return true
		if (Date.now() >= deadline) return false
		await delay(SERVICE_UPGRADE_EXIT_POLL_MS)
	}
}

function lifecycleSupersededError(message = "Service lifecycle operation was superseded") {
	return Object.assign(new Error(message), { code: "PINANO_SERVICE_LIFECYCLE_SUPERSEDED" })
}

function lifecycleBlockedError(message) {
	return Object.assign(new Error(message), { code: "PINANO_SERVICE_LIFECYCLE_BLOCKED" })
}

function isLifecycleSupersededError(err) {
	return /** @type {any} */ (err)?.code === "PINANO_SERVICE_LIFECYCLE_SUPERSEDED"
}

function isLifecycleBlockedError(err) {
	return /** @type {any} */ (err)?.code === "PINANO_SERVICE_LIFECYCLE_BLOCKED"
}

function createLifecycleLeaseControl(operationId) {
	let lease = startLifecycleOperationHeartbeat(operationId)
	return {
		stop() {
			lease?.stop()
			lease = null
		},
		restart() {
			lease?.stop()
			lease = startLifecycleOperationHeartbeat(operationId)
		},
	}
}

async function runBlockedLifecycleDecision(operation, target, leaseControl, message, decide) {
	if (serviceHardInterruptForced()) return { action: "decision", decision: await decide() }
	leaseControl.stop()
	const blocked = await claimLifecycleOperationPhase(operation.operationId, {
		phase: "awaiting-hard-interrupt-confirmation",
		expectedInfo: target,
		message,
	})
	if (blocked.action === "world-changed") return { action: "world-changed", decision: null }
	if (blocked.action !== "claimed") throw lifecycleSupersededError()

	const decision = await decide()
	const declined = decision === false || decision === "busy" || decision?.action === "busy"
	if (declined) {
		if (await oldServiceStopped(target)) return { action: "world-changed", decision }
		return { action: "blocked", decision }
	}

	const resumed = await claimLifecycleOperationPhase(operation.operationId, {
		phase: "stopping-old",
		expectedInfo: target,
		message: "Resuming service replacement",
	})
	if (resumed.action === "world-changed") return { action: "world-changed", decision }
	if (resumed.action !== "claimed") throw lifecycleSupersededError()
	leaseControl.restart()
	return { action: "decision", decision }
}

async function claimHardInterrupt(operation, target, leaseControl, message, prompt) {
	const result = await runBlockedLifecycleDecision(operation, target, leaseControl, message, () => hardInterruptDecisionForTarget(target, prompt))
	if (result.action === "world-changed") return "world-changed"
	if (result.action === "blocked") throw lifecycleBlockedError(`${message}. Run again after it exits, or set PINANO_SERVICE_HARD_INTERRUPT=1 to force replacement.`)
	if (result.decision === "stopped") return "world-changed"
	return result.decision === true || result.decision === "hard" ? "hard" : "busy"
}

async function hardInterruptOldServiceForOperation(operation, target) {
	const pid = servicePid(target)
	const claimed = await claimLifecycleOperationPhase(operation.operationId, {
		phase: "stopping-old",
		expectedInfo: target,
		message: "Hard-interrupting old service",
	})
	if (claimed.action === "world-changed") return true
	if (claimed.action !== "claimed") throw lifecycleSupersededError()
	await interruptOldService(target, "hard", 0)
	if (!pid || await waitForProcessExit(pid, 3000) || await oldServiceStopped(target)) return true
	if (!await terminateProcess(pid)) throw new Error(`Existing pinano service pid ${pid} did not exit after hard interrupt`)
	return true
}

async function promptAndMaybeHardInterrupt(operation, target, leaseControl, message, prompt) {
	const decision = await claimHardInterrupt(operation, target, leaseControl, message, prompt)
	if (decision === "world-changed") return true
	if (decision !== "hard") return false
	console.error("Hard-interrupting old service...")
	return hardInterruptOldServiceForOperation(operation, target)
}

async function ensureOldServiceStoppedForOperation(operation, target, interrupted, leaseControl) {
	const pid = servicePid(target)
	if (!pid || await oldServiceStopped(target)) return true
	if (interrupted?.ok && interrupted.exiting) {
		if (await waitForOldServiceStopped(target, 3000)) return true
		await appendServiceLog("service_interrupt_timeout", { pid, serviceRunId: target.serviceRunId, transport: target.transport, host: target.host, port: target.port })
		return promptAndMaybeHardInterrupt(
			operation,
			target,
			leaseControl,
			`Waiting for pinano service pid ${pid} to exit after interrupt`,
			`Pinano service pid ${pid} did not exit after interrupt. Kill it and replace it? [y/N] `,
		)
	}
	await appendServiceLog("service_unreachable", { pid, serviceRunId: target.serviceRunId, transport: target.transport, host: target.host, port: target.port, error: interrupted?.error, status: interrupted?.status })
	if (await waitForOldServiceStopped(target, SERVICE_UPGRADE_EXIT_GRACE_MS)) return true
	return promptAndMaybeHardInterrupt(
		operation,
		target,
		leaseControl,
		`Existing service pid ${pid} is unreachable; waiting for hard-interrupt decision`,
		`Pinano service pid ${pid} is alive but unreachable. Kill it and replace it? [y/N] `,
	)
}

async function stopOldServiceForOperation(operation, target, leaseControl, runtimeIdentity) {
	const codeFingerprint = runtimeIdentity.codeFingerprint
	const pid = servicePid(target)
	const pidAlive = processExists(pid)
	await appendServiceLog("service_replacement_requested", { pid, pidAlive, serviceRunId: target.serviceRunId, transport: target.transport, host: target.host, port: target.port, storedCodeFingerprint: target.codeFingerprint, codeFingerprint, storedRuntimeKey: target.runtimeKey, runtimeKey: runtimeIdentity.runtimeKey, storedMainPath: target.mainPath, mainPath, storedExecPath: target.execPath, execPath: process.execPath })
	if (!pidAlive && await oldServiceStopped(target)) return true
	const interrupted = await interruptOldService(target, "soft", SERVICE_UPGRADE_SOFT_WAIT_MS)
	if (interrupted?.waiting?.length) {
		const upgradeWaitStartedAt = Date.now()
		const result = await runBlockedLifecycleDecision(
			operation,
			target,
			leaseControl,
			"Existing service has running sessions; waiting for hard-interrupt decision",
			() => waitForUpgradeBlockageDecision(target, interrupted.waiting, upgradeWaitStartedAt),
		)
		if (result.action === "world-changed") return true
		if (result.action === "blocked") {
			console.error("Run again after they finish, or set PINANO_SERVICE_HARD_INTERRUPT=1 to replace the service.")
			throw lifecycleBlockedError("Existing pinano service is busy")
		}
		const decision = result.decision
		if (decision.action === "cleared") {
			console.error("Running sessions finished; continuing service replacement...")
			if (!await ensureOldServiceStoppedForOperation(operation, target, decision.interrupted, leaseControl)) {
				throw new Error(`Existing pinano service pid ${pid} did not exit after running sessions finished`)
			}
			return true
		}
		if (decision.action === "hard") return hardInterruptOldServiceForOperation(operation, target)
		if (decision.action === "error") return ensureOldServiceStoppedForOperation(operation, target, decision.interrupted, leaseControl)
		throw lifecycleBlockedError("Existing pinano service is busy")
	}
	if (!await ensureOldServiceStoppedForOperation(operation, target, interrupted, leaseControl)) {
		throw new Error(`Existing pinano service pid ${pid} is alive but unreachable (${interrupted?.error || "ping failed"}). Stop it, or set PINANO_SERVICE_HARD_INTERRUPT=1 to force replacement.`)
	}
	return true
}

async function removeStaleServiceInfoForOperation(operation, target) {
	return withServiceLifecycleLock(async () => {
		const currentOperation = await readLifecycleOperationUnlocked()
		if (currentOperation?.operationId !== operation.operationId) return { action: "lost" }
		const currentInfo = await readInfo()
		if (currentInfo && !serviceInfoMatches(currentInfo, target)) return { action: "world-changed", currentInfo }
		await removeStaleServiceInfo(target)
		return { action: "removed" }
	})
}

async function completeLifecycleOperation(operationId, info) {
	return withServiceLifecycleLock(async () => {
		const operation = await readLifecycleOperationUnlocked()
		if (operation?.operationId !== operationId) return false
		const currentInfo = await readInfo()
		if (!serviceInfoMatches(currentInfo, info)) return false
		await clearLifecycleOperationUnlocked(operationId)
		return true
	})
}

async function clearLifecycleOperationForHealthyService(info) {
	return withServiceLifecycleLock(async () => {
		const operation = await readLifecycleOperationUnlocked()
		if (!operation) return false
		if (operation.newServiceRunId === info.serviceRunId || lifecycleOperationIsStale(operation) || !lifecycleOperationIsActive(operation)) {
			await clearLifecycleOperationUnlocked(operation.operationId)
			return true
		}
		return false
	})
}

async function startServiceForOperation(operation, options, runtimeIdentity) {
	const endpoint = configuredServiceEndpointDefaults()
	const logPath = serviceLogPath()
	const serviceRunId = operation.newServiceRunId || randomUUID()
	const claimed = await claimLifecycleOperationPhase(operation.operationId, {
		phase: "starting-new",
		expectedInfo: null,
		newServiceRunId: serviceRunId,
		message: "Starting pinano service",
	})
	if (claimed.action === "world-changed") {
		await clearLifecycleOperation(operation.operationId)
		return null
	}
	if (claimed.action !== "claimed") throw lifecycleSupersededError()

	await ensureCurrentRuntimeIsDesired(runtimeIdentity, options.serviceClaimId)
	await mkdir(serviceDir(), { recursive: true })
	const logFd = openSync(logPath, "a")
	const argv = [mainPath, "service", "run", "--service-host", endpoint.host, "--service-port", String(endpoint.port), "--service-run-id", serviceRunId, "--service-lifecycle-operation-id", operation.operationId]
	if (options.serviceClaimId) argv.push("--service-claim-id", options.serviceClaimId)
	if (options.noContextFiles) argv.push("--no-context-files")
	const baseChildEnv = withoutReexecSupervisorEnv(process.env)
	const childEnv = {
		...baseChildEnv,
		...(options.idleShutdown === false ? { PINANO_SERVICE_IDLE_SHUTDOWN: "0" } : {}),
		...(Number.isFinite(options.idleShutdownDelayMs) ? { PINANO_SERVICE_IDLE_SHUTDOWN_DELAY_MS: String(Math.max(0, Number(options.idleShutdownDelayMs))) } : {}),
	}
	const child = spawn(process.execPath, argv, {
		cwd: options.cwd,
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: childEnv,
	})
	let childStartupFailure = ""
	let verifying = false
	const onChildStartupError = (err) => {
		childStartupFailure = `spawn failed: ${err.message}`
		appendServiceLog("service_spawn_error", { serviceRunId, operationId: operation.operationId, error: err.message }).catch(() => {})
	}
	const onChildStartupExit = (code, signal) => {
		childStartupFailure = `process exited before startup${signal ? ` from ${signal}` : ` with code ${code ?? 0}`}`
		appendServiceLog("service_spawned_child_exit", { serviceRunId, operationId: operation.operationId, code, signal }).catch(() => {})
	}
	child.once("error", onChildStartupError)
	child.once("exit", onChildStartupExit)
	child.unref?.()
	closeSync(logFd)

	const deadline = Date.now() + (options.startupTimeoutMs ?? SERVICE_STARTUP_TIMEOUT_MS)
	while (Date.now() < deadline) {
		const info = await readInfo()
		const remainingMs = Math.max(1, deadline - Date.now())
		if (info?.serviceRunId === serviceRunId && info.transport === "tcp") {
			if (!verifying) {
				const verifiedClaim = await claimLifecycleOperationPhase(operation.operationId, {
					phase: "verifying-new",
					expectedInfo: info,
					newServiceRunId: serviceRunId,
					message: "Verifying new service",
				})
				if (verifiedClaim.action === "world-changed") {
					await clearLifecycleOperation(operation.operationId)
					return null
				}
				if (verifiedClaim.action !== "claimed") throw lifecycleSupersededError()
				verifying = true
			}
			if (await ping(info, runtimeIdentity, Math.min(SERVICE_CONNECTIVITY_TIMEOUT_MS, remainingMs))) {
				child.off("error", onChildStartupError)
				child.off("exit", onChildStartupExit)
				if (!await completeLifecycleOperation(operation.operationId, info)) {
					await clearLifecycleOperation(operation.operationId)
					throw lifecycleSupersededError()
				}
				return info
			}
		}
		if (childStartupFailure) throw new Error(`Pinano service ${childStartupFailure}. See ${logPath}`)
		await delay(100)
	}
	if (child.pid) await terminateProcess(child.pid)
	throw new Error(`Timed out starting pinano service. See ${logPath}`)
}

async function performLifecycleOperation(operation, target, options, runtimeIdentity) {
	const leaseControl = createLifecycleLeaseControl(operation.operationId)
	try {
		if (target) {
			await stopOldServiceForOperation(operation, target, leaseControl, runtimeIdentity)
			const removed = await removeStaleServiceInfoForOperation(operation, target)
			if (removed.action === "lost") throw lifecycleSupersededError()
			if (removed.action === "world-changed") {
				await clearLifecycleOperation(operation.operationId)
				return null
			}
		}
		return startServiceForOperation(operation, options, runtimeIdentity)
	} catch (err) {
		if (!isLifecycleSupersededError(err) && !isLifecycleBlockedError(err)) await failLifecycleOperation(operation.operationId, err)
		throw err
	} finally {
		leaseControl.stop()
	}
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {boolean} [options.noContextFiles]
 * @param {string} [options.serviceClaimId]
 * @param {number} [options.startupTimeoutMs]
 * @param {boolean} [options.idleShutdown]
 * @param {number} [options.idleShutdownDelayMs]
 * @param {boolean | "best-effort"} [options.startWeb]
 */
export async function ensureService(options) {
	await bestEffortAutoInstallBundledBubblewrap()
	const runtimeIdentity = await processRuntimeIdentity()
	for (;;) {
		await ensureCurrentRuntimeIsDesired(runtimeIdentity, options.serviceClaimId)
		let existing = await readInfo()
		if (existing && existing.transport !== "tcp") {
			const pid = servicePid(existing)
			const pidAlive = processExists(pid)
			await appendServiceLog("service_unsupported_transport", { pid, pidAlive, serviceRunId: existing.serviceRunId, transport: existing.transport })
			if (pidAlive) throw new Error(`Existing Pinano service uses unsupported ${existing.transport || "unknown"} transport at pid ${pid}. Stop it before starting this version.`)
		} else if (existing) {
			const health = await serviceHealth(existing, runtimeIdentity)
			if (health) {
				const configured = await applyServiceLaunchOptions(existing, options, health)
				if (configured) {
					await clearLifecycleOperationForHealthyService(configured)
					return configured
				}
			}
		}
		if (existing) {
			const recovered = await waitForSameRuntimeServiceHealth(existing, runtimeIdentity)
			if (recovered) {
				const configured = await applyServiceLaunchOptions(recovered, options, await serviceHealth(recovered, runtimeIdentity))
				if (configured) {
					await clearLifecycleOperationForHealthyService(configured)
					return configured
				}
				existing = recovered
			}
		}
		const operationStartedWithInfo = existing
		const begin = await beginLifecycleOperation({
			runtimeIdentity,
			observedInfo: operationStartedWithInfo,
			phase: operationStartedWithInfo ? "stopping-old" : "starting-new",
			newServiceRunId: operationStartedWithInfo ? null : randomUUID(),
			message: operationStartedWithInfo ? "Stopping old service" : "Starting pinano service",
		})
		if (begin.action === "wait") {
			const ready = await waitForLifecycleOperation(begin.operation, runtimeIdentity)
			if (ready) {
				const configured = await applyServiceLaunchOptions(ready, options, await serviceHealth(ready, runtimeIdentity))
				if (configured) {
					await clearLifecycleOperationForHealthyService(configured)
					return configured
				}
			}
			continue
		}
		if (begin.action === "retry") continue
		try {
			const info = await performLifecycleOperation(begin.operation, operationStartedWithInfo, options, runtimeIdentity)
			if (info) {
				const configured = await applyServiceLaunchOptions(info, options, await serviceHealth(info, runtimeIdentity))
				if (configured) return configured
			}
		} catch (err) {
			if (isLifecycleSupersededError(err)) continue
			throw err
		}
	}
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {boolean} [options.noContextFiles]
 * @param {string} [options.sessionListCwd]
 * @param {boolean} [options.idleShutdown]
 * @param {number} [options.idleShutdownDelayMs]
 * @param {boolean | "best-effort"} [options.startWeb]
 */
export async function openServiceClient(options) {
	const runtimeIdentity = await claimCurrentRuntimeIdentity()
	const info = await ensureService({ ...options, serviceClaimId: runtimeIdentity.claimId })
	return createServiceClient(info, {
		cwd: options.cwd,
		sessionListCwd: options.sessionListCwd,
		noContextFiles: options.noContextFiles,
		idleShutdown: options.idleShutdown,
		idleShutdownDelayMs: options.idleShutdownDelayMs,
		startWeb: options.startWeb,
		runtimeIdentity,
		reconnect: true,
	})
}

async function waitForServiceInfoRelease(info, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const current = await readInfo()
		if (!serviceInfoMatches(current, info)) return true
		const pid = servicePid(info)
		if (pid && pid !== process.pid && !processExists(pid)) return true
		await delay(50)
	}
	return !serviceInfoMatches(await readInfo(), info)
}

/**
 * @param {{ waitMs?: number, exitWaitMs?: number }} [options]
 */
export async function stopService(options = {}) {
	const info = await readInfo()
	if (!info) return { ok: true, stopped: false, reason: "not_running" }
	const pid = servicePid(info)
	if (pid && !processExists(pid)) {
		await removeStaleServiceInfo(info)
		return { ok: true, stopped: true, reason: "stale_info_removed" }
	}
	const waitMs = Number.isFinite(options.waitMs) ? Math.max(0, Number(options.waitMs)) : SERVICE_STOP_SOFT_WAIT_MS
	const exitWaitMs = Number.isFinite(options.exitWaitMs) ? Math.max(0, Number(options.exitWaitMs)) : SERVICE_STOP_EXIT_WAIT_MS
	const interrupted = await interruptOldService(info, "soft", waitMs)
	if (!interrupted.ok) return { ...interrupted, stopped: false, reason: "interrupt_failed" }
	if (interrupted.waiting?.length) return { ...interrupted, stopped: false, reason: "busy" }
	const released = await waitForServiceInfoRelease(info, exitWaitMs)
	if (released && pid && pid !== process.pid && !processExists(pid)) await removeStaleServiceInfo(info)
	return { ...interrupted, stopped: released, reason: released ? "stopped" : "timeout" }
}

/**
 * @param {any} info
 * @param {{ cwd?: string, sessionListCwd?: string, noContextFiles?: boolean, idleShutdown?: boolean, idleShutdownDelayMs?: number, startWeb?: boolean | "best-effort", runtimeIdentity?: any, reconnect?: boolean, requestTimeoutMs?: number, createSocket?: (url: string) => any }} [options]
 */
export function createServiceClient(info, options = {}) {
	let currentInfo = info
	const clientCwd = options.cwd
	const sessionListCwd = options.sessionListCwd
	const runtimeIdentity = options.runtimeIdentity
	const canReconnect = options.reconnect === true
	const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? Math.max(0, options.requestTimeoutMs) : SERVICE_REQUEST_TIMEOUT_MS
	const desiredRuntimeReadCache = createDesiredRuntimeReadCache()
	const runtimeCheckHandlers = new Set()
	let runtimeCheckTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
	let runtimeCheckInFlight = false

	const sessionsPath = (cwd = sessionListCwd, options = {}) => {
		const params = new URLSearchParams()
		if (cwd) params.set("cwd", cwd)
		if (options.includeDeleted === true) params.set("includeDeleted", "1")
		if (options.includeHidden === true) params.set("includeHidden", "1")
		const query = params.toString()
		return `/sessions${query ? `?${query}` : ""}`
	}
	const sessionsStatusPath = (cwd = sessionListCwd, options = {}) => {
		const params = new URLSearchParams()
		if (cwd) params.set("cwd", cwd)
		if (options.includeDeleted === true) params.set("includeDeleted", "1")
		if (options.includeHidden === true) params.set("includeHidden", "1")
		const query = params.toString()
		return `/sessions/status${query ? `?${query}` : ""}`
	}
	const sessionActionPath = (id, action) => `/sessions/${encodeURIComponent(id)}/${action}${sessionListCwd ? `?cwd=${encodeURIComponent(sessionListCwd)}` : ""}`
	const clientContextPath = (cwd = undefined) => cwd ? `/client-context?cwd=${encodeURIComponent(cwd)}` : "/client-context"
	const projectPreviewsPath = (projectDir, options = {}) => {
		const params = new URLSearchParams()
		params.set("projectDir", projectDir)
		if (options.sessionId) params.set("sessionId", options.sessionId)
		return `/projects/previews?${params}`
	}
	const sessionPreviewsPath = (id) => `/sessions/${encodeURIComponent(id)}/previews`
	const previewUrlPath = (route, url) => `/previews/${route}?url=${encodeURIComponent(url)}`
	const previewSourceResolvePath = (request = {}) => {
		const params = new URLSearchParams()
		if (request.path) params.set("path", request.path)
		if (request.projectDir) params.set("projectDir", request.projectDir)
		if (request.sessionId) params.set("sessionId", request.sessionId)
		const query = params.toString()
		return `/previews/resolve-source${query ? `?${query}` : ""}`
	}
	const sessionMatchesDirectoryFilter = (session, cwd) => {
		if (!cwd) return true
		const initialWd = typeof session?.initialWd === "string" && session.initialWd ? session.initialWd : session?.cwd
		return typeof initialWd === "string" && initialWd ? pathIsWithin(resolve(cwd), resolve(initialWd)) : false
	}
	const filterSessionEvent = (event) => {
		if (!sessionListCwd || !Array.isArray(event?.sessions)) return event
		return { ...event, sessions: event.sessions.filter((session) => sessionMatchesDirectoryFilter(session, sessionListCwd)) }
	}
	const reconnectOptions = () => ({
		cwd: clientCwd || currentInfo.cwd || process.cwd(),
		noContextFiles: options.noContextFiles === true,
		idleShutdown: options.idleShutdown,
		idleShutdownDelayMs: options.idleShutdownDelayMs,
		startWeb: options.startWeb,
	})
	const isServiceTransportError = (err) => {
		const code = /** @type {any} */ (err)?.code
		if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "PINANO_SERVICE_TIMEOUT"].includes(code)) return true
		const message = String(/** @type {any} */ (err)?.message ?? err)
		return /\b(ENOENT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE)\b|no such file or directory|socket hang up|timed out/i.test(message)
	}
	const reconnect = async () => {
		if (!canReconnect) return false
		currentInfo = await ensureService(reconnectOptions())
		return true
	}
	const verifyCurrentRuntimeDesired = async () => {
		if (runtimeIdentity) await verifyCurrentRuntimeDesiredReadOnly(runtimeIdentity, desiredRuntimeReadCache)
	}
	const stopRuntimeCheckTimer = () => {
		if (!runtimeCheckTimer) return
		clearInterval(runtimeCheckTimer)
		runtimeCheckTimer = undefined
	}
	const runRuntimeCheck = () => {
		if (runtimeCheckInFlight || runtimeCheckHandlers.size === 0) return
		runtimeCheckInFlight = true
		verifyCurrentRuntimeDesired()
			.catch((err) => {
				for (const handler of [...runtimeCheckHandlers]) handler(err)
			})
			.finally(() => {
				runtimeCheckInFlight = false
				if (runtimeCheckHandlers.size === 0) stopRuntimeCheckTimer()
			})
	}
	const addRuntimeCheckHandler = (handler) => {
		if (!runtimeIdentity) return () => {}
		runtimeCheckHandlers.add(handler)
		if (!runtimeCheckTimer) {
			runtimeCheckTimer = setInterval(runRuntimeCheck, SERVICE_CLIENT_RUNTIME_CHECK_INTERVAL_MS)
			runtimeCheckTimer.unref?.()
		}
		return () => {
			runtimeCheckHandlers.delete(handler)
			if (runtimeCheckHandlers.size === 0) stopRuntimeCheckTimer()
		}
	}
	const prefixedRoutePath = (prefix, path) => {
		const routePath = path.startsWith("/") ? path : `/${path}`
		return routePath === prefix || routePath.startsWith(`${prefix}/`) ? routePath : `${prefix}${routePath}`
	}
	const appApiPath = (path) => prefixedRoutePath(APP_API_ROUTE_PREFIX, path)
	const serviceControlPath = (path) => prefixedRoutePath(SERVICE_ROUTE_PREFIX, path)
	const request = async (path, requestOptions = {}) => {
		await verifyCurrentRuntimeDesired()
		const method = String(requestOptions.method ?? "GET").toUpperCase()
		const retryOnTimeout = requestOptions.retryOnTimeout ?? method === "GET"
		const requestOptionsWithTimeout = requestOptions.timeoutMs === undefined
			? { ...requestOptions, timeoutMs: requestTimeoutMs }
			: requestOptions
		try {
			return await requestJson(currentInfo, path, requestOptionsWithTimeout)
		} catch (err) {
			if (isServiceTimeoutError(err) && !retryOnTimeout) throw err
			if (!isServiceTransportError(err) || !await reconnect()) throw err
			return requestJson(currentInfo, path, requestOptionsWithTimeout)
		}
	}
	const requestRaw = async (path, requestOptions = {}) => {
		await verifyCurrentRuntimeDesired()
		const method = String(requestOptions.method ?? "GET").toUpperCase()
		const retryOnTimeout = requestOptions.retryOnTimeout ?? method === "GET"
		const requestOptionsWithTimeout = requestOptions.timeoutMs === undefined
			? { ...requestOptions, timeoutMs: requestTimeoutMs }
			: requestOptions
		try {
			const res = await requestBytes(currentInfo, path, requestOptionsWithTimeout)
			if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
			return res
		} catch (err) {
			if (isServiceTimeoutError(err) && !retryOnTimeout) throw err
			if (!isServiceTransportError(err) || !await reconnect()) throw err
			const res = await requestBytes(currentInfo, path, requestOptionsWithTimeout)
			if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
			return res
		}
	}
	const apiRequest = (path, requestOptions = {}) => request(appApiPath(path), requestOptions)
	const apiRequestRaw = (path, requestOptions = {}) => requestRaw(appApiPath(path), requestOptions)
	const serviceRequest = (path, requestOptions = {}) => request(serviceControlPath(path), requestOptions)
	const liveClient = new LiveResourceClient({
		url: () => serviceWebSocketUrl(currentInfo, serviceControlPath("/live")),
		createSocket: options.createSocket ?? createWebSocketClient,
		reconnect: canReconnect,
		beforeReconnect: reconnect,
	})
	let liveSubscriptionCount = 0
	let removeLiveRuntimeCheck = () => {}
	const retainLiveSubscription = () => {
		liveSubscriptionCount++
		if (liveSubscriptionCount === 1) removeLiveRuntimeCheck = addRuntimeCheckHandler(() => liveClient.restart())
		let retained = true
		return () => {
			if (!retained) return
			retained = false
			liveSubscriptionCount = Math.max(0, liveSubscriptionCount - 1)
			if (liveSubscriptionCount === 0) {
				removeLiveRuntimeCheck()
				removeLiveRuntimeCheck = () => {}
			}
		}
	}
	return {
		get info() {
			return currentInfo
		},
		async sessions(cwd = undefined, options = {}) {
			return (await apiRequest(sessionsPath(cwd, options))).sessions
		},
		async sessionsStatus(cwd = undefined, options = {}) {
			return apiRequest(sessionsStatusPath(cwd, options))
		},
		async clientContext(cwd = undefined) {
			return apiRequest(clientContextPath(cwd))
		},
		async overviewProject(cwd = undefined) {
			return (await apiRequest(clientContextPath(cwd))).project
		},
		async ensureProjectMaintenance(projectDir, options = {}) {
			return apiRequest("/projects/maintenance", {
				method: "POST",
				timeoutMs: 0,
				body: JSON.stringify({
					projectDir,
					runPrompt: options.runPrompt !== false,
					onlyIfNeeded: options.onlyIfNeeded === true,
					waitForCompletion: options.waitForCompletion === true,
				}),
			})
		},
		async projectPreviews(projectDir, options = {}) {
			return apiRequest(projectPreviewsPath(projectDir, options))
		},
		async sessionPreviews(id) {
			return apiRequest(sessionPreviewsPath(id))
		},
		async resolveSessionId(id) {
			const requested = typeof id === "string" ? id.trim() : ""
			return apiRequest(`/sessions/resolve?id=${encodeURIComponent(requested)}`)
		},
		async resolvePreviewUrl(url) {
			return apiRequest(previewUrlPath("resolve", url))
		},
		async resolvePreviewSource(request) {
			return apiRequest(previewSourceResolvePath(request))
		},
		async previewLog(url) {
			return apiRequest(previewUrlPath("log", url))
		},
		async previewSource(url) {
			return apiRequest(previewUrlPath("source", url))
		},
		async webStatus() {
			return serviceRequest("/web/status")
		},
		async desiredRuntime() {
			return readDesiredRuntimeIdentity()
		},
		async startWeb(options = {}) {
			return serviceRequest("/web/start", {
				method: "POST",
				body: JSON.stringify(options),
			})
		},
		async stopWeb() {
			return serviceRequest("/web/stop", { method: "POST", body: "{}" })
		},
		async getSettings() {
			return apiRequest("/settings")
		},
		async models() {
			return apiRequest("/models")
		},
		async createSession(options = {}) {
			const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : clientCwd
			return apiRequest("/sessions", {
				method: "POST",
				body: JSON.stringify({ prompt: options.prompt, cwd, images: options.images }),
			})
		},
		async setDefaultModel(model) {
			return apiRequest("/settings", {
				method: "POST",
				body: JSON.stringify({ model }),
			})
		},
		async setDefaultReasoning(level) {
			return apiRequest("/settings", {
				method: "POST",
				body: JSON.stringify({ thinkingLevel: level }),
			})
		},
		async getUiState(key) {
			const response = await apiRequest(`/ui-state?key=${encodeURIComponent(key)}`)
			return response.found ? response.value : undefined
		},
		async setUiState(key, value) {
			return apiRequest("/ui-state", {
				method: "POST",
				body: JSON.stringify({ key, value }),
			})
		},
		async deleteUiState(key) {
			return apiRequest(`/ui-state?key=${encodeURIComponent(key)}`, { method: "DELETE" })
		},
		async branchSession(id, options = {}) {
			const entryId = typeof options.entryId === "string" && options.entryId ? options.entryId : undefined
			const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : undefined
			return apiRequest(sessionActionPath(id, "branch"), {
				method: "POST",
				body: JSON.stringify({
					...(cwd ? { cwd } : {}),
					...(entryId ? { entryId } : {}),
					...(options.restoreDraft === false ? { restoreDraft: false } : {}),
				}),
			})
		},
		async spawnSubSession(id, options = {}) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/sub-sessions`, {
				method: "POST",
				timeoutMs: 0,
				body: JSON.stringify({
					task: options.task,
					name: options.name,
					forkTurns: options.forkTurns,
					origin: options.origin,
				}),
			})
		},
		async subSessions(id, options = {}) {
			const query = options.includeClosed === true ? "?includeClosed=1" : ""
			return apiRequest(`/sessions/${encodeURIComponent(id)}/sub-sessions${query}`)
		},
		async waitSubSession(id, options = {}) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/sub-sessions/wait`, {
				method: "POST",
				timeoutMs: 0,
				body: JSON.stringify({ agent: options.agent, timeoutMs: options.timeoutMs }),
			})
		},
		async followupSubSession(id, options = {}) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/sub-sessions/followup`, {
				method: "POST",
				timeoutMs: 0,
				body: JSON.stringify({ agent: options.agent, task: options.task, interrupt: options.interrupt === true }),
			})
		},
		async resumeSubSession(id, options = {}) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/sub-sessions/resume`, {
				method: "POST",
				timeoutMs: 0,
				body: JSON.stringify({ agent: options.agent }),
			})
		},
		async closeSubSession(id, options = {}) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/sub-sessions/close`, {
				method: "POST",
				timeoutMs: 0,
				body: JSON.stringify({ agent: options.agent, reason: options.reason }),
			})
		},
		async snapshot(id, options = {}) {
			const params = new URLSearchParams()
			if (options.includeSessions === true) params.set("includeSessions", "1")
			if (options.includeContextMessages === true) params.set("includeContextMessages", "1")
			const query = params.size > 0 ? `?${params}` : ""
			return apiRequest(`/sessions/${encodeURIComponent(id)}/snapshot${query}`)
		},
		async sessionStatus(id) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/status`)
		},
		async contextReport(id) {
			return (await apiRequest(`/sessions/${encodeURIComponent(id)}/context-report`)).lines ?? []
		},
		async systemReport(id) {
			return (await apiRequest(`/sessions/${encodeURIComponent(id)}/system-report`)).lines ?? []
		},
		async worktrees(id) {
			return (await apiRequest(`/sessions/${encodeURIComponent(id)}/worktrees`)).worktrees ?? []
		},
		async attachmentContent(id, attachmentId, variant = "display") {
			const params = new URLSearchParams()
			if (variant) params.set("variant", variant)
			const query = params.size > 0 ? `?${params}` : ""
			const res = await apiRequestRaw(`/sessions/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/content${query}`)
			return {
				data: res.body,
				mimeType: String(res.headers["content-type"] ?? "application/octet-stream"),
			}
		},
		async prompt(id, message, streamingBehavior, options = {}) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/prompt`, {
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
			return apiRequest(`/sessions/${encodeURIComponent(id)}/draft`, {
				method: "POST",
				body: JSON.stringify({ text, clientId: options.clientId, clientSeq: options.clientSeq }),
			})
		},
		async continueRun(id) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/continue`, { method: "POST", body: "{}" })
		},
		async abort(id) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/abort`, { method: "POST", body: "{}" })
		},
		async cancelPrompt(id, options = {}) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/cancel-prompt`, {
				method: "POST",
				body: JSON.stringify({ restoreCurrentPrompt: options.restoreCurrentPrompt !== false }),
			})
		},
		async markCompleted(id) {
			return apiRequest(sessionActionPath(id, "complete"), { method: "POST", body: "{}" })
		},
		async markDeferred(id) {
			return apiRequest(sessionActionPath(id, "defer"), { method: "POST", body: "{}" })
		},
		async markReadyForReview(id) {
			return apiRequest(sessionActionPath(id, "review"), { method: "POST", body: "{}" })
		},
		async deleteSession(id) {
			return apiRequest(sessionActionPath(id, "delete"), { method: "POST", body: "{}" })
		},
		async restoreSession(id) {
			return apiRequest(sessionActionPath(id, "restore"), { method: "POST", body: "{}" })
		},
		async setThinking(id, level) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/reasoning`, {
				method: "POST",
				body: JSON.stringify({ level }),
			})
		},
		async sessionModels(id) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/models`)
		},
		async setModel(id, model) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/model`, {
				method: "POST",
				body: JSON.stringify({ model }),
			})
		},
		async setFast(id, args) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/fast`, {
				method: "POST",
				body: JSON.stringify({ args }),
			})
		},
		async compact(id) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/compact`, { method: "POST", body: "{}", timeoutMs: 0 })
		},
		async bash(id, text, options = {}) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/bash`, {
				method: "POST",
				body: JSON.stringify({
					text,
					draftClientId: options.draftClientId,
					draftClientSeq: options.draftClientSeq,
				}),
				timeoutMs: 0,
			})
		},
		async rewindTargets(id) {
			return (await apiRequest(`/sessions/${encodeURIComponent(id)}/rewind-targets`)).targets
		},
		async rewind(id, entryId, options = {}) {
			return apiRequest(`/sessions/${encodeURIComponent(id)}/rewind`, {
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
			return serviceRequest("/interrupt", {
				method: "POST",
				body: JSON.stringify({ mode, waitMs }),
				timeoutMs,
			})
		},
		subscribe(onEvent, subscribeOptions = {}) {
			const sessionId = typeof subscribeOptions.sessionId === "string" && subscribeOptions.sessionId ? subscribeOptions.sessionId : ""
			const activeSessionId = !sessionId && typeof subscribeOptions.activeSessionId === "string" && subscribeOptions.activeSessionId ? subscribeOptions.activeSessionId : ""
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
			let established = false
			let failed = false
			let closed = false
			const release = retainLiveSubscription()
			const subscription = liveClient.subscribe("app", {
				...(sessionId ? { sessionId } : {}),
				...(activeSessionId ? { activeSessionId } : {}),
				...(!sessionId && subscribeOptions.includeDeleted === true ? { includeDeleted: true } : {}),
				...(!sessionId && subscribeOptions.includeHidden === true ? { includeHidden: true } : {}),
				...(subscribeOptions.excludeWorktreeStatus === true ? { excludeWorktreeStatus: true } : {}),
				...(subscribeOptions.excludeSessions === true ? { excludeSessions: true } : {}),
				...(subscribeOptions.worktreeStatusOnly === true ? { worktreeStatusOnly: true } : {}),
				...(sessionListCwd ? { cwd: sessionListCwd } : {}),
				...(clientCwd ? { contextCwd: clientCwd } : {}),
			}, {
				onReady() {
					if (failed || established) dispatchEvent({ type: "service_live_reconnected", reason: failed ? "resource" : "transport" })
					established = true
					failed = false
				},
				onData(event, envelope) {
					if (subscribeOptions.emitInitialSnapshot === false && envelope?.type === "snapshot") return
					dispatchEvent(filterSessionEvent(event))
				},
				onError(err) {
					failed = true
					dispatchEvent({ type: "error", error: err?.message ?? String(err) })
				},
			})
			return async () => {
				if (closed) return
				closed = true
				try {
					subscription.unsubscribe()
				} finally {
					release()
				}
			}
		},
		subscribeSessionList(onUpdate, params = {}, handlers = {}) {
			let closed = false
			const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : sessionListCwd
			const contextCwd = typeof params.contextCwd === "string" && params.contextCwd ? params.contextCwd : clientCwd
			const release = retainLiveSubscription()
			const subscription = liveClient.subscribe("sessions", {
				...(cwd ? { cwd } : {}),
				...(contextCwd ? { contextCwd } : {}),
				...(params.includeDeleted === true ? { includeDeleted: true } : {}),
				...(params.includeHidden === true ? { includeHidden: true } : {}),
			}, {
				onData: onUpdate,
				onReady: handlers.onReady,
				onDisconnect: handlers.onDisconnect,
				onError: handlers.onError,
			})
			return async () => {
				if (closed) return
				closed = true
				try {
					subscription.unsubscribe()
				} finally {
					release()
				}
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
 * @param {boolean} [options.checkHealth]
 */
export async function serviceStatus(options) {
	const info = await readInfo()
	let health = null
	if (info && options.checkHealth !== false) {
		try {
			health = await requestJson(info, `${SERVICE_ROUTE_PREFIX}/health`, { timeoutMs: SERVICE_CONNECTIVITY_TIMEOUT_MS })
		} catch {}
	}
	const desiredRuntime = await readDesiredRuntimeIdentity()
	const lifecycleOperation = await readLifecycleOperationUnlocked()
	const lifecycleLock = await readDirectoryLockStatus(serviceLifecycleLockPath(), SERVICE_LIFECYCLE_LOCK_TTL_MS)
	return {
		info,
		alive: health?.ok === true,
		pidAlive: processExists(servicePid(info)),
		health,
		desiredRuntime,
		lifecycle: {
			state: lifecycleOperationState(lifecycleOperation),
			operation: lifecycleOperation,
			operationPath: serviceLifecycleOperationPath(),
			lock: lifecycleLock,
		},
		logPath: serviceLogPath(),
		runtimeSourceReferencePath: runtimeSourceReferencePath(),
		serviceInfoPath: info?.[INFO_PATH] ?? serviceInfoPath(),
		desiredRuntimeIdentityPath: desiredRuntimeIdentityPath(),
	}
}
