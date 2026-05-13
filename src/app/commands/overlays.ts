// Overlay-driven slash commands: /model, /thinking, /resume, /login,
// /scoped-models. Each opens a SelectList overlay and applies the choice.

import type { SlashCommand } from "../slash-commands.ts"
import { pickFromOverlay } from "../components/picker.ts"
import { pickSession } from "../components/session-selector.ts"
import type { SessionRow } from "../components/session-selector.ts"
import { promptForInput } from "../components/prompt-input.ts"
import { theme } from "../theme.ts"
import { MODEL_REGISTRY, resolveModel } from "../models.ts"
import { listSessions, loadSessionPreview } from "../session-store.ts"
import { loadSettings, updateSetting } from "../settings.ts"
import { setCredential } from "../auth.ts"
import { authFilePath } from "../paths.ts"
import { loginCodex } from "../../ai-apis/codex/index.js"

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const

export const modelCommand: SlashCommand = {
	name: "model",
	description: "switch model",
	handler: async (ctx) => {
		const items = MODEL_REGISTRY.map((m) => ({
			value: m.id,
			label: `${m.id}${m.tags?.length ? ` (${m.tags.join(", ")})` : ""}`,
			description: m.displayName,
		}))
		const chosen = await pickFromOverlay(ctx.tui, items)
		if (!chosen) return
		// Preserve any --baseurl override from the CLI so e.g. local llamacpp
		// pointing at llamacpp.localhost survives a /model switch.
		ctx.agent.state.model = resolveModel(chosen, { baseUrl: ctx.baseUrlOverride })
		await updateSetting("model", chosen)
		ctx.appendLine(theme.dim(`switched to ${chosen}`))
	},
}

export const thinkingCommand: SlashCommand = {
	name: "thinking",
	description: "switch reasoning level (off/minimal/low/medium/high)",
	handler: async (ctx, args) => {
		let next: string | null = args.trim() || null
		if (!next) {
			next = await pickFromOverlay(
				ctx.tui,
				THINKING_LEVELS.map((l) => ({ value: l, label: l })),
				{ maxVisible: 6, width: "30%", maxHeight: "30%" },
			)
		}
		if (!next) return
		if (!THINKING_LEVELS.includes(next as any)) {
			ctx.appendLine(theme.red(`unknown level: ${next}`))
			return
		}
		ctx.agent.state.thinkingLevel = next as any
		await updateSetting("thinkingLevel", next as any)
		ctx.appendLine(theme.dim(`thinking level → ${next}`))
	},
}

export const scopedModelsCommand: SlashCommand = {
	name: "scoped-models",
	description: "toggle which models cycle on Ctrl+P",
	handler: async (ctx) => {
		const settings = await loadSettings()
		const items = MODEL_REGISTRY.map((m) => ({
			value: m.id,
			label: `${settings.scopedModelIds.includes(m.id) ? "[x]" : "[ ]"} ${m.id}`,
			description: m.displayName,
		}))
		const chosen = await pickFromOverlay(ctx.tui, items)
		if (!chosen) return
		const next = settings.scopedModelIds.includes(chosen)
			? settings.scopedModelIds.filter((id) => id !== chosen)
			: [...settings.scopedModelIds, chosen]
		await updateSetting("scopedModelIds", next)
		ctx.appendLine(theme.dim(`scoped models: ${next.join(", ") || "(empty)"}`))
	},
}

export const resumeCommand: SlashCommand = {
	name: "resume",
	description: "resume a different session",
	handler: async (ctx) => {
		const list = await listSessions(process.cwd())
		if (list.length === 0) {
			ctx.appendLine(theme.dim("no sessions for this cwd"))
			return
		}
		const previews = await Promise.all(list.map((e) => loadSessionPreview(e.path)))
		const rows: SessionRow[] = list.map((e, i) => {
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

export const loginCommand: SlashCommand = {
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
					onAuth: ({ url }: { url: string }) => {
						ctx.appendLine(theme.cyan(`Open: ${url}`))
					},
				})
				await setCredential("openai-codex", {
					kind: "codex",
					access: credentials.access,
					refresh: credentials.refresh,
					idToken: (credentials as any).idToken,
					accountId: credentials.accountId,
					expiresAt: credentials.expires,
					createdAt: Date.now(),
				})
				ctx.appendLine(theme.dim(`Saved Codex credentials to ${authFilePath("openai-codex")}`))
			} catch (err: any) {
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
 */
export const settingsCommand: SlashCommand = {
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
				const order = ["tree", "fork", "none"] as const
				const cur = order.indexOf(settings.doubleEscapeAction)
				const next = order[(cur + 1) % order.length]!
				await updateSetting("doubleEscapeAction", next)
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

export function registerOverlayCommands(registry: { register: (cmd: SlashCommand) => void }) {
	for (const c of [modelCommand, thinkingCommand, scopedModelsCommand, resumeCommand, loginCommand, settingsCommand]) {
		registry.register(c)
	}
}
