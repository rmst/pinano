#!/usr/bin/env node
// pinano — interactive AI assistant TUI.
//
// Usage:
//   pinano [options]
//
// Auth: API keys and ChatGPT subscription OAuth are managed in credentials settings.
// Stored credentials are refreshed/resolved on demand.

import { readFile } from "node:fs/promises"
import { reexecRuntime } from "./reexec-runtime.js"

const NO_MODEL_PROVIDER_CLI_MESSAGE = "No model provider configured. Run `pinano open /settings/credentials` to add your ChatGPT subscription or an API key."

if (process.env.PINANO_PROCESS_TITLE) process.title = process.env.PINANO_PROCESS_TITLE

/**
 * @typedef {object} Args
 * @property {string} cwd
 * @property {boolean} help
 * @property {boolean} version
 * @property {"print" | "bg" | "logs" | "stop"} [sessionCommand]
 * @property {"text" | "json"} mode
 * @property {string[]} messages
 * @property {boolean} noContextFiles
 * @property {boolean} web
 * @property {boolean} serviceRun
 * @property {string} [serviceHost]
 * @property {number} [servicePort]
 * @property {string} [serviceRunId]
 * @property {string} [serviceClaimId]
 * @property {"open" | "service-status"} [command]
 * @property {boolean} [serviceStatusJson]
 * @property {string} [commandArg]
 * @property {import("./routes.js").PinanoRoute} [route]
 */

const HIDDEN_SESSION_SURFACE = "`pinano session` is a hidden, deferred CLI surface. It is kept for development but may not work correctly yet."

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
	if (!subcommand) failUsage(`${HIDDEN_SESSION_SURFACE}\nUse one of: pinano session print|bg|logs|stop.`)
	if (subcommand !== "print" && subcommand !== "bg" && subcommand !== "logs" && subcommand !== "stop") {
		failUsage(`Unknown session command: ${subcommand}.`)
	}
	args.sessionCommand = subcommand
	let i = index + 2
	if (subcommand === "logs" || subcommand === "stop") {
		args.commandArg = argv[i]
		if (!args.commandArg) failUsage(`pinano session ${subcommand} requires a session id`)
		if (argv[i + 1] !== undefined) failUsage(`Unexpected argument for pinano session ${subcommand}: ${argv[i + 1]}`)
		return argv.length
	}
	while (i < argv.length) {
		const arg = argv[i]
		if (arg === "--mode") {
			if (subcommand !== "print") failUsage("--mode is only supported by `pinano session print`.")
			const [mode, nextIndex] = optionValue(argv, i, "--mode")
			if (mode === "text" || mode === "json") args.mode = mode
			else failUsage(`Invalid --mode "${mode}". Use "text" or "json".`)
			i = nextIndex + 1
		} else if (arg === "--no-context-files") {
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
		mode: "text",
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
		else if (arg === "--cwd") failUsage("--cwd was removed. Run `cd <path> && pinano` instead.")
		else if (arg === "--mode") failUsage("--mode is only supported by the hidden `pinano session print` command.")
		else if (arg === "--web" || arg === "web") args.web = true
		else if (arg === "service") {
			const next = argv[i + 1]
			if (next === "run") {
				args.serviceRun = true
				i++
			} else if (next === "status") {
				args.command = "service-status"
				i++
			} else if (next === undefined || next.startsWith("-")) {
				args.command = "service-status"
			} else {
				failUsage(`Unknown service command: ${next}. Use \`pinano service status\`.`)
			}
		}
		else if (arg === "--service-host") [args.serviceHost, i] = optionValue(argv, i, arg)
		else if (arg === "--service-port") {
			const [value, nextIndex] = optionValue(argv, i, arg)
			args.servicePort = parseInt(value, 10)
			i = nextIndex
		}
		else if (arg === "--service-run-id") [args.serviceRunId, i] = optionValue(argv, i, arg)
		else if (arg === "--service-claim-id") [args.serviceClaimId, i] = optionValue(argv, i, arg)
		else if (arg.startsWith("--daemon-")) failUsage("Daemon flags were removed. Use the service CLI surface instead.")
		else if (arg === "daemon" || arg === "daemon-status") failUsage("Daemon CLI aliases were removed. Use `pinano service status`.")
		else if (arg === "service-status") failUsage("`pinano service-status` was removed. Use `pinano service status`.")
		else if (arg === "--bg") failUsage("Top-level `--bg` was removed. The deferred helper is `pinano session bg`.")
		else if (arg === "-p" || arg === "--print") failUsage("Top-level print mode was removed. The deferred helper is `pinano session print`.")
		else if (arg === "open") {
			args.command = "open"
			args.commandArg = argv[++i]
		}
		else if (arg === "logs" || arg === "stop") failUsage(`Top-level \`pinano ${arg}\` was removed. The deferred helper is \`pinano session ${arg}\`.`)
		else if (arg === "session") i = parseSessionCommand(argv, i, args) - 1
		else if (arg === "--json") args.serviceStatusJson = true
		else if (!arg.startsWith("-")) {
			args.messages.push(arg)
		} else {
			failUsage(`Unknown option: ${arg}`)
		}
	}
	if (!args.help && !args.version) {
		if (args.command === "open" && !args.commandArg) failUsage("open requires a route: /, /chat/<id>, or /settings/credentials")
		if ((args.serviceHost || args.servicePort !== undefined || args.serviceRunId || args.serviceClaimId) && !args.serviceRun) {
			failUsage("Service internals require `pinano service run`.")
		}
		if (args.serviceRun && args.servicePort === undefined) {
			failUsage("service run requires --service-port")
		}
		if (args.serviceStatusJson && args.command !== "service-status") {
			failUsage("--json is only supported with `pinano service status`.")
		}
		if (args.messages.length > 0 && args.sessionCommand !== "print" && args.sessionCommand !== "bg") {
			failUsage("Unexpected prompt text. Open Pinano without arguments, or use the hidden `pinano session print` / `pinano session bg` helpers.")
		}
	}
	return args
}

function webDisabledMessage() {
	return "Pinano Web is disabled. Set \"web\": true in $PINANO_HOME/config/default-settings.json or settings.json to enable it."
}

async function packageVersion() {
	const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf-8"))
	if (typeof pkg.version !== "string" || !pkg.version) throw new Error("Pinano package.json is missing a version")
	return pkg.version
}

/**
 * @param {Args} args
 * @param {import("./settings.js").Settings} settings
 */
function printHelp(args, settings) {
	console.log((args.web ? webHelpLines() : mainHelpLines(settings)).join("\n"))
}

/** @param {import("./settings.js").Settings} settings */
function mainHelpLines(settings) {
	const usage = [
		"  pinano                           # dispatch and monitor service sessions",
		"  pinano open /                    # open the session overview",
		"  pinano open /chat/<id>           # open a service session",
		"  pinano open /settings/credentials # manage model provider credentials",
		...(settings.web ? ["  pinano web                       # experimental browser UI"] : []),
		"  pinano service [status] [--json] # show service status",
	]
	return [
		"pinano — interactive AI assistant",
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

function webHelpLines() {
	return [
		"pinano web — experimental browser UI",
		"",
		"Usage:",
		"  pinano web",
		"",
		"Web uses the authenticated local service endpoint.",
		"Endpoint and public URL defaults are read from $PINANO_HOME/config/service.json.",
		"Use /web in the TUI to open the same service-hosted browser UI.",
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
		if (cur?.code === "PINANO_STALE_RUNTIME" || /\bpinano client is stale\b/i.test(text)) {
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
			const serviceMode = await import("./service-mode.js")
			desired = await serviceMode.readDesiredRuntimeIdentity()
		} catch {}
	}
	const target = desired?.mainPath
	if (!target) return false
	const runtime = desired.execPath ?? process.execPath
	if (runtime === process.execPath && target === process.argv[1]) return false
	const depth = Number(process.env.PINANO_STALE_RUNTIME_REEXEC_DEPTH ?? 0)
	if (Number.isFinite(depth) && depth >= 3) return false
	console.error("Pinano was updated; reopening…")
	await reexecRuntime({
		command: runtime,
		args: [target, ...cliArgs],
		cwd: process.cwd(),
		envPatch: { PINANO_STALE_RUNTIME_REEXEC_DEPTH: String((Number.isFinite(depth) ? depth : 0) + 1) },
	})
	return true
}


async function main() {
	const args = parseArgs(process.argv.slice(2))
	if (args.version) {
		console.log(await packageVersion())
		return
	}

	const [
		{ loadSettings },
		{ availableModelEntries, modelEntryMatches, modelRef, modelSettingsHasRef, resolveModel },
		{ buildProjectContextMessage, isProjectContextMessage },
		{ runPrintMode },
		{ installStderrCapture },
		{ createPinanoAgent, createPinanoSidecarAgent },
		{ overviewRoute, parseRouteArg },
		{ initialEnvironmentContextFor },
	] = await Promise.all([
		import("./settings.js"),
		import("./models.js"),
		import("./project-context.js"),
		import("./print-mode.js"),
		import("./stderr-capture.js"),
		import("./agent-factory.js"),
		import("./routes.js"),
		import("./environment-context.js"),
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
	if (availableModels.length === 0 && (args.sessionCommand === "print" || args.sessionCommand === "bg")) {
		console.error(NO_MODEL_PROVIDER_CLI_MESSAGE)
		process.exit(2)
	}
	const configuredModel = availableModels.find((m) => modelEntryMatches(m, settings.model))
	const configuredDeclarativeModel = modelSettingsHasRef(settings.models, settings.model)
	const modelId = configuredModel || configuredDeclarativeModel ? settings.model : (availableModels[0] ? modelRef(availableModels[0]) : settings.model)
	const model = resolveModel(modelId, { models: settings.models })

	const createAgent = ({ cwd = args.cwd, toolExecutor = undefined } = {}) => createPinanoAgent({
		cwd,
		model,
		settings,
		noContextFiles: args.noContextFiles,
		environmentContext: () => initialEnvironmentContextFor(cwd),
		...(toolExecutor ? { toolExecutor } : {}),
	})

	if (args.serviceRun) {
		const { runService } = await import("./service-mode.js")
		const { ToolExecutorRuntime } = await import("./tool-executor-runtime.js")
		await runService({
			cwd: args.cwd,
			host: args.serviceHost,
			port: args.servicePort,
			serviceRunId: args.serviceRunId,
			serviceClaimId: args.serviceClaimId,
			noContextFiles: args.noContextFiles,
			createAgent: ({ cwd }) => {
				const createExecutor = (getAgent) => new ToolExecutorRuntime({
					cwd,
					getSession: () => getAgent()?.session,
					pinanoApiRequest: (request) => {
						const target = getAgent()
						if (!target?.pinanoApiRequest) throw new Error("Pinano JS API is unavailable for this session")
						return target.pinanoApiRequest(request)
					},
				})
				let agent
				const executor = createExecutor(() => agent)
				agent = createPinanoAgent({
					cwd,
					model,
					settings,
					noContextFiles: args.noContextFiles,
					toolExecutor: executor,
					environmentContext: () => initialEnvironmentContextFor(cwd),
				})
				agent.createSidecarAgent = (sidecarOptions) => {
					let sidecar
					const sidecarExecutor = createExecutor(() => sidecar)
					sidecar = createPinanoSidecarAgent({
						cwd,
						baseAgent: agent,
						messages: sidecarOptions.messages,
						toolExecutor: sidecarExecutor,
						transformContext: sidecarOptions.transformContext,
						afterToolCall: sidecarOptions.afterToolCall,
					})
					sidecar.dispose = () => sidecarExecutor.dispose()
					return sidecar
				}
				return agent
			},
		})
		return
	}

	if (args.command === "service-status") {
		const { serviceStatus, formatServiceStatus } = await import("./service-mode.js")
		const status = await serviceStatus({ cwd: args.cwd })
		const printable = status.info ? { ...status, info: { ...status.info, token: undefined } } : status
		console.log(args.serviceStatusJson ? JSON.stringify(printable, null, "\t") : formatServiceStatus(printable))
		return
	}

	if (args.sessionCommand === "bg") {
		const prompt = args.messages.join(" ").trim()
		if (!prompt) {
			console.error("pinano session bg requires a prompt")
			process.exit(2)
		}
		const { dispatchBackground } = await import("./service-mode.js")
		const result = await dispatchBackground({
			cwd: args.cwd,
			prompt,
			noContextFiles: args.noContextFiles,
		}).catch(async (err) => {
			await reexecForStaleRuntime(err)
			throw err
		})
		const shortId = result.sessionId.slice(0, 8)
		console.log(`backgrounded · ${shortId}`)
		console.log(`  pinano                         list sessions`)
		console.log(`  pinano open /chat/${shortId}     open in this terminal`)
		console.log(`  pinano session logs ${shortId}    show transcript`)
		console.log(`  pinano session stop ${shortId}    abort this session`)
		return
	}

	if (args.sessionCommand === "logs" || args.sessionCommand === "stop") {
		const id = /** @type {string} */ (args.commandArg)
		const { openServiceClient } = await import("./service-mode.js")
		const client = await openServiceClient({ cwd: args.cwd, noContextFiles: args.noContextFiles }).catch(async (err) => {
			await reexecForStaleRuntime(err)
			throw err
		})
		if (args.sessionCommand === "stop") {
			await client.abort(id)
			console.log(`stopped · ${id.slice(0, 8)}`)
			return
		}
		const snapshot = await client.snapshot(id)
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
		const { openServiceClient } = await import("./service-mode.js")
		const client = await openServiceClient({ cwd: args.cwd, noContextFiles: args.noContextFiles }).catch(async (err) => {
			await reexecForStaleRuntime(err)
			throw err
		})
		const { runServiceTuiMode } = await import("./agents-mode.js")
		const stderrCapture = installStderrCapture()
		await runServiceTuiMode({
			cwd: args.cwd,
			client,
			initialRoute: args.route,
			stderrCapture,
		})
		return
	}

	// Print mode is hermetic: no session creation, no index work.
	if (args.sessionCommand === "print") {
		const { ToolExecutorRuntime } = await import("./tool-executor-runtime.js")
		const executor = new ToolExecutorRuntime({ cwd: args.cwd })
		const agent = createAgent({ cwd: args.cwd, toolExecutor: executor })
		let code = 1
		try {
			if (!args.noContextFiles) {
				const ctxMsg = buildProjectContextMessage(args.cwd)
				if (ctxMsg) agent.state.messages = [ctxMsg]
			}
			code = await runPrintMode(agent, { mode: args.mode, messages: args.messages })
		} finally {
			agent.dispose?.()
		}
		process.exit(code)
	}

	if (args.web) {
		const { runWebMode } = await import("./web-mode.js")
		await runWebMode({
			cwd: args.cwd,
			noContextFiles: args.noContextFiles,
		}).catch(async (err) => {
			await reexecForStaleRuntime(err)
			throw err
		})
		process.exit(0)
	}

	const { openServiceClient } = await import("./service-mode.js")
	const { runServiceTuiMode } = await import("./agents-mode.js")
	const client = await openServiceClient({ cwd: args.cwd, noContextFiles: args.noContextFiles }).catch(async (err) => {
		await reexecForStaleRuntime(err)
		throw err
	})
	const stderrCapture = installStderrCapture()
	await runServiceTuiMode({
		cwd: args.cwd,
		client,
		noContextFiles: args.noContextFiles,
		initialRoute: overviewRoute,
		stderrCapture,
	})
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
