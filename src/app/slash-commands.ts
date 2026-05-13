// Slash command registry + dispatch.
//
// Commands are registered as `{ name, description, handler }`. When the user
// submits a line beginning with `/`, chat-mode parses the first whitespace-
// separated token as the command name and the rest as a free-form argument
// string. Handlers receive the ChatContext and can mutate UI/session/agent.

import type { ChatContext } from "./chat-mode.ts"

export interface SlashCommandHandler {
	(ctx: ChatContext, args: string): Promise<void> | void
}

export interface SlashCommand {
	name: string
	description: string
	handler: SlashCommandHandler
}

export class SlashCommandRegistry {
	private commands = new Map<string, SlashCommand>()

	register(cmd: SlashCommand): void {
		this.commands.set(cmd.name, cmd)
	}

	get(name: string): SlashCommand | undefined {
		return this.commands.get(name)
	}

	list(): SlashCommand[] {
		return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name))
	}
}

export async function dispatchSlashCommand(
	registry: SlashCommandRegistry,
	line: string,
	ctx: ChatContext,
): Promise<void> {
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
