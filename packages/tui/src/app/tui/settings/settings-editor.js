import { reasoningLevelLabel } from "../../../../../protocol/src/reasoning.js"
import { pickModel, rowsForModels } from "../../components/model-selector.js"
import { pickFromOverlay } from "../../components/picker.js"
import { availableModelEntries } from "../../../../../server/src/app/model/registry.js"
import { loadSettings, updateSetting } from "../../../../../server/src/app/settings.js"
import { WEB_BROWSER_UI_NAME } from "../../../../../protocol/src/web-branding.js"
import { showCredentialsSettings } from "./credentials-modal.js"
import { currentDefaultModelRef, pickReasoningLevel, updateDefaultModel } from "./model-preferences.js"

export async function showSettingsEditor(ctx, { notify, onSettingsChanged, setDefaultModel, setDefaultReasoning, refreshAuthCache } = {}) {
	const write = notify ?? (() => {})
	while (true) {
		const settings = await loadSettings()
		const choice = await pickFromOverlay(ctx.tui, [
			{ value: "credentials", label: "credentials", description: "manage ChatGPT subscription OAuth and API keys" },
			{ value: "model", label: `model: ${currentDefaultModelRef(settings)}`, description: "default model for new sessions" },
			{ value: "thinkingLevel", label: `reasoning: ${reasoningLevelLabel(settings.thinkingLevel)}`, description: "default reasoning effort for new sessions" },
			{ value: "web", label: `web: ${settings.web ? "on" : "off"}`, description: `enable ${WEB_BROWSER_UI_NAME} CLI and /web commands` },
			{ value: "updateCheck", label: `updateCheck: ${settings.updateCheck ? "on" : "off"}`, description: "check GitHub once per day for new Cerex releases" },
		])
		if (!choice) return
		if (choice === "credentials") {
			await showCredentialsSettings(ctx.tui, { refreshAuthCache, onSettingsChanged, setDefaultModel })
			continue
		}
		if (choice === "model") {
			const models = await availableModelEntries(settings)
			if (models.length === 0) {
				write("no authenticated models available; open /settings and choose credentials first")
				continue
			}
			const current = currentDefaultModelRef(settings)
			const rows = rowsForModels(models, { currentId: current })
			const chosen = await pickModel(ctx, rows, { initialSelectedValue: current, title: "Default model", subtitle: "Pick the default model for new sessions." }) ?? ""
			if (!chosen) continue
			const updated = await setDefaultModel?.(chosen) ?? await updateDefaultModel(chosen, settings)
			await onSettingsChanged?.(updated)
			write(`default model → ${chosen}`)
			continue
		}
		if (choice === "thinkingLevel") {
			const level = await pickReasoningLevel(ctx.tui, "Default reasoning", "Applied to new sessions")
			if (!level) continue
			const updated = await setDefaultReasoning?.(level) ?? await updateSetting("thinkingLevel", /** @type {any} */ (level))
			await onSettingsChanged?.(updated)
			write(`default reasoning → ${level}`)
			continue
		}
		if (choice === "web") {
			const next = !settings.web
			const updated = await updateSetting("web", next)
			await onSettingsChanged?.(updated)
			write(`web → ${next ? "on" : "off"}`)
			continue
		}
		if (choice === "updateCheck") {
			const next = !settings.updateCheck
			const updated = await updateSetting("updateCheck", next)
			await onSettingsChanged?.(updated)
			write(`updateCheck → ${next ? "on" : "off"}`)
			continue
		}
	}
}
