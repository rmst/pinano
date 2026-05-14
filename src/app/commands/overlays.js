// Slash commands backed by modal overlays or full-width inline selectors.

import { pickFromOverlay } from "../components/picker.js"
import { pickModel, rowsForModels } from "../components/model-selector.js"
import { pickSession } from "../components/session-selector.js"
import { promptForInput } from "../components/prompt-input.js"
import { theme } from "../theme.js"
import { availableModelEntries, modelRef, modelRefMatches, resolveModel } from "../models.js"
import { listSessions, loadSessionPreview } from "../session-store.js"
import { loadSettings, updateSetting } from "../settings.js"
import { setCredential } from "../auth.js"
import { authFilePath } from "../paths.js"
import { loginCodex } from "../../ai-apis/codex/index.js"

/** @typedef {import("../slash-commands.js").SlashCommand} SlashCommand */
/** @typedef {import("../components/session-selector.js").SessionRow} SessionRow */

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"]

/** @type {SlashCommand} */
export const modelCommand = {
	name: "model",
	description: "switch model",
	handler: async (ctx) => {
		const models = await availableModelEntries()
		if (models.length === 0) {
			ctx.appendLine(theme.dim("no authenticated models available; run /login first"))
			return
		}
		const settings = await loadSettings()
		const rows = rowsForModels(models, {
			currentId: ctx.agent.state.model.id,
			currentProvider: ctx.agent.state.model.provider,
			scopedModelIds: settings.scopedModelIds,
		})
		const chosen = await pickModel(ctx, rows, {
			initialSelectedValue: rows.find((r) => r.current)?.value,
		})
		if (!chosen) return
		// Preserve any --baseurl override from the CLI so e.g. local llamacpp
		// pointing at llamacpp.localhost survives a /model switch.
		ctx.agent.state.model = resolveModel(chosen, { baseUrl: ctx.baseUrlOverride })
		await updateSetting("model", chosen)
		ctx.appendLine(theme.dim(`switched to ${chosen}`))
	},
}

/** @type {SlashCommand} */
export const thinkingCommand = {
	name: "thinking",
	description: "switch reasoning level (off/minimal/low/medium/high)",
	handler: async (ctx, args) => {
		/** @type {string | null} */
		let next = args.trim() || null
		if (!next) {
			next = await pickFromOverlay(
				ctx.tui,
				THINKING_LEVELS.map((l) => ({ value: l, label: l })),
				{ maxVisible: 6, width: "30%", maxHeight: "30%" },
			)
		}
		if (!next) return
		if (!THINKING_LEVELS.includes(/** @type {any} */ (next))) {
			ctx.appendLine(theme.red(`unknown level: ${next}`))
			return
		}
		ctx.agent.state.thinkingLevel = /** @type {any} */ (next)
		await updateSetting("thinkingLevel", /** @type {any} */ (next))
		ctx.appendLine(theme.dim(`thinking level → ${next}`))
	},
}

/** @type {SlashCommand} */
export const scopedModelsCommand = {
	name: "scoped-models",
	description: "toggle which models cycle on Ctrl+P",
	handler: async (ctx) => {
		const settings = await loadSettings()
		const models = await availableModelEntries()
		if (models.length === 0) {
			ctx.appendLine(theme.dim("no authenticated models available; run /login first"))
			return
		}
		const rows = rowsForModels(models, {
			currentId: ctx.agent.state.model.id,
			currentProvider: ctx.agent.state.model.provider,
			scopedModelIds: settings.scopedModelIds,
		})
		const chosen = await pickModel(ctx, rows, { mode: "toggle" })
		if (!chosen) return
		const entry = models.find((m) => modelRef(m) === chosen)
		const next = entry && settings.scopedModelIds.some((id) => modelRefMatches(entry, id))
			? settings.scopedModelIds.filter((id) => !modelRefMatches(entry, id))
			: [...settings.scopedModelIds, chosen]
		await updateSetting("scopedModelIds", next)
		ctx.appendLine(theme.dim(`scoped models: ${next.join(", ") || "(empty)"}`))
	},
}

/** @type {SlashCommand} */
export const resumeCommand = {
	name: "resume",
	description: "resume a different session",
	handler: async (ctx) => {
		const list = await listSessions(process.cwd())
		if (list.length === 0) {
			ctx.appendLine(theme.dim("no sessions for this cwd"))
			return
		}
		const previews = await Promise.all(list.map((e) => loadSessionPreview(e.path)))
		/** @type {SessionRow[]} */
		const rows = list.map((e, i) => {
			const p = previews[i]
			return {
				value: e.id,
				shortId: e.id.slice(0, 8),
				name: e.name,
				current: e.id === ctx.sessionId,
				firstTimestamp: p.first?.timestamp,
				firstText: p.first?.text,
				lastUserTimestamp: p.lastUser?.timestamp,
				lastUserText: p.lastUser?.text,
			}
		})
		const chosen = await pickSession(ctx, rows, { initialSelectedValue: ctx.sessionId })
		if (!chosen || chosen === ctx.sessionId) return
		await ctx.switchSession(chosen)
	},
}

/** @type {SlashCommand} */
export const loginCommand = {
	name: "login",
	description: "configure provider authentication",
	handler: async (ctx, args) => {
		const choices = [
			{ value: "openai", label: "OpenAI", description: "API key (sk-...)" },
			{ value: "openai-codex", label: "Codex (ChatGPT subscription)", description: "OAuth flow via browser" },
		]
		const provider = args.trim() || (await pickFromOverlay(ctx.tui, choices))
		if (!provider) return

		if (provider === "openai") {
			ctx.appendLine(theme.dim("Paste your OpenAI API key (sk-...) and press Enter:"))
			const key = await promptForInput(ctx.tui, "OpenAI API key")
			if (!key) {
				ctx.appendLine(theme.dim("login cancelled"))
				return
			}
			await setCredential("openai", { kind: "apiKey", apiKey: key.trim(), createdAt: Date.now() })
			ctx.appendLine(theme.dim(`Saved API key to ${authFilePath("openai")}`))
			return
		}

		if (provider === "openai-codex") {
			ctx.appendLine(theme.dim("Starting Codex OAuth flow — open the URL in your browser when prompted."))
			try {
				const credentials = await loginCodex({
					onAuth: ({ url }) => {
						ctx.appendLine(theme.cyan(`Open: ${url}`))
					},
				})
				await setCredential("openai-codex", {
					kind: "codex",
					access: credentials.access,
					refresh: credentials.refresh,
					idToken: (/** @type {any} */ (credentials)).idToken,
					accountId: credentials.accountId,
					expiresAt: credentials.expires,
					createdAt: Date.now(),
				})
				ctx.appendLine(theme.dim(`Saved Codex credentials to ${authFilePath("openai-codex")}`))
			} catch (err) {
				ctx.appendLine(theme.red(`login failed: ${err?.message ?? err}`))
			}
			return
		}

		ctx.appendLine(theme.red(`unknown provider: ${provider}`))
	},
}

/**
 * /settings — overlay UI to view and edit settings.json. Each row shows the
 * current value; selecting a row opens the appropriate sub-picker (or a text
 * prompt for free-form numeric/string values). Cancelling at any level
 * returns to the top-level list so users can review multiple keys.
 * @type {SlashCommand}
 */
export const settingsCommand = {
	name: "settings",
	description: "view and edit pinano settings",
	handler: async (ctx) => {
		while (true) {
			const settings = await loadSettings()
			const rows = [
				{
					value: "model",
					label: `model: ${settings.model}`,
					description: "default model id",
				},
				{
					value: "thinkingLevel",
					label: `thinking: ${settings.thinkingLevel}`,
					description: "reasoning effort",
				},
				{
					value: "autoResume",
					label: `autoResume: ${settings.autoResume ? "on" : "off"}`,
					description: "open most-recent session for cwd at startup",
				},
				{
					value: "autocompactThreshold",
					label: `autocompactThreshold: ${settings.autocompactThreshold}`,
					description: "fraction of context window before auto-compaction",
				},
				{
					value: "scopedModelIds",
					label: `scopedModelIds: ${settings.scopedModelIds.length} model(s)`,
					description: "models that cycle on Ctrl+P",
				},
				{
					value: "doubleEscapeAction",
					label: `doubleEscapeAction: ${settings.doubleEscapeAction}`,
					description: "Esc Esc on empty editor → tree picker, fork picker, or disabled",
				},
			]
			const choice = await pickFromOverlay(ctx.tui, rows)
			if (!choice) return

			if (choice === "model") {
				await modelCommand.handler(ctx, "")
				continue
			}
			if (choice === "thinkingLevel") {
				await thinkingCommand.handler(ctx, "")
				continue
			}
			if (choice === "scopedModelIds") {
				await scopedModelsCommand.handler(ctx, "")
				continue
			}
			if (choice === "autoResume") {
				const next = !settings.autoResume
				await updateSetting("autoResume", next)
				ctx.appendLine(theme.dim(`autoResume → ${next ? "on" : "off"}`))
				continue
			}
			if (choice === "doubleEscapeAction") {
				const order = ["tree", "fork", "none"]
				const cur = order.indexOf(settings.doubleEscapeAction)
				const next = order[(cur + 1) % order.length]
				await updateSetting("doubleEscapeAction", /** @type {any} */ (next))
				ctx.appendLine(theme.dim(`doubleEscapeAction → ${next}`))
				continue
			}
			if (choice === "autocompactThreshold") {
				ctx.appendLine(theme.dim(`Enter a value between 0.0 and 1.0 (current: ${settings.autocompactThreshold}):`))
				const raw = await promptForInput(ctx.tui, "autocompactThreshold")
				if (raw == null) continue
				const parsed = Number(raw.trim())
				if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
					ctx.appendLine(theme.red(`invalid value: ${raw}`))
					continue
				}
				await updateSetting("autocompactThreshold", parsed)
				ctx.appendLine(theme.dim(`autocompactThreshold → ${parsed}`))
				continue
			}
		}
	},
}

/** @param {{ register: (cmd: SlashCommand) => void }} registry */
export function registerOverlayCommands(registry) {
	for (const c of [modelCommand, thinkingCommand, scopedModelsCommand, resumeCommand, loginCommand, settingsCommand]) {
		registry.register(c)
	}
}
