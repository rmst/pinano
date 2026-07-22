// Helpers for stored OpenAI Responses native compaction items.
//
// Explicit remote-v2 compaction and older implicit Responses compaction both
// produce opaque provider-native output items. Keep those items verbatim for
// replay while rendering a friendly marker instead of encrypted payloads.

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

/** @param {ReadonlyArray<any>} contextMessages @param {ReadonlyArray<any>} messages */
export function insertContextAfterLatestResponsesCompaction(contextMessages, messages) {
	const context = contextMessages.filter(Boolean)
	if (context.length === 0) return [...messages]

	let latest = -1
	for (let i = 0; i < messages.length; i++) {
		if (messageHasResponsesCompactionItem(messages[i])) latest = i
	}
	if (latest < 0) return [...context, ...messages]
	return [
		...messages.slice(0, latest + 1),
		...context,
		...messages.slice(latest + 1),
	]
}
