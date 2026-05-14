// Simple slash commands that don't need an overlay. Each is a small handler
// over ChatContext. Overlay-driven commands (model, thinking, login, resume)
// live in commands/overlays.ts.

import { spawn } from "node:child_process"

import { theme } from "../theme.js"
import {
	deleteSession,
	listSessions,
	newSessionForCwd,
	rebuildIndex,
	setSessionName,
} from "../session-store.js"
import { loadSettings } from "../settings.js"
import { deleteCredential, listProviders } from "../auth.js"
import { ensureProjectContextMessage, isProjectContextMessage } from "../project-context.js"
import { LAZY_NOTICE_HEADING } from "../lazy-context.js"

/** @typedef {import("../slash-commands.js").SlashCommand} SlashCommand */

const APP_NAME = "pinano"

/** @type {SlashCommand} */
export const quitCommand = {
	name: "quit",
	description: `quit ${APP_NAME}`,
	handler: (ctx) => {
		ctx.requestExit(0)
	},
}

/** @type {SlashCommand} */
export const exitCommand = {
	name: "exit",
	description: `quit ${APP_NAME}`,
	handler: quitCommand.handler,
}

/** @type {SlashCommand} */
export const clearCommand = {
	name: "clear",
	description: "clear the on-screen transcript (does NOT touch the session)",
	handler: (ctx) => {
		ctx.clearTranscript()
		ctx.appendLine(theme.dim("(transcript cleared — session history preserved)"))
	},
}

/** @type {SlashCommand} */
export const newCommand = {
	name: "new",
	description: "start a new session in this cwd",
	handler: async (ctx) => {
		const { session, id } = await newSessionForCwd(process.cwd())
		await ensureProjectContextMessage(session, process.cwd())
		ctx.useSession(session, id)
		ctx.appendLine(theme.dim(`new session ${id.slice(0, 8)}`))
	},
}

/** @type {SlashCommand} */
export const sessionCommand = {
	name: "session",
	description: "show info about the current session",
	handler: async (ctx) => {
		const meta = ctx.session.getMetadata()
		const messages = ctx.session.getMessages().filter((m) => !isProjectContextMessage(m))
		const name = ctx.session.getSessionName()
		ctx.appendLine(theme.dim("--- session"))
		ctx.appendLine(`  id:        ${ctx.sessionId}`)
		if (name) ctx.appendLine(`  name:      ${name}`)
		ctx.appendLine(`  cwd:       ${meta.cwd}`)
		ctx.appendLine(`  created:   ${meta.createdAt}`)
		ctx.appendLine(`  messages:  ${messages.length}`)
	},
}

/** @type {SlashCommand} */
export const nameCommand = {
	name: "name",
	description: "set the session display name",
	handler: async (ctx, args) => {
		if (!args) {
			ctx.appendLine(theme.dim("usage: /name <new name>"))
			return
		}
		await ctx.session.appendSessionName(args)
		await setSessionName(ctx.sessionId, args)
		ctx.appendLine(theme.dim(`session renamed to: ${args}`))
	},
}

/** @type {SlashCommand} */
export const helpCommand = {
	name: "help",
	description: "show available slash commands",
	handler: async (ctx) => {
		const cmds = ctx.commands?.list() ?? []
		ctx.appendLine(theme.dim("--- commands"))
		const width = Math.max(...cmds.map((c) => c.name.length), 4)
		for (const c of cmds) {
			ctx.appendLine(`  /${c.name.padEnd(width)}  ${c.description}`)
		}
	},
}

/** @type {SlashCommand} */
export const hotkeysCommand = {
	name: "hotkeys",
	description: "show keyboard shortcuts",
	handler: (ctx) => {
		ctx.appendLine(theme.dim("--- hotkeys"))
		ctx.appendLine("  Enter         submit prompt")
		ctx.appendLine("  Shift+Enter   newline in prompt")
		ctx.appendLine("  Ctrl+C        abort run if streaming, exit otherwise")
		ctx.appendLine("  Ctrl+L        clear transcript")
		ctx.appendLine("  Ctrl+P        cycle through scoped models")
		ctx.appendLine("  Tab           accept autocomplete suggestion")
		ctx.appendLine("  Up/Down       browse prompt history")
		ctx.appendLine("  /<name>       run slash command")
	},
}

/** @type {SlashCommand} */
export const reloadCommand = {
	name: "reload",
	description: "rebuild session index, reload settings",
	handler: async (ctx) => {
		await rebuildIndex()
		const s = await loadSettings()
		ctx.appendLine(theme.dim(`reloaded — model=${s.model} thinking=${s.thinkingLevel}`))
	},
}

/** @type {SlashCommand} */
export const copyCommand = {
	name: "copy",
	description: "copy last assistant message to clipboard (osc52)",
	handler: (ctx) => {
		const last = [...ctx.agent.state.messages].reverse().find((m) => m.role === "assistant")
		if (!last) {
			ctx.appendLine(theme.dim("no assistant message yet"))
			return
		}
		const text = (/** @type {any} */ (last)).content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n")
		// OSC 52 clipboard escape — works on most modern terminals.
		process.stdout.write(`\x1b]52;c;${Buffer.from(text, "utf-8").toString("base64")}\x07`)
		ctx.appendLine(theme.dim(`copied ${text.length} chars to clipboard`))
	},
}

/** @type {SlashCommand} */
export const logoutCommand = {
	name: "logout",
	description: "delete a stored auth credential (defaults to current model's provider)",
	handler: async (ctx, args) => {
		const provider = args || ctx.agent.state.model.provider
		const known = await listProviders()
		if (!known.includes(provider)) {
			ctx.appendLine(theme.dim(`no credential found for ${provider}`))
			return
		}
		await deleteCredential(provider)
		ctx.appendLine(theme.dim(`removed credential for ${provider}`))
	},
}

/** @type {SlashCommand} */
export const cwdCommand = {
	name: "cwd",
	description: "print current working directory",
	handler: (ctx) => {
		ctx.appendLine(theme.dim(process.cwd()))
	},
}

/** @type {SlashCommand} */
export const systemCommand = {
	name: "system",
	description: "print the current system prompt and tool definitions",
	handler: (ctx) => {
		const prompt = (ctx.agent.state.systemPrompt ?? "").toString()
		ctx.appendLine(theme.dim("--- system prompt"))
		if (prompt) {
			for (const line of prompt.split("\n")) ctx.appendLine(line)
			ctx.appendLine(theme.dim(`--- end system prompt (${prompt.length} chars)`))
		} else {
			ctx.appendLine(theme.dim("(empty)"))
		}

		const tools = ctx.agent.state.tools ?? []
		ctx.appendLine("")
		ctx.appendLine(theme.dim(`--- tools (${tools.length})`))
		for (const tool of tools) {
			ctx.appendLine(`## ${tool.name}`)
			if (tool.description) ctx.appendLine(`description: ${tool.description}`)
			if (tool.parameters !== undefined) {
				ctx.appendLine("parameters:")
				const json = JSON.stringify(tool.parameters, null, 2)
				for (const line of json.split("\n")) ctx.appendLine(`  ${line}`)
			}
			ctx.appendLine("")
		}
		ctx.appendLine(theme.dim("--- end tools"))

		// AGENTS.md / CLAUDE.md context — lives as a synthetic user message
		// (startup) and as appended text blocks on tool_result messages
		// (lazy subdir loads). Surface both so the user can see what the
		// model is actually receiving as project context.
		const messages = ctx.agent.state.messages ?? []
		/** @type {string[]} */
		const ctxBlocks = []
		for (const m of messages) {
			if (isProjectContextMessage(m)) {
				const text = Array.isArray(m.content)
					? m.content.filter((c) => c?.type === "text").map((c) => c.text).join("")
					: String(m.content ?? "")
				if (text) ctxBlocks.push(text)
				continue
			}
			if (m?.role === "toolResult" && Array.isArray(m.content)) {
				for (const block of m.content) {
					if (block?.type === "text" && typeof block.text === "string" && block.text.includes(LAZY_NOTICE_HEADING)) {
						ctxBlocks.push(block.text)
					}
				}
			}
		}
		ctx.appendLine("")
		ctx.appendLine(theme.dim(`--- project context (${ctxBlocks.length} block${ctxBlocks.length === 1 ? "" : "s"})`))
		if (ctxBlocks.length === 0) {
			ctx.appendLine(theme.dim("(no AGENTS.md / CLAUDE.md loaded)"))
		} else {
			for (const block of ctxBlocks) {
				for (const line of block.split("\n")) ctx.appendLine(line)
				ctx.appendLine("")
			}
		}
		ctx.appendLine(theme.dim("--- end project context"))
	},
}

/** @type {SlashCommand} */
export const logCommand = {
	name: "log",
	description: "show captured stderr (errors hidden by the TUI). `/log clear` to reset",
	handler: (ctx, args) => {
		const capture = ctx.stderrCapture
		if (!capture) {
			ctx.appendLine(theme.dim("stderr capture not enabled"))
			return
		}
		if (args.trim() === "clear") {
			capture.clear()
			ctx.appendLine(theme.dim("stderr log cleared"))
			return
		}
		const entries = capture.entries()
		if (entries.length === 0) {
			ctx.appendLine(theme.dim("no stderr captured"))
			return
		}
		ctx.appendLine(theme.dim(`--- stderr (${entries.length} lines)`))
		for (const e of entries) {
			const t = new Date(e.time).toISOString().slice(11, 19)
			ctx.appendLine(`${theme.dim(t)}  ${theme.red(e.text)}`)
		}
	},
}

/** @type {SlashCommand} */
export const sessionsCommand = {
	name: "sessions",
	description: "list sessions for the current cwd",
	handler: async (ctx) => {
		const list = await listSessions(process.cwd())
		if (list.length === 0) {
			ctx.appendLine(theme.dim("no sessions for this cwd yet"))
			return
		}
		ctx.appendLine(theme.dim(`--- sessions (${list.length})`))
		for (const e of list) {
			const marker = e.id === ctx.sessionId ? "*" : " "
			ctx.appendLine(`${marker} ${e.id.slice(0, 8)}  ${e.updatedAt}  ${e.name ?? ""}`)
		}
	},
}

void spawn // reserved for /open-in-editor etc.

/**
 * Convenience: register all simple commands into a registry.
 * @param {{ register: (cmd: SlashCommand) => void }} registry
 * @returns {void}
 */
export function registerSimpleCommands(registry) {
	for (const cmd of [
		quitCommand,
		exitCommand,
		clearCommand,
		newCommand,
		sessionCommand,
		nameCommand,
		helpCommand,
		hotkeysCommand,
		reloadCommand,
		copyCommand,
		logoutCommand,
		cwdCommand,
		systemCommand,
		sessionsCommand,
		logCommand,
	]) {
		registry.register(cmd)
	}
}
