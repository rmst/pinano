// Pre-flight transforms applied to a Context.messages array before it
// is converted to an OpenAI-compatible provider request:
//   1. Normalize malformed image detail values from historical messages.
//   2. If the model has no image input, replace image blocks with a
//      placeholder text block.
//   3. If a previous assistant turn had tool calls but no matching tool
//      results follow, synthesize "no result" tool results so the API
//      doesn't reject the request.
//   4. Skip assistant messages with stopReason "error" or "aborted" —
//      they're incomplete turns that shouldn't be replayed.

import { isPromptImageMarkerText } from "../../../protocol/src/prompt-images.js"

const NON_VISION_USER_PLACEHOLDER = "(image omitted: model does not support images)"
const NON_VISION_TOOL_PLACEHOLDER = "(tool image omitted: model does not support images)"
const IMAGE_DETAILS = new Set(["auto", "low", "high", "original"])

function normalizeImageDetails(messages) {
	return messages.map((msg) => {
		if ((msg.role !== "user" && msg.role !== "toolResult") || !Array.isArray(msg.content)) return msg
		let changed = false
		const content = msg.content.map((block) => {
			if (block?.type !== "image" || block.detail == null || IMAGE_DETAILS.has(block.detail)) return block
			changed = true
			return { ...block, detail: "high" }
		})
		return changed ? { ...msg, content } : msg
	})
}

function replaceImagesWithPlaceholder(content, placeholder) {
	const result = []
	let prevWasPlaceholder = false
	for (const block of content) {
		if (block.type === "image") {
			if (!prevWasPlaceholder) result.push({ type: "text", text: placeholder })
			prevWasPlaceholder = true
			continue
		}
		if (block.type === "text" && isPromptImageMarkerText(block.text ?? "")) continue
		result.push(block)
		prevWasPlaceholder = block.type === "text" && block.text === placeholder
	}
	return result
}

function downgradeImages(messages, model) {
	const inputs = model.input ?? ["text"]
	if (inputs.includes("image")) return messages
	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return { ...msg, content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_PLACEHOLDER) }
		}
		if (msg.role === "toolResult") {
			return { ...msg, content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_PLACEHOLDER) }
		}
		return msg
	})
}

export function transformMessages(messages, model) {
	const downgraded = downgradeImages(normalizeImageDetails(messages), model)

	const out = []
	let pending = []
	let seenIds = new Set()

	const flushPending = () => {
		if (pending.length === 0) return
		for (const tc of pending) {
			if (!seenIds.has(tc.id)) {
				out.push({
					role: "toolResult",
					toolCallId: tc.id,
					toolName: tc.name,
					content: [{ type: "text", text: "No result provided" }],
					isError: true,
					timestamp: Date.now(),
				})
			}
		}
		pending = []
		seenIds = new Set()
	}

	for (const msg of downgraded) {
		if (msg.role === "assistant") {
			flushPending()
			if (msg.stopReason === "error" || msg.stopReason === "aborted") continue
			const toolCalls = msg.content.filter((b) => b.type === "toolCall")
			if (toolCalls.length > 0) {
				pending = toolCalls
				seenIds = new Set()
			}
			out.push(msg)
		} else if (msg.role === "toolResult") {
			seenIds.add(msg.toolCallId)
			out.push(msg)
		} else if (msg.role === "user") {
			flushPending()
			out.push(msg)
		} else {
			out.push(msg)
		}
	}

	flushPending()
	return out
}
