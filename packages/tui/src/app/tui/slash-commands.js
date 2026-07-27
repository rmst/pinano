import { routeToArg, sessionRoute, overviewRoute } from "../../../../server/src/app/navigation/routes.js"
import { rewindPromptActionItems } from "../../../../server/src/app/session/rewind-actions.js"
import { fetchCodexUsage, formatCodexUsage } from "../../../../server/src/app/usage/codex.js"
import { isFastModeEligibleModel } from "../../../../server/src/app/agent/fast-mode.js"
import { showTextModal } from "../components/text-modal.js"
import { WEB_BROWSER_UI_NAME } from "../../../../protocol/src/web-branding.js"

const OVERVIEW_COMMANDS = [
	{ name: "help", description: "show overview commands" },
	{ name: "hotkeys", description: "show overview hotkeys" },
	{ name: "web", description: `open ${WEB_BROWSER_UI_NAME} overview` },
	{ name: "usage", description: "show ChatGPT/Codex usage limits" },
	{ name: "debug-log", description: "show this TUI client's debug log; /debug-log clear resets it", takesArgs: true },
	{ name: "model", description: "select model for new sessions", rejectArgs: true },
	{ name: "credentials", description: "manage ChatGPT/API-key credentials" },
	{ name: "settings", description: "edit local settings" },
	{ name: "reasoning", description: "set default reasoning effort for new sessions", rejectArgs: true },
	{ name: "reload", description: "reload settings/auth caches" },
]

const SERVICE_CHAT_COMMANDS = [
	{ name: "help", description: "show service chat commands" },
	{ name: "hotkeys", description: "show hotkeys" },
	{ name: "web", description: `open this session in ${WEB_BROWSER_UI_NAME}` },
	{ name: "agent", description: "experimental: spawn/list/wait/resume/close hidden sub-agent sessions", takesArgs: true },
	{ name: "branch", description: "create a new session from the current conversation branch" },
	{ name: "rewind", description: "rewind to a previous user message or switch to a branch tip", rejectArgs: true },
	{ name: "session", description: "show current session details" },
	{ name: "model", description: "select model for this session", rejectArgs: true },
	{ name: "reasoning", description: "set reasoning effort for this session", rejectArgs: true },
	{ name: "fast", description: "set Codex Fast mode for this session: /fast on|off|status", takesArgs: true },
	{ name: "compact", description: "compact older conversation messages" },
	{ name: "context", description: "show context usage estimate" },
	{ name: "system", description: "show system prompt, tools, and project context" },
	{ name: "settings", description: "edit local settings" },
	{ name: "reload", description: "reload settings/auth caches" },
	{ name: "usage", description: "show ChatGPT/Codex usage limits" },
	{ name: "continue", description: "resume an interrupted turn, or ask the model to continue" },
	{ name: "abort", description: "abort the current turn" },
]

const commandsWithWebSetting = (commands, settings) => commands.filter((command) => command.name !== "web" || settings?.web === true)
const commandMap = (commands) => new Map(commands.map((command) => [command.name, command]))

export const isWebSlashCommand = (text) => /^\/web(?:\s|$)/.test(text.trim())

export function overviewCommands(settings) {
	return commandsWithWebSetting(OVERVIEW_COMMANDS, settings)
}

function serviceChatCommandMap(settings) {
	return commandMap(commandsWithWebSetting(SERVICE_CHAT_COMMANDS, settings))
}

export function serviceChatCommandsForModel(model, settings) {
	return commandsWithWebSetting(SERVICE_CHAT_COMMANDS, settings)
		.filter((command) => command.name !== "fast" || isFastModeEligibleModel(model))
}

const commandLineFor = (commands, text) => {
	const trimmed = text.trim()
	if (!trimmed.startsWith("/")) return null
	const commandLine = trimmed.slice(1).trim()
	const [name = "", ...rest] = commandLine.split(/\s+/)
	const command = commands.get(name)
	if (!command) return null
	// Parse old argument forms for interactive-only commands so the UI can reject them locally instead of sending them as prompts.
	if (rest.length > 0 && !command.takesArgs && !command.rejectArgs) return null
	return commandLine
}

/**
 * @param {string} text
 * @returns {string | null} command line without the leading slash, or null if it is not a known command
 */
export function overviewCommandLine(text, settings = undefined) {
	return commandLineFor(commandMap(overviewCommands(settings)), text)
}

/**
 * @param {string} text
 * @returns {string | null} command line without the leading slash, or null if it is not a known command
 */
export function serviceChatCommandLine(text, settings = undefined) {
	return commandLineFor(serviceChatCommandMap(settings), text)
}

export function sessionOpenCommand(sessionId) {
	return `cerex open ${routeToArg(sessionRoute(sessionId))}`
}

export function parseAgentSpawnArgs(arg) {
	const parts = arg.trim().split(/\s+/).filter(Boolean)
	const options = {}
	let i = 0
	while (i < parts.length) {
		const part = parts[i]
		if (part === "--name") {
			options.name = parts[i + 1]
			i += 2
			continue
		}
		if (part === "--fork-turns") {
			options.forkTurns = parts[i + 1]
			i += 2
			continue
		}
		break
	}
	const consumed = parts.slice(0, i).join(" ")
	const task = consumed ? arg.trim().slice(consumed.length).trim() : arg.trim()
	return { ...options, task }
}

export function subSessionLines(agents) {
	if (!agents?.length) return ["no sub-agents"]
	return agents.map((agent) => `${agent.name}  ${agent.status}  ${agent.childSessionId.slice(0, 8)}  ${agent.openCommand || sessionOpenCommand(agent.childSessionId)}`)
}

export function webUrlForRoute(web, route = overviewRoute) {
	if (!web?.url) return ""
	const url = new URL(web.url)
	const routeUrl = new URL(routeToArg(route), url)
	url.pathname = routeUrl.pathname
	url.searchParams.delete("model")
	for (const [key, value] of routeUrl.searchParams) url.searchParams.set(key, value)
	url.hash = routeUrl.hash
	return url.href
}

export async function webForOpening(client) {
	const status = await client.webStatus()
	const web = status.web?.running ? status.web : (await client.startWeb()).web
	if (!web?.url) throw new Error("web server did not return a URL")
	return web
}

export function commandHelpBody(commands, extraLines = []) {
	const width = Math.max(...commands.map((c) => c.name.length), 4)
	return [
		...commands.map((command) => `/${command.name.padEnd(width)}  ${command.description}`),
		...extraLines,
	].join("\n")
}

export async function showCodexUsageModal(tui, baseUrl, onPayload) {
	try {
		const payload = await fetchCodexUsage({ baseUrl })
		onPayload?.(payload)
		await showTextModal(tui, "ChatGPT/Codex usage", formatCodexUsage(payload).join("\n"))
	} catch (err) {
		await showTextModal(tui, "Usage error", String(err?.message ?? err))
	}
}

// /debug-log is intentionally client-local, like a browser DevTools console: it shows diagnostics produced by this TUI frontend process while it talks to the service and renders the UI. It is not the detached service log, and clearing it only clears this terminal client's in-memory buffer.
export async function showDebugLogModal(tui, stderrCapture, arg) {
	if (!stderrCapture) {
		await showTextModal(tui, "Debug log", "stderr capture not enabled")
		return
	}
	if (arg === "clear") {
		stderrCapture.clear()
		await showTextModal(tui, "Debug log", "debug log cleared")
		return
	}
	const entries = stderrCapture.entries()
	if (entries.length === 0) {
		await showTextModal(tui, "Debug log", "no stderr captured")
		return
	}
	await showTextModal(tui, "Debug log", entries.map((entry) => {
		const time = new Date(entry.time).toISOString().slice(11, 19)
		return `${time}  ${entry.text}`
	}).join("\n"))
}

export { rewindPromptActionItems }
