import { reasoningLevelLabel } from "../../../protocol/src/reasoning.js"
import { modelDisplayLabel } from "./model-display.js"
import { findModelEntry, parseModelRef } from "./models.js"
import { defaultModelRef } from "./settings.js"

/** @param {import("./settings.js").Settings | undefined} settings */
export function overviewModelLabel(settings) {
	const model = settings ? defaultModelRef(settings) : ""
	if (!model) return ""
	const entry = findModelEntry(settings.defaultModel, { providers: settings.providers })
	const parsed = parseModelRef(settings.defaultModel)
	return modelDisplayLabel({ id: entry?.id ?? parsed.id, provider: entry?.provider ?? parsed.provider }, entry)
}

/** @param {import("./settings.js").Settings | undefined} settings */
export function overviewModelStatus(settings) {
	const modelLabel = overviewModelLabel(settings)
	const reasoningLabel = reasoningLevelLabel(settings?.thinkingLevel)
	return {
		modelLabel,
		reasoningLabel,
		text: modelLabel ? `${modelLabel} │ reasoning:${reasoningLabel}` : "",
	}
}

/** @param {import("./settings.js").Settings | undefined} settings */
export function overviewModelStatusText(settings) {
	return overviewModelStatus(settings).text
}
