export function streamingContentProgress(message) {
	let chars = 0
	let textChars = 0
	if (Array.isArray(message?.content)) {
		for (const block of message.content) {
			if (block?.type === "text") {
				const len = String(block.text ?? "").length
				chars += len
				textChars += len
			} else if (block?.type === "thinking") chars += String(block.thinking ?? "").length
			else if (block?.type === "toolCall") {
				if (typeof block.input === "string") chars += block.input.length
				else if (typeof block.partialJson === "string") chars += block.partialJson.length
				else {
					try {
						chars += JSON.stringify(block.arguments ?? {}).length
					} catch {}
				}
			}
		}
	}
	return { chars, textChars }
}

/** @param {any} message */
export function streamingStatusBase(message) {
	return streamingContentProgress(message).textChars > 0 ? "Generating…" : "Thinking…"
}
