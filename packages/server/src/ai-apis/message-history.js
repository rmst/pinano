function baseToolCallId(id) {
	return String(id ?? "").split("|")[0]
}

export function validateMessageHistory(messages) {
	const seenToolCallIds = new Set()
	for (const msg of messages ?? []) {
		if (msg?.role === "assistant") {
			for (const block of msg.content ?? []) {
				if (block?.type === "toolCall" && block.id) seenToolCallIds.add(baseToolCallId(block.id))
			}
		} else if (msg?.role === "toolResult") {
			const callId = baseToolCallId(msg.toolCallId)
			if (callId && !seenToolCallIds.has(callId)) {
				throw new Error(`Session integrity error: tool result has no preceding assistant tool call for call_id ${callId}`)
			}
		}
	}
}
