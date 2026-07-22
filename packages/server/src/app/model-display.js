/**
 * @param {{ id?: string, provider?: string }} model
 * @param {{ displayName?: string, provider?: string }} [entry]
 */
export function modelDisplayLabel(model, entry = undefined) {
	const label = entry?.displayName ?? model?.id ?? ""
	const provider = entry?.provider ?? model?.provider
	if (provider !== "openai-codex") return label
	if (/\(subscription\)$/i.test(label)) return label
	if (/\(Codex\)$/i.test(label)) return label.replace(/\s*\(Codex\)$/i, " (subscription)")
	return label ? `${label} (subscription)` : label
}
