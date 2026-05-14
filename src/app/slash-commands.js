// Slash command registry + dispatch.
//
// Commands are registered as `{ name, description, handler }`. When the user
// submits a line beginning with `/`, chat-mode parses the first whitespace-
// separated token as the command name and the rest as a free-form argument
// string. Handlers receive the ChatContext and can mutate UI/session/agent.

/** @typedef {import("./chat-mode.js").ChatContext} ChatContext */

/**
 * @callback SlashCommandHandler
 * @param {ChatContext} ctx
 * @param {string} args
 * @returns {Promise<void> | void}
 */

/**
 * @typedef {object} SlashCommand
 * @property {string} name
 * @property {string} description
 * @property {SlashCommandHandler} handler
 */

export class SlashCommandRegistry {
	/** @type {Map<string, SlashCommand>} */
	commands = new Map()

	/**
	 * @param {SlashCommand} cmd
	 * @returns {void}
	 */
	register(cmd) {
		this.commands.set(cmd.name, cmd)
	}

	/**
	 * @param {string} name
	 * @returns {SlashCommand | undefined}
	 */
	get(name) {
		return this.commands.get(name)
	}

	/** @returns {SlashCommand[]} */
	list() {
		return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name))
	}
}

/**
 * @param {SlashCommandRegistry} registry
 * @param {string} line
 * @param {ChatContext} ctx
 * @returns {Promise<void>}
 */
export async function dispatchSlashCommand(registry, line, ctx) {
	const trimmed = line.trim()
	if (!trimmed) return
	const spaceIdx = trimmed.search(/\s/)
	const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
	const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim()

	const cmd = registry.get(name)
	if (!cmd) {
		ctx.appendLine(`unknown command: /${name} — try /help`)
		return
	}
	await cmd.handler(ctx, args)
}
