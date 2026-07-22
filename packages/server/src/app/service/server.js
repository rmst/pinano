// Supervisor service for background Pinano agent sessions.
//
// The service owns RuntimeManager and all live Agent runtimes for one Pinano home.
// Frontends (agent view, open routes, shell helpers, and web) talk to it over
// authenticated local HTTP and WebSocket endpoints over loopback TCP.

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import * as http from "node:http"
import { join, resolve } from "node:path"

import { ensureRuntimeSourceReference } from "../runtime-source-reference.js"
import { loadSettings, updateSetting } from "../settings.js"
import { RuntimeManager } from "../session-runtime/index.js"
import { authenticateRequest, authenticateRequestParts, bearerTokenFromHeader } from "../http-auth.js"
import { configuredServiceDebug, configuredServiceDiagnostics, configuredWebDefaults } from "../service-config.js"
import { getOrCreateServiceToken } from "../service-token.js"
import { createServiceDiagnostics } from "../service-diagnostics.js"
import { createDebugInspectApp, isDebugRequestPath } from "../debug-inspect.js"
import { HttpRouter } from "../http-router.js"
import { createManagerClientApi, json, jsonBody, registerClientApiRoutes, routeError } from "../client-api.js"
import { writeResponseBody } from "../http-response.js"
import { createLiveEventHub } from "../live/event-hub.js"
import { createAppLiveResource } from "../live/resources.js"
import { createSessionListLiveResource } from "../session-list-live-resource.js"
import { createLiveResourceWebSocketServer } from "../live/resource-websocket.js"
import { startCodexUsagePoller } from "../codex-usage-poller.js"
import { bestEffortAutoInstallBundledBubblewrap } from "../bundled-bwrap.js"
import { createWorkspaceRootPolicyFromSettings } from "../workspace-root-policy.js"
import { webPasswordAuthConfigKey, webPasswordAuthStatus } from "../web-config.js"
import { WEB_BROWSER_UI_NAME } from "../../../../protocol/src/web-branding.js"
import { PreviewManager } from "../preview/manager.js"
import { PREVIEW_AUTHORIZATION_HEADER, previewPublicUrlFromSettings, previewRoutingSlugFromSettings } from "../preview/manifest.js"
import { serviceHostForListen } from "./network.js"

/** @typedef {import("../agent-runtime.js").AgentRuntime} Agent */
import {
	SERVICE_PROTOCOL_VERSION,
	SERVICE_OWNERSHIP_CHECK_INTERVAL_MS,
	processStartedAtMs,
	sourceRoot,
	packageRoot,
	mainPath,
	serviceDir,
	appendServiceLog,
	openOwnedServerDb,
	serviceIdleShutdownDelayMs,
	serviceIdleShutdownInfo,
	authError,
	updateDefaultModel,
	writePrivateJson,
	APP_API_ROUTE_PREFIX,
	SERVICE_ROUTE_PREFIX,
	stripKnownRoutePrefix,
	incomingRequestUrl,
	isAppApiRequestPath,
	isServiceControlRequestPath,
	listenTcpEndpoint,
	processRuntimeIdentity,
	withServiceLifecycleLock,
	readLifecycleOperationUnlocked,
	claimCurrentRuntimeIdentity,
	ensureCurrentRuntimeIsDesired,
	serviceStartupLifecycleCurrent,
	serviceStartupLifecycleSupersededDetails,
	assertServiceStartupLifecycleCurrent,
	normalizeServiceInfo,
} from "./lifecycle.js"

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {string} [options.token]
 * @param {boolean} [options.noContextFiles]
 * @param {string} [options.serviceRunId]
 * @param {string} [options.serviceClaimId]
 * @param {string} [options.serviceLifecycleOperationId]
 * @param {() => void | Promise<void>} [options.onIdle]
 * @param {boolean} [options.idleShutdown]
 * @param {number} [options.idleShutdownDelayMs]
 * @param {boolean} [options.allowPortFallback]
 * @param {boolean} [options.startWeb]
 * @param {() => Promise<{ createManagerWebApp: Function, webPublicUrl: Function }>} [options.loadWebMode]
 * @param {number} [options.serviceOwnershipCheckIntervalMs]
 * @param {any} [options.webAppOptions]
 * @param {(identity: any) => Promise<{ path: string, generation: string }>} [options.prepareRuntimeSourceReference]
 * @param {(info: { sessionId: string, session: any, cwd: string }) => Agent} options.createAgent
 */
export async function runService(options) {
	await bestEffortAutoInstallBundledBubblewrap()
	let serviceSettings = await loadSettings()
	const workspacePolicy = await createWorkspaceRootPolicyFromSettings(serviceSettings)
	const serviceCwd = workspacePolicy ? await workspacePolicy.normalizeUserCwd(options.cwd, "service startup cwd") : options.cwd
	const diagnosticsOptions = configuredServiceDiagnostics()
	const diagnostics = createServiceDiagnostics({
		...diagnosticsOptions,
		path: diagnosticsOptions.path || join(serviceDir(), "diagnostics.jsonl"),
		processName: "pinano service",
	})
	const serviceToken = typeof options.token === "string" && options.token ? options.token : await getOrCreateServiceToken()
	const runtimeIdentity = await processRuntimeIdentity()
	const codeFingerprint = runtimeIdentity.codeFingerprint
	if (options.serviceClaimId) await ensureCurrentRuntimeIsDesired(runtimeIdentity, options.serviceClaimId)
	else await claimCurrentRuntimeIdentity()
	const serviceRunId = options.serviceRunId ?? randomUUID()
	await assertServiceStartupLifecycleCurrent(options.serviceLifecycleOperationId, serviceRunId)
	const prepareRuntimeSourceReference = options.prepareRuntimeSourceReference ?? ensureRuntimeSourceReference
	const sourceReference = await prepareRuntimeSourceReference(runtimeIdentity)
	await appendServiceLog("runtime_source_reference_ready", { path: sourceReference.path, generation: sourceReference.generation })
	const serviceStartedAt = new Date().toISOString()
	let idleShutdownDelayMs = serviceIdleShutdownDelayMs(options)
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
	const hub = createLiveEventHub(() => scheduleIdleCheck())
	const db = await openOwnedServerDb({ recoverRunningRuns: true })
	db.recoverServiceRuns(undefined, serviceRunId)
	db.startServiceRun({
		id: serviceRunId,
		pid: process.pid,
		cwd: serviceCwd,
		transport: "tcp",
		port: options.port,
		codeFingerprint,
		startedAt: serviceStartedAt,
	})
	let serviceModelOverride = false
	let serviceEndpoint = /** @type {{ host?: string, port?: number, requestedPort?: number, portFallback?: boolean }} */ ({ host: options.host, port: options.port, requestedPort: options.port, portFallback: false })
	let webServer = /** @type {any} */ (undefined)
	let webOptions = /** @type {any} */ (undefined)
	const webPreviewPublicUrl = () => {
		if (webOptions?.publicUrl) return webOptions.publicUrl
		const configured = previewPublicUrlFromSettings(serviceSettings)
		if (configured) return configured
		if (serviceSettings.web !== true && !webServer) return undefined
		const port = Number(webOptions?.port ?? webServer?.port ?? serviceEndpoint.port)
		return Number.isInteger(port) && port > 0 ? `http://localhost:${port}/` : undefined
	}
	const manager = await RuntimeManager.create({
		cwd: serviceCwd,
		workspacePolicy,
		createAgent: options.createAgent,
		getSettings: () => serviceModelOverride ? serviceSettings : { ...serviceSettings, defaultModel: undefined },
		getPreviewPublicUrl: webPreviewPublicUrl,
		noContextFiles: options.noContextFiles === true,
		diagnostics,
	}, db, hub)
	manager.resumeRunnableInterruptedRuns().catch((err) => console.error("service auto-resume error", err))
	let server
	let serviceLiveServer
	const previewManager = new PreviewManager({
		manager,
		db,
		getPublicUrl: webPreviewPublicUrl,
		diagnostics,
	})
	let codexUsagePoller = { close() {} }
	let serviceInfoFile = ""
	let serviceInfo = /** @type {any} */ (null)
	const runningRuntimes = () => [...manager.runtimes.values()].filter((runtime) => runtime.isStreaming())
	const backgroundRuntimes = () => [...manager.runtimes.values()].filter((runtime) => runtime.hasBackgroundWork?.())
	const waitingInfos = () => runningRuntimes().map((runtime) => runtime.waitingInfo())
	diagnostics.setContextProvider?.(() => ({
		activeRequests,
		liveSubscriptions: hub.subscriptionCount(),
		webActive: Boolean(webServer),
		runningSessions: runningRuntimes().length,
		runningSessionIds: runningRuntimes().map((runtime) => runtime.sessionId),
		backgroundSessions: backgroundRuntimes().length,
		waiting: waitingInfos().length,
	}))
	diagnostics.addProbe?.("noop", () => ({}))
	const isBusy = () => {
		if (activeRequests > 0) return true
		if (hub.subscriptionCount() > 0) return true
		if (webServer && webOptions?.idleKeepAlive !== false) return true
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
			try { serviceLiveServer?.close() } catch {}
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
		if (closed || isBusy() || idleShutdownDelayMs === null) return
		idleTimer = setTimeout(() => {
			stopForIdle().catch((err) => {
				console.error("service idle shutdown error", err)
				process.exit(1)
			})
		}, idleShutdownDelayMs)
		idleTimer.unref?.()
	}
	const writeCurrentServiceInfo = async () => {
		if (!serviceInfoFile || !serviceInfo) return
		Object.assign(serviceInfo, serviceIdleShutdownInfo(idleShutdownDelayMs))
		await writePrivateJson(serviceInfoFile, serviceInfo)
	}
	const updateIdleShutdown = async (requestBody = {}) => {
		const body = requestBody && typeof requestBody === "object" ? requestBody : {}
		const enabled = body.enabled ?? body.idleShutdown
		if (enabled !== false) throw Object.assign(new Error("Only disabling service idle shutdown is supported."), { status: 400 })
		idleShutdownDelayMs = null
		clearIdleTimer()
		await writeCurrentServiceInfo()
		await appendServiceLog("service_idle_shutdown_disabled", { serviceRunId })
		return { ok: true, ...serviceIdleShutdownInfo(idleShutdownDelayMs) }
	}
	const resolveSessionId = (id) => {
		const requested = String(id ?? "").trim()
		if (!requested) throw Object.assign(new Error("session id is required"), { status: 400 })
		const matches = db.findSessionIdsByPrefix(requested)
		if (matches.includes(requested)) return requested
		if (matches.length === 1) return matches[0]
		if (matches.length > 1) throw Object.assign(new Error(`ambiguous session id ${requested}`), { status: 400 })
		throw Object.assign(new Error(`Session not found: ${requested}`), { status: 404 })
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
			initialRoute: webServer.initialRoute,
			dev: webOptions.dev,
			auth: webOptions.auth,
			idleKeepAlive: webOptions.idleKeepAlive,
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
		await previewManager.close()
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
			initialRoute: hasOwn(bodyInput, "initialRoute"),
			dev: hasOwn(bodyInput, "dev"),
			auth: hasOwn(bodyInput, "auth"),
			idleKeepAlive: hasOwn(bodyInput, "idleKeepAlive"),
		}
		const anyExplicit = Object.values(explicit).some(Boolean)
		const endpointHost = serviceHostForListen(serviceEndpoint.host)
		const endpointPort = Number(serviceEndpoint.port)
		if (!Number.isInteger(endpointPort) || endpointPort <= 0) throw new Error("Pinano service endpoint is not ready")
		const configuredHost = typeof defaults.host === "string" && defaults.host ? defaults.host : undefined
		const configuredFixedPort = Number.isInteger(defaults.port) && defaults.port > 0 ? defaults.port : undefined
		const fallbackPort = Number(serviceEndpoint.requestedPort)
		if (configuredHost && configuredHost !== endpointHost) throw Object.assign(new Error(`${WEB_BROWSER_UI_NAME} is configured for host ${configuredHost}, but the running service is bound to ${endpointHost}; restart the service after updating service.web in Pinano settings.`), { status: 409 })
		if (configuredFixedPort && configuredFixedPort !== endpointPort) throw Object.assign(new Error(`${WEB_BROWSER_UI_NAME} is configured for port ${configuredFixedPort}, but the running service is on ${endpointHost}:${endpointPort}. Free the configured port and restart the service, or update service.web in Pinano settings.`), { status: 409 })
		if (serviceEndpoint.portFallback && fallbackPort > 0) throw Object.assign(new Error(`${WEB_BROWSER_UI_NAME} cannot start on fallback service port ${endpointPort}; requested port ${fallbackPort} was unavailable when the service started. Free the requested port and restart the service, or update service.web in Pinano settings.`), { status: 409 })
		const requestedPort = Number.isInteger(body.port) ? Math.max(0, body.port) : undefined
		const requestedToken = typeof body.token === "string" && body.token ? body.token : undefined
		if (explicit.host && body.host && body.host !== endpointHost) throw Object.assign(new Error(`${WEB_BROWSER_UI_NAME} shares the service endpoint; restart the service to change its host.`), { status: 409 })
		if (explicit.port && requestedPort && requestedPort !== endpointPort) throw Object.assign(new Error(`${WEB_BROWSER_UI_NAME} shares the service endpoint; restart the service to change its port.`), { status: 409 })
		if (explicit.token && requestedToken && requestedToken !== serviceToken) throw Object.assign(new Error(`${WEB_BROWSER_UI_NAME} shares the service endpoint token; restart the service to change it.`), { status: 409 })
		const baseAppOptions = options.webAppOptions || {}
		const desiredWebAuth = hasOwn(body, "auth") ? body.auth : baseAppOptions.webAuth
		const desired = {
			host: endpointHost,
			requestedPort: endpointPort,
			port: endpointPort,
			publicUrl: typeof body.publicUrl === "string" && body.publicUrl ? body.publicUrl : undefined,
			initialRoute: typeof body.initialRoute === "string" && body.initialRoute ? body.initialRoute : undefined,
			dev: body.dev === true,
			auth: webPasswordAuthStatus(desiredWebAuth),
			authConfigKey: webPasswordAuthConfigKey(desiredWebAuth),
			webAuth: desiredWebAuth,
			idleKeepAlive: body.idleKeepAlive === false ? false : true,
		}
		if (webServer) {
			if (!anyExplicit) return { ok: true, web: webStatus() }
			const same = desired.publicUrl === webOptions.publicUrl && desired.initialRoute === webOptions.initialRoute && desired.dev === webOptions.dev && desired.authConfigKey === webOptions.authConfigKey
			if (same && body.replace !== true) {
				webOptions = { ...webOptions, idleKeepAlive: desired.idleKeepAlive }
				scheduleIdleCheck()
				return { ok: true, web: webStatus() }
			}
			if (body.replace !== true) throw Object.assign(new Error(`Web app already active at ${webServer.url}`), { status: 409 })
			await stopWeb()
		}
		if (typeof options.loadWebMode !== "function") {
			throw Object.assign(new Error(`${WEB_BROWSER_UI_NAME} is not available in this installation`), { status: 501 })
		}
		const { createManagerWebApp, webPublicUrl } = await options.loadWebMode()
		const appOptions = { ...baseAppOptions, token: serviceToken, dev: desired.dev, webAuth: desired.webAuth }
		const webApp = await createManagerWebApp({
			cwd: serviceCwd,
			manager,
			hub,
			db,
			host: desired.host,
			port: desired.port,
			resolveSessionId,
			token: serviceToken,
			publicUrl: desired.publicUrl,
			initialRoute: desired.initialRoute,
			dev: desired.dev,
			auth: desired.webAuth,
			workspaceRoot: manager.workspacePolicy?.root,
			createStaticPreview: (request) => previewManager.createStaticPreview({
				...request,
				routingSlug: previewRoutingSlugFromSettings(serviceSettings),
			}),
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
			url: webPublicUrl({ host: desired.host, port: desired.port, token: desired.auth ? undefined : serviceToken, publicUrl: desired.publicUrl, initialRoute: webApp.initialRoute }),
			close: () => webApp.close?.(),
		}
		webOptions = { ...desired, startedAt: new Date().toISOString() }
		scheduleIdleCheck()
		return { ok: true, web: webStatus() }
	}

	const serviceApi = createManagerClientApi({
		cwd: serviceCwd,
		manager,
		resolveSessionId,
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
	const sessionLists = createSessionListLiveResource({
		api: serviceApi,
		subscribeEvents(onEvent) {
			const subscription = hub.subscribe((record) => onEvent(record.value))
			return () => subscription.unsubscribe()
		},
	})
	serviceLiveServer = createLiveResourceWebSocketServer({
		path: `${SERVICE_ROUTE_PREFIX}/live`,
		resources: {
			app: createAppLiveResource({ api: serviceApi, hub }),
			sessions: sessionLists,
		},
		authenticate: (incoming, url) => authenticateRequestParts({
			url: url.href,
			authorization: incomingHeader(incoming.headers, "authorization"),
			origin: incomingHeader(incoming.headers, "origin"),
		}, serviceToken, { checkOrigin: true }),
		onError: (err) => console.error("service live websocket error:", err?.message ?? err),
	})
	const serviceApp = new HttpRouter()
	const debugApp = createDebugInspectApp({
		getConfig: configuredServiceDebug,
		getEndpoint: () => serviceEndpoint,
		getDiagnostics: () => diagnostics,
		getEventHub: () => hub,
		getManager: () => manager,
		resolveSessionId,
		heapSnapshotDir: () => join(serviceDir(), "heap-snapshots"),
		getServiceState: () => ({
			serviceRunId,
			serviceStartedAt,
			processStartedAtMs,
			cwd: serviceCwd,
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
			cwd: serviceCwd,
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
			...serviceIdleShutdownInfo(idleShutdownDelayMs),
			activeRequests,
			liveSubscriptions: hub.subscriptionCount(),
			web: webStatus(false),
			runningSessions: runningRuntimes().map((runtime) => runtime.sessionId),
			backgroundSessions: backgroundRuntimes().map((runtime) => runtime.sessionId),
			waiting: waitingInfos(),
			diagnostics: diagnostics.status(),
		})))
		serviceApp.post(path("/idle-shutdown"), safeServiceRoute(async (context) => json(await updateIdleShutdown(await jsonBody(context)))))
		serviceApp.get(path("/web/status"), safeServiceRoute(async () => json({ ok: true, web: webStatus() })))
		serviceApp.post(path("/web/start"), safeServiceRoute(async (context) => json(await startWeb(await jsonBody(context)))))
		serviceApp.post(path("/web/stop"), safeServiceRoute(async () => json({ ok: true, stopped: await stopWeb(), web: webStatus() })))
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
	registerClientApiRoutes(serviceApp, serviceApi, { prefix: APP_API_ROUTE_PREFIX, includeCommands: true, includeSnapshotRoute: true })
	registerServiceManagementRoutes(SERVICE_ROUTE_PREFIX)
	serviceApp.use("*", () => json({ error: "Not Found" }, 404))

	/** @param {Request} req */
	const handleServiceRequest = (req) => serviceApp.fetch(req)
	const incomingHeader = (headers, name) => {
		const value = headers?.[name.toLowerCase()] ?? headers?.[name]
		if (Array.isArray(value)) return value[0]
		return typeof value === "string" ? value : undefined
	}
	const trustedPreviewAuthorization = ({ url, authorization, origin, previewAuthorization }) => {
		if (typeof previewAuthorization !== "string" || !previewAuthorization) return undefined
		if (bearerTokenFromHeader(previewAuthorization) === serviceToken) return undefined
		const auth = authenticateRequestParts({ url, authorization, origin }, serviceToken, { checkOrigin: true })
		return auth.ok ? previewAuthorization : undefined
	}
	const requestPreviewAuthorization = (req, auth) => auth?.previewAuthorization ?? trustedPreviewAuthorization({
		url: req.url,
		authorization: req.headers.get("authorization"),
		origin: req.headers.get("origin"),
		previewAuthorization: req.headers.get(PREVIEW_AUTHORIZATION_HEADER),
	})
	const incomingPreviewAuthorization = (incoming, auth) => auth?.previewAuthorization ?? trustedPreviewAuthorization({
		url: `http://${incoming.headers.host || "localhost"}${incoming.url || "/"}`,
		authorization: incomingHeader(incoming.headers, "authorization"),
		origin: incomingHeader(incoming.headers, "origin"),
		previewAuthorization: incomingHeader(incoming.headers, PREVIEW_AUTHORIZATION_HEADER),
	})

	/** @param {Request} req */
	const handle = async (req) => {
		const url = new URL(req.url)
		if (previewManager.matchHost(req.headers.get("host"))) {
			const auth = await webServer?.previewAuth?.request?.(req)
			if (auth?.passToWeb && webServer?.app) return webServer.app.fetch(req)
			if (auth?.ok === false) return auth.response ?? json({ error: "Unauthorized" }, 401)
			return previewManager.fetch(req, { authorization: requestPreviewAuthorization(req, auth) })
		}
		if (isDebugRequestPath(url.pathname)) return debugApp.fetch(req)
		if (isServiceControlRequestPath(url.pathname)) {
			const auth = authenticateRequest(req, serviceToken, { checkOrigin: true })
			if (!auth.ok) return authError(auth)
			return handleServiceRequest(req)
		}
		if (isAppApiRequestPath(url.pathname)) {
			if (webServer?.app) return webServer.app.fetch(req)
			const auth = authenticateRequest(req, serviceToken, { checkOrigin: true })
			if (!auth.ok) return authError(auth)
			return handleServiceRequest(req)
		}
		if (webServer?.app) return webServer.app.fetch(req)
		return json({ error: "Not Found" }, 404)
	}

	server = http.createServer(async (incoming, outgoing) => {
		const requestUrl = incomingRequestUrl(incoming)
		const requestPath = stripKnownRoutePrefix(new URL(requestUrl).pathname)
		activeRequests++
		clearIdleTimer()
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
			outgoing.writeHead(response.status, headers)
			await writeResponseBody(incoming, outgoing, response)
			if (!outgoing.destroyed) await new Promise((resolve) => outgoing.end(resolve))
			finishActiveRequest()
		} catch (err) {
			finishRequest({ error: true })
			finishActiveRequest()
			console.error("service request error", err)
			if (!outgoing.headersSent) outgoing.writeHead(500)
			outgoing.end("Internal Server Error")
		}
	})
	server.on("upgrade", (incoming, socket, head) => {
		activeRequests++
		clearIdleTimer()
		;(async () => {
			if (await serviceLiveServer.upgrade(incoming, socket, head)) return true
			let auth
			if (previewManager.matchHost(incoming.headers.host)) {
				auth = await webServer?.previewAuth?.upgrade?.(incoming)
				if (auth?.ok === false) {
					socket.write(`HTTP/1.1 ${auth.status ?? 401} ${auth.message ?? "Unauthorized"}\r\nconnection: close\r\n\r\n${auth.message ?? "Unauthorized"}`)
					socket.destroy()
					return true
				}
				return previewManager.upgrade(incoming, socket, head, { authorization: incomingPreviewAuthorization(incoming, auth) })
			}
			return await webServer?.upgrade?.(incoming, socket, head) ?? false
		})()
			.then((handled) => {
				if (handled || socket.destroyed) return
				socket.write("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\nNot Found")
				socket.destroy()
			})
			.catch((err) => {
				console.error("service preview upgrade error", err)
				if (!socket.destroyed) {
					socket.write("HTTP/1.1 500 Internal Server Error\r\nconnection: close\r\n\r\nInternal Server Error")
					socket.destroy()
				}
			})
			.finally(() => {
				if (activeRequests > 0) activeRequests--
				scheduleIdleCheck()
			})
	})

	const listenHost = serviceHostForListen(options.host)
	const listenResult = await listenTcpEndpoint(server, listenHost, options.port ?? 0, { allowPortFallback: options.allowPortFallback })
	const address = server.address()
	const host = serviceHostForListen(options.host)
	const port = typeof address === "object" && address ? address.port : options.port
	const requestedPort = listenResult.requestedPort
	const portFallback = listenResult.portFallback
	serviceEndpoint = { host, port, requestedPort, portFallback }
	const serviceInfoDir = serviceDir()
	serviceInfoFile = join(serviceInfoDir, "service.json")
	serviceInfo = {
		pid: process.pid,
		cwd: serviceCwd,
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
		...serviceIdleShutdownInfo(idleShutdownDelayMs),
	}
	db.startServiceRun({
		id: serviceRunId,
		pid: process.pid,
		cwd: serviceCwd,
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
	if (options.serviceLifecycleOperationId) {
		let supersededDetails = null
		await withServiceLifecycleLock(async () => {
			const operation = await readLifecycleOperationUnlocked()
			if (!serviceStartupLifecycleCurrent(operation, options.serviceLifecycleOperationId, serviceRunId)) {
				supersededDetails = serviceStartupLifecycleSupersededDetails(options.serviceLifecycleOperationId, serviceRunId, operation)
				return
			}
			await writePrivateJson(serviceInfoFile, serviceInfo)
		})
		if (supersededDetails) {
			await appendServiceLog("service_startup_lifecycle_superseded", supersededDetails)
			throw lifecycleSupersededError("Service startup lifecycle operation was superseded")
		}
	} else {
		await writePrivateJson(serviceInfoFile, serviceInfo)
	}
	await appendServiceLog("service_started", { pid: process.pid, serviceRunId, cwd: serviceCwd, transport: "tcp", host, port, requestedPort, portFallback, codeFingerprint, runtimeKey: runtimeIdentity.runtimeKey })
	startOwnershipChecks()
	codexUsagePoller = startCodexUsagePoller({ getSettings: () => serviceSettings })

	const cleanup = async () => {
		if (closed) return
		closed = true
		clearIdleTimer()
		clearOwnershipCheckTimer()
		try { codexUsagePoller.close() } catch {}
		try { serviceLiveServer?.close() } catch {}
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
	let startupWeb = null
	try {
		if (options.startWeb === true) startupWeb = await startWeb({})
	} catch (err) {
		shutdownReason = "web_startup_failed"
		await cleanup()
		throw err
	}
	scheduleIdleCheck()
	return { manager, db, info: normalizeServiceInfo(serviceInfo, serviceInfoFile), web: startupWeb?.web ?? webStatus(false), close: cleanup }
}
