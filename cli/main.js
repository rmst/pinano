#!/usr/bin/env node
// cerex — interactive AI assistant TUI.
//
// Usage:
//   cerex [options]
//
// Auth: API keys and ChatGPT subscription OAuth are managed in credentials settings.
// Stored credentials are refreshed/resolved on demand.

import { readFile } from "node:fs/promises"
import { clearReexecSupervisorEnv, reexecRuntime, staleRuntimeReexecEnvPatch } from "../packages/server/src/app/runtime/reexec.js"
import { applyProcessTitleForArgs } from "../packages/server/src/app/runtime/process-title.js"
import { WEB_BROWSER_UI_NAME } from "../packages/protocol/src/web-branding.js"
import { applyProductEnvAliases, productErrorCodeMatches } from "../packages/protocol/src/product.js"

applyProductEnvAliases(process.env)
clearReexecSupervisorEnv()

const NO_MODEL_PROVIDER_CLI_MESSAGE = "No model provider configured. Run `cerex open /settings/credentials` to add your ChatGPT subscription or an API key."

async function loadWebMode() {
	try {
		return await import("../packages/web/src/server/web-mode.js")
	} catch (err) {
		if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes("/packages/web/")) {
			throw new Error(`${WEB_BROWSER_UI_NAME} is not available in this installation`, { cause: err })
		}
		throw err
	}
}

/**
 * @typedef {object} Args
 * @property {string} cwd
 * @property {boolean} help
 * @property {boolean} version
 * @property {"bg" | "logs" | "stop"} [sessionCommand]
 * @property {string[]} messages
 * @property {boolean} noContextFiles
 * @property {boolean} web
 * @property {boolean} serviceRun
 * @property {string} [serviceHost]
 * @property {number} [servicePort]
 * @property {string} [serviceRunId]
 * @property {string} [serviceClaimId]
 * @property {string} [serviceLifecycleOperationId]
 * @property {"open" | "service-status" | "service-start" | "service-stop"} [command]
 * @property {boolean} [serviceForeground]
 * @property {boolean} [serviceIdleShutdown]
 * @property {boolean} [serviceStatusJson]
 * @property {string} [commandArg]
 * @property {import("../packages/server/src/app/navigation/routes.js").AppRoute} [route]
 */

const HIDDEN_SESSION_SURFACE = "`cerex session` is a hidden, deferred CLI surface. It is kept for development but may not work correctly yet."

/** @param {string} message */
function failUsage(message) {
	console.error(message)
	process.exit(2)
}

/**
 * @param {string[]} argv
 * @param {number} index
 * @param {string} option
 * @returns {[string, number]}
 */
function optionValue(argv, index, option) {
	const value = argv[index + 1]
	if (value === undefined) failUsage(`${option} requires a value`)
	return [value, index + 1]
}

/**
 * Hidden/deferred batch helpers. Keep this out of public help until the non-interactive session surface is productized.
 * @param {string[]} argv
 * @param {number} index
 * @param {Args} args
 * @returns {number}
 */
function parseSessionCommand(argv, index, args) {
	const subcommand = argv[index + 1]
	if (!subcommand) failUsage(`${HIDDEN_SESSION_SURFACE}\nUse one of: cerex session bg|logs|stop.`)
	if (subcommand !== "bg" && subcommand !== "logs" && subcommand !== "stop") {
		failUsage(`Unknown session command: ${subcommand}.`)
	}
	args.sessionCommand = subcommand
	let i = index + 2
	if (subcommand === "logs" || subcommand === "stop") {
		args.commandArg = argv[i]
		if (!args.commandArg) failUsage(`cerex session ${subcommand} requires a session id`)
		if (argv[i + 1] !== undefined) failUsage(`Unexpected argument for cerex session ${subcommand}: ${argv[i + 1]}`)
		return argv.length
	}
	while (i < argv.length) {
		const arg = argv[i]
		if (arg === "--no-context-files") {
			args.noContextFiles = true
			i++
		} else {
			args.messages.push(arg)
			i++
		}
	}
	return i
}

/**
 * @param {string[]} argv
 * @returns {Args}
 */
function parseArgs(argv) {
	/** @type {Args} */
	const args = {
		cwd: process.cwd(),
		help: false,
		version: false,
		messages: [],
		noContextFiles: false,
		web: false,
		serviceRun: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--help" || arg === "-h") args.help = true
		else if (arg === "--version" || arg === "-v") args.version = true
		else if (arg === "--no-context-files") args.noContextFiles = true
		else if (arg === "--cwd") failUsage("--cwd was removed. Run `cd <path> && cerex` instead.")
		else if (arg === "--web" || arg === "web") args.web = true
		else if (arg === "service") {
			const next = argv[i + 1]
			if (next === "run") {
				args.serviceRun = true
				i++
			} else if (next === "status") {
				args.command = "service-status"
				i++
			} else if (next === "start") {
				args.command = "service-start"
				i++
			} else if (next === "stop") {
				args.command = "service-stop"
				i++
			} else if (next === undefined || next.startsWith("-")) {
				args.command = "service-status"
			} else {
				failUsage(`Unknown service command: ${next}. Use \`cerex service status\`, \`cerex service start\`, or \`cerex service stop\`.`)
			}
		}
		else if (arg === "--foreground" || arg === "--fg") args.serviceForeground = true
		else if (arg === "--idle-shutdown") args.serviceIdleShutdown = true
		else if (arg === "--service-host") [args.serviceHost, i] = optionValue(argv, i, arg)
		else if (arg === "--service-port") {
			const [value, nextIndex] = optionValue(argv, i, arg)
			args.servicePort = parseInt(value, 10)
			i = nextIndex
		}
		else if (arg === "--service-run-id") [args.serviceRunId, i] = optionValue(argv, i, arg)
		else if (arg === "--service-claim-id") [args.serviceClaimId, i] = optionValue(argv, i, arg)
		else if (arg === "--service-lifecycle-operation-id") [args.serviceLifecycleOperationId, i] = optionValue(argv, i, arg)
		else if (arg === "service-status") failUsage("`cerex service-status` was removed. Use `cerex service status`.")
		else if (arg === "--bg") failUsage("Top-level `--bg` was removed. The deferred helper is `cerex session bg`.")
		else if (arg === "open") {
			args.command = "open"
			args.commandArg = argv[++i]
		}
		else if (arg === "logs" || arg === "stop") failUsage(`Top-level \`cerex ${arg}\` was removed. The deferred helper is \`cerex session ${arg}\`.`)
		else if (arg === "session") i = parseSessionCommand(argv, i, args) - 1
		else if (arg === "--json") args.serviceStatusJson = true
		else if (!arg.startsWith("-")) {
			args.messages.push(arg)
		} else {
			failUsage(`Unknown option: ${arg}`)
		}
	}
	if (!args.help && !args.version) {
		if (args.command === "open" && !args.commandArg) failUsage("open requires a route: /browse, /sessions/<id>, or /settings/credentials")
		if ((args.serviceHost || args.servicePort !== undefined || args.serviceRunId || args.serviceClaimId || args.serviceLifecycleOperationId) && !args.serviceRun) {
			failUsage("Service internals require `cerex service run`.")
		}
		if (args.serviceRun && args.servicePort === undefined) {
			failUsage("service run requires --service-port")
		}
		if (args.serviceStatusJson && args.command !== "service-status") {
			failUsage("--json is only supported with `cerex service status`.")
		}
		if (args.serviceForeground && args.command !== "service-start") {
			failUsage("--foreground is only supported with `cerex service start`.")
		}
		if (args.serviceIdleShutdown && !(args.command === "service-start" && args.serviceForeground)) {
			failUsage("--idle-shutdown is only supported with `cerex service start --foreground`.")
		}
		if (args.messages.length > 0 && args.sessionCommand !== "bg") {
			failUsage("Unexpected prompt text. Open Cerex without arguments, or use the hidden `cerex session bg` helper.")
		}
	}
	return args
}

function webDisabledMessage() {
	return `${WEB_BROWSER_UI_NAME} is disabled. Set "web": true in $CEREX_HOME/default-settings.json or settings.json to enable it.`
}

function serviceEndpointLabel(info) {
	const host = info?.host || "127.0.0.1"
	const port = info?.port ?? "?"
	return `${host}:${port}`
}

function printServiceRunning(info) {
	console.log(`cerex service running at ${serviceEndpointLabel(info)}`)
}

function serviceStopFailureMessage(result) {
	if (result?.reason === "busy") return "Cerex service is busy; stop running sessions before stopping the service."
	if (result?.reason === "timeout") return "Timed out waiting for Cerex service to stop."
	return result?.error || "Failed to stop Cerex service."
}

async function packageVersion() {
	const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"))
	if (typeof pkg.version !== "string" || !pkg.version) throw new Error("Cerex package.json is missing a version")
	return pkg.version
}

/**
 * @param {Args} args
 * @param {import("../packages/server/src/app/settings.js").Settings} settings
 */
function printHelp(args, settings) {
	console.log((args.web ? webHelpLines() : args.command?.startsWith?.("service-") ? serviceHelpLines() : mainHelpLines(settings)).join("\n"))
}

/** @param {import("../packages/server/src/app/settings.js").Settings} settings */
function mainHelpLines(settings) {
	const usage = [
		"  cerex                           # dispatch and monitor service sessions",
		"  cerex open /browse              # open the file explorer and session overview",
		"  cerex open /sessions/<id>       # open a service session",
		"  cerex open /settings/credentials # manage model provider credentials",
		...(settings.web ? [`  cerex web                       # open ${WEB_BROWSER_UI_NAME}`] : []),
		"  cerex service status [--json]  # show service status",
		"  cerex service start [--foreground] # start the service",
		"  cerex service stop             # stop the service",
	]
	return [
		"cerex — interactive AI assistant",
		"",
		"Usage:",
		...usage,
		"",
		"Options:",
		"  -h, --help     show help",
		"  -v, --version  show version",
		"",
		"In the TUI, type /help for slash commands.",
	]
}

function serviceHelpLines() {
	return [
		"cerex service — service lifecycle",
		"",
		"Usage:",
		"  cerex service status [--json]",
		"  cerex service start [--foreground]",
		"  cerex service stop",
		"",
		"`cerex service start` starts the background service and starts Web when web is enabled in settings.",
		"`cerex service start --foreground` runs the same service in the current process for service managers.",
	]
}

function webHelpLines() {
	return [
		`cerex web — ${WEB_BROWSER_UI_NAME}`,
		"",
		"Usage:",
		"  cerex web",
		"",
		"Web uses the authenticated local service endpoint.",
		"Endpoint and public URL defaults are read from service.web in Cerex settings.",
		`Use /web in the TUI to open ${WEB_BROWSER_UI_NAME}.`,
	]
}

/** @param {unknown} content */
function flattenMessageContent(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text ?? "")
		.join("")
}

/** @param {unknown} err */
function staleRuntimeDetails(err) {
	let cur = /** @type {any} */ (err)
	while (cur) {
		const text = `${cur?.message ?? cur}`
		if (productErrorCodeMatches(cur, "CEREX_STALE_RUNTIME") || /\b(?:cerex|pinano) client is stale\b/i.test(text)) {
			return { desiredRuntime: cur.desiredRuntime, reason: cur.reason }
		}
		cur = cur.cause
	}
	return null
}

async function reexecForStaleRuntime(err, cliArgs = process.argv.slice(2)) {
	const details = staleRuntimeDetails(err)
	let desired = details?.desiredRuntime
	if (!desired?.mainPath && details) {
		try {
			const serviceMode = await import("../packages/server/src/app/service/index.js")
			desired = await serviceMode.readDesiredRuntimeIdentity()
		} catch {}
	}
	const target = desired?.mainPath
	if (!target) return false
	const runtime = desired.execPath ?? process.execPath
	if (runtime === process.execPath && target === process.argv[1]) return false
	let envPatch
	try {
		envPatch = staleRuntimeReexecEnvPatch()
	} catch {
		return false
	}
	console.error("Cerex was updated; reopening…")
	const runtimeArgs = runtime === process.execPath
		? [...(process.execArgv ?? []), target, ...cliArgs]
		: [target, ...cliArgs]
	await reexecRuntime({
		command: runtime,
		args: runtimeArgs,
		cwd: process.cwd(),
		envPatch,
	})
	return true
}

function shouldAutoInstallBundledBubblewrap(args) {
	return !args.version && !args.help && args.command !== "service-status" && args.command !== "service-stop"
}

async function autoInstallBundledBubblewrapForStartup(args) {
	if (!shouldAutoInstallBundledBubblewrap(args)) return
	const { bestEffortAutoInstallBundledBubblewrap } = await import("../packages/server/src/app/sandbox/bwrap/bundled.js")
	await bestEffortAutoInstallBundledBubblewrap()
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	applyProcessTitleForArgs(args)
	if (args.version) {
		console.log(await packageVersion())
		return
	}
	await autoInstallBundledBubblewrapForStartup(args)

	const [
		{ loadSettings, stateMountFromSettings },
		{ availableModelEntries, buildModel, modelEntryMatches, resolveModelWithProviderMetadata },
		{ isProjectContextMessage },
		{ installStderrCapture },
		{ createAgentRuntime, createSidecarAgentRuntime },
		{ overviewRoute, parseRouteArg, routeToArg, sessionRoute },
		{ initialEnvironmentContextFor },
		{ previewPublicUrlFromSettings },
	] = await Promise.all([
		import("../packages/server/src/app/settings.js"),
		import("../packages/server/src/app/model/registry.js"),
		import("../packages/server/src/app/project/context.js"),
		import("../packages/server/src/app/stderr-capture.js"),
		import("../packages/server/src/app/agent/factory.js"),
		import("../packages/server/src/app/navigation/routes.js"),
		import("../packages/server/src/app/environment/context.js"),
		import("../packages/server/src/app/preview/manifest.js"),
	])

	const settings = await loadSettings()
	if (args.web && !settings.web) {
		console.error(webDisabledMessage())
		process.exit(2)
	}
	if (args.help) {
		printHelp(args, settings)
		return
	}
	if (args.command === "open") {
		try {
			args.route = parseRouteArg(args.commandArg)
		} catch (err) {
			failUsage(/** @type {any} */ (err)?.message ?? err)
		}
	}

	const availableModels = await availableModelEntries(settings)
	if (availableModels.length === 0 && args.sessionCommand === "bg") {
		console.error(NO_MODEL_PROVIDER_CLI_MESSAGE)
		process.exit(2)
	}
	const configuredModel = availableModels.find((m) => modelEntryMatches(m, settings.defaultModel))
	const fallbackModel = configuredModel ?? availableModels[0]
	const model = fallbackModel
		? buildModel(fallbackModel)
		: await resolveModelWithProviderMetadata(settings.defaultModel, { providers: settings.providers })

	const environmentContextOptions = (currentSettings = settings) => ({
		stateMount: stateMountFromSettings(currentSettings),
		previewPublicUrl: previewPublicUrlFromSettings(currentSettings),
	})
	const createServiceAgentFactory = () => ({ cwd, getSettings, workspace, previewAccessToken }) => {
		const currentSettings = () => getSettings?.() ?? settings
		const createExecutor = (getAgent) => workspace.openToolExecutor({
			cwd,
			getSettings: currentSettings,
			getSession: () => getAgent()?.session,
			previewAccessToken,
			codeModeApiRequest: (request) => {
				const target = getAgent()
				if (!target?.codeModeApiRequest) throw new Error("Cerex JS API is unavailable for this session")
				return target.codeModeApiRequest(request)
			},
		})
		let agent
		const executor = createExecutor(() => agent)
		agent = createAgentRuntime({
			cwd,
			model,
			settings,
			noContextFiles: args.noContextFiles,
			toolExecutor: executor,
			workspace,
			environmentContext: () => initialEnvironmentContextFor(cwd, undefined, environmentContextOptions(currentSettings())),
		})
		agent.createSidecarAgent = (sidecarOptions) => {
			let sidecar
			const sidecarExecutor = createExecutor(() => sidecar)
			sidecar = createSidecarAgentRuntime({
				cwd,
				baseAgent: agent,
				messages: sidecarOptions.messages,
				toolExecutor: sidecarExecutor,
				workspace,
				transformContext: sidecarOptions.transformContext,
				afterToolCall: sidecarOptions.afterToolCall,
			})
			return sidecar
		}
		return agent
	}

	if (args.serviceRun) {
		const { runService } = await import("../packages/server/src/app/service/index.js")
		await runService({
			cwd: args.cwd,
			host: args.serviceHost,
			port: args.servicePort,
			serviceRunId: args.serviceRunId,
			serviceClaimId: args.serviceClaimId,
			serviceLifecycleOperationId: args.serviceLifecycleOperationId,
			noContextFiles: args.noContextFiles,
			loadWebMode,
			createAgent: createServiceAgentFactory(),
		})
		return
	}

	if (args.command === "service-start") {
		const { serviceStatus } = await import("../packages/server/src/app/service/index.js")
		if (args.serviceForeground) {
			const existing = await serviceStatus({ cwd: args.cwd })
			if (existing.alive) {
				console.error(`Cerex service is already running at ${serviceEndpointLabel(existing.info)}. Stop it first with \`cerex service stop\`.`)
				process.exit(1)
			}
			const [
				{ runService },
				{ configuredServiceEndpointDefaults },
			] = await Promise.all([
				import("../packages/server/src/app/service/index.js"),
				import("../packages/server/src/app/service/config.js"),
			])
			const endpoint = configuredServiceEndpointDefaults()
			const service = await runService({
				cwd: args.cwd,
				host: endpoint.host,
				port: endpoint.port,
				noContextFiles: args.noContextFiles,
				idleShutdown: args.serviceIdleShutdown === true ? true : false,
				allowPortFallback: false,
				startWeb: settings.web === true,
				loadWebMode,
				createAgent: createServiceAgentFactory(),
			}).catch(async (err) => {
				await reexecForStaleRuntime(err)
				throw err
			})
			printServiceRunning(service.info)
			if (service.web?.running) {
				const { printWebStatus } = await loadWebMode()
				printWebStatus(service.web)
			}
			return
		}

		const before = await serviceStatus({ cwd: args.cwd })
		const { openServiceClient } = await import("../packages/server/src/app/service/index.js")
		const client = await openServiceClient({
			cwd: args.cwd,
			noContextFiles: args.noContextFiles,
			idleShutdown: false,
		}).catch(async (err) => {
			await reexecForStaleRuntime(err)
			throw err
		})
		printServiceRunning(client.info)
		if (settings.web === true) {
			try {
				const status = await client.webStatus()
				const web = status.web?.running ? status.web : (await client.startWeb({})).web
				const { printWebStatus } = await loadWebMode()
				printWebStatus(web)
			} catch (err) {
				if (!before.alive) await client.interrupt("soft", 1000).catch(() => {})
				throw err
			}
		}
		return
	}

	if (args.command === "service-stop") {
		const { stopService } = await import("../packages/server/src/app/service/index.js")
		const result = await stopService()
		if (result.reason === "not_running") {
			console.log("cerex service not running")
			return
		}
		if (!result.stopped) {
			console.error(serviceStopFailureMessage(result))
			process.exit(1)
		}
		console.log("cerex service stopped")
		return
	}

	if (args.command === "service-status") {
		const { serviceStatus, formatServiceStatus } = await import("../packages/server/src/app/service/index.js")
		const status = await serviceStatus({ cwd: args.cwd })
		const printable = status.info ? { ...status, info: { ...status.info, token: undefined } } : status
		console.log(args.serviceStatusJson ? JSON.stringify(printable, null, "\t") : formatServiceStatus(printable))
		return
	}

	if (args.sessionCommand === "bg") {
		const prompt = args.messages.join(" ").trim()
		if (!prompt) {
			console.error("cerex session bg requires a prompt")
			process.exit(2)
		}
		const { dispatchBackground } = await import("../packages/server/src/app/service/index.js")
		const result = await dispatchBackground({
			cwd: args.cwd,
			prompt,
			noContextFiles: args.noContextFiles,
		}).catch(async (err) => {
			await reexecForStaleRuntime(err)
			throw err
		})
		const shortId = result.sessionId.slice(0, 8)
		const openCommand = `cerex open ${routeToArg(sessionRoute(result.sessionId))}`
		console.log(`backgrounded · ${shortId}`)
		console.log(`  cerex                         list sessions`)
		console.log(`  ${openCommand.padEnd(31)} open in this terminal`)
		console.log(`  cerex session logs ${result.sessionId}    show transcript`)
		console.log(`  cerex session stop ${result.sessionId}    abort this session`)
		return
	}

	if (args.sessionCommand === "logs" || args.sessionCommand === "stop") {
		const id = /** @type {string} */ (args.commandArg)
		const { openServiceClient } = await import("../packages/server/src/app/service/index.js")
		const client = await openServiceClient({ cwd: args.cwd, noContextFiles: args.noContextFiles }).catch(async (err) => {
			await reexecForStaleRuntime(err)
			throw err
		})
		const resolved = await client.resolveSessionId(id)
		const sessionId = resolved.sessionId
		if (args.sessionCommand === "stop") {
			await client.abort(sessionId)
			console.log(`stopped · ${sessionId.slice(0, 8)}`)
			return
		}
		const snapshot = await client.snapshot(sessionId)
		for (const message of snapshot.messages ?? []) {
			if (isProjectContextMessage(message)) continue
			const text = flattenMessageContent(message.content).trim()
			if (!text) continue
			console.log(`${message.role}: ${text}`)
		}
		if (snapshot.streamingMessage) {
			const text = flattenMessageContent(snapshot.streamingMessage.content).trim()
			if (text) console.log(`${snapshot.streamingMessage.role}: ${text}`)
		}
		return
	}

	if (args.command === "open") {
		const { openServiceClient } = await import("../packages/server/src/app/service/index.js")
		const stderrCapture = installStderrCapture()
		const client = await openServiceClient({
			cwd: args.cwd,
			noContextFiles: args.noContextFiles,
			startWeb: settings.web === true ? "best-effort" : false,
			onDiagnostic: (diagnostic) => stderrCapture.record(diagnostic.message),
		}).catch(async (err) => {
			await reexecForStaleRuntime(err)
			throw err
		})
		const { runServiceTuiMode } = await import("../packages/tui/src/app/tui/index.js")
		await runServiceTuiMode({
			cwd: args.cwd,
			client,
			initialRoute: args.route,
			stderrCapture,
		})
		return
	}

	if (args.web) {
		const { runWebMode } = await loadWebMode()
		await runWebMode({
			cwd: args.cwd,
			noContextFiles: args.noContextFiles,
		}).catch(async (err) => {
			await reexecForStaleRuntime(err)
			throw err
		})
		process.exit(0)
	}

	const { openServiceClient } = await import("../packages/server/src/app/service/index.js")
	const { runServiceTuiMode } = await import("../packages/tui/src/app/tui/index.js")
	const stderrCapture = installStderrCapture()
	const client = await openServiceClient({
		cwd: args.cwd,
		noContextFiles: args.noContextFiles,
		startWeb: settings.web === true ? "best-effort" : false,
		onDiagnostic: (diagnostic) => stderrCapture.record(diagnostic.message),
	}).catch(async (err) => {
		await reexecForStaleRuntime(err)
		throw err
	})
	await runServiceTuiMode({
		cwd: args.cwd,
		client,
		noContextFiles: args.noContextFiles,
		initialRoute: overviewRoute,
		stderrCapture,
	})
}

main().catch((err) => {
	/** @type {any} */ (process).__stderrCapture?.setForwarding?.(true)
	console.error(err)
	process.exit(1)
})
