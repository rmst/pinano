import { REASONING_LEVELS, reasoningLevelLabel } from "../../../../../protocol/src/reasoning.js"
import { pickFromOverlay } from "../../components/picker.js"
import { canonicalModelRef, parseModelRef } from "../../../../../server/src/app/models.js"
import { defaultModelRef, loadSettings, updateSettings } from "../../../../../server/src/app/settings.js"

/** @param {import("../../../../../server/src/app/settings.js").Settings | undefined} settings */
export function currentDefaultModelRef(settings) {
	return settings ? defaultModelRef(settings) : ""
}

/**
 * @param {string} ref
 * @param {import("../../../../../server/src/app/settings.js").Settings | undefined} [settings]
 */
export async function updateDefaultModel(ref, settings = undefined) {
	const current = settings ?? await loadSettings()
	const currentProvider = parseModelRef(current.defaultModel).provider
	return updateSettings({ defaultModel: canonicalModelRef(ref, { provider: currentProvider, providers: current.providers }) })
}

const reasoningLevelItems = () => REASONING_LEVELS.map((level) => ({
	value: level,
	label: level,
	description: {
		default: "use the model/provider default",
		none: "disable reasoning when the model supports it",
		minimal: "very small reasoning budget",
		low: "efficient tool-use and planning",
		medium: "balanced reasoning budget",
		high: "hard reasoning and complex debugging",
		xhigh: "very long rollouts; highest latency/cost",
		max: "maximum reasoning depth",
	}[level] ?? "",
}))

export function pickReasoningLevel(tui, title = "Reasoning", subtitle = "Select reasoning effort") {
	return pickFromOverlay(tui, reasoningLevelItems(), {
		title,
		subtitle,
		maxVisible: reasoningLevelItems().length,
		width: "72%",
		maxHeight: "60%",
	})
}

export async function reloadUiSettingsAndAuth({ notify, onSettingsChanged, refreshAuthCache }) {
	const settings = await loadSettings()
	await onSettingsChanged?.(settings)
	await refreshAuthCache?.()
	notify(`reloaded — model=${currentDefaultModelRef(settings)} reasoning=${reasoningLevelLabel(settings.thinkingLevel)}`)
}
