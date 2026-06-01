// Helpers for OpenAI Responses native compaction.
//
// Server-side Responses compaction emits opaque provider-native output items.
// They are not user-displayable, but must be replayed verbatim in later
// Responses requests. We store them as assistant content blocks so they remain
// attached to the durable assistant turn while the transcript renderer can show
// a friendly marker instead of encrypted payloads.

export const RESPONSES_NATIVE_ITEM_BLOCK = "responsesItem"

const NATIVE_COMPACTION_TYPES = new Set(["compaction", "compaction_summary", "context_compaction"])

/** @param {any} item */
export function isResponsesCompactionItem(item) {
	return item && NATIVE_COMPACTION_TYPES.has(item.type)
}

/** @param {any} block */
export function isResponsesNativeItemBlock(block) {
	return block?.type === RESPONSES_NATIVE_ITEM_BLOCK && block.item
}

/** @param {any} block */
export function isResponsesCompactionBlock(block) {
	return isResponsesNativeItemBlock(block) && isResponsesCompactionItem(block.item)
}

/** @param {any} item */
export function responsesNativeItemBlock(item) {
	return { type: RESPONSES_NATIVE_ITEM_BLOCK, item }
}

/** @param {any} message */
export function messageHasResponsesCompactionItem(message) {
	return Array.isArray(message?.content) && message.content.some(isResponsesCompactionBlock)
}

/**
 * Server-side Responses compaction is enabled as part of ordinary streaming
 * calls. Keep this model-level and conservative: local explicit /compact still
 * works everywhere, but implicit compaction requires a Responses-native
 * transport that can replay opaque compaction output items.
 * @param {any} model
 */
export function supportsImplicitResponsesCompaction(model) {
	return model?.compaction?.implicitResponses === true
}

/** @param {any} model */
export function disableImplicitResponsesCompaction(model) {
	if (!model) return
	model.compaction = { ...(model.compaction ?? {}), implicitResponses: false }
}

/** @param {unknown} error */
export function isUnsupportedImplicitResponsesCompactionError(error) {
	const message = error instanceof Error ? error.message : String(error ?? "")
	return /context_management|compact_threshold|unknown parameter|unsupported.*compaction|compaction.*unsupported/i.test(message)
}

/** @param {any} model @param {number | undefined} thresholdRatio */
export function responsesCompactThreshold(model, thresholdRatio) {
	const window = model?.contextWindow ?? 0
	if (!window) return undefined
	const ratio = Number.isFinite(thresholdRatio) ? thresholdRatio : 0.85
	return Math.max(1, Math.floor(window * ratio))
}
