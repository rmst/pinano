import { compact } from "../compaction.js"
import { theme } from "../theme.js"

/** @typedef {import("../slash-commands.js").SlashCommand} SlashCommand */

/** @type {SlashCommand} */
export const compactCommand = {
	name: "compact",
	description: "summarize older messages into a single compaction note (manual)",
	handler: async (ctx) => {
		ctx.appendLine(theme.dim("compacting…"))
		try {
			const r = await compact(ctx.agent)
			if (r.removedCount === 0) {
				ctx.appendLine(theme.dim("nothing to compact yet"))
				return
			}
			ctx.appendLine(theme.dim(`compacted ${r.removedCount} message(s) (~${r.tokensBefore} tok). Kept last ${r.keptCount}.`))
		} catch (err) {
			ctx.appendLine(theme.red(`compact failed: ${err?.message ?? err}`))
		}
	},
}
