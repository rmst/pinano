/**
 * Small, UI-agnostic helpers for keeping a session snapshot current from the
 * service/web event stream. Snapshots remain the recovery/structural-change
 * boundary; hot-path streaming events should be cheap incremental updates.
 */

import { isResponsesCompactionBlock } from "../responses-compaction.js"

/** @param {any} content */
export function contentText(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((block) => {
			if (block?.type === "text") return block.text ?? ""
			if (isResponsesCompactionBlock(block)) return "─── earlier context compacted by provider ───"
			return ""
		})
		.join("")
}

/** @param {any} value */
function stableJson(value) {
	if (value === undefined) return ""
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

/** @param {any} message */
function messageLogicalKey(message) {
	if (!message) return ""
	return [
		message.role ?? "",
		message.timestamp ?? "",
		message.toolCallId ?? "",
		message.toolName ?? "",
		message.isError ?? "",
		message.stopReason ?? "",
		message.errorMessage ?? "",
		message.compaction ?? "",
		message.content ?? "",
	].map(stableJson).join("\u001f")
}

/** @param {any} message */
export function messageKey(message) {
	if (!message) return ""
	if (message.entryId) return `entry:${message.entryId}`
	if (message.messageId) return `message:${message.messageId}`
	return messageLogicalKey(message)
}

/** @param {any[] | undefined} messages @param {any} message */
export function hasMessage(messages, message) {
	const key = messageKey(message)
	return (messages ?? []).some((existing) => messageKey(existing) === key)
}

/** @param {any} snapshot */
export function cloneSessionSnapshot(snapshot) {
	return {
		...(snapshot ?? {}),
		messages: [...(snapshot?.messages ?? [])],
		contextMessages: Array.isArray(snapshot?.contextMessages) ? [...snapshot.contextMessages] : undefined,
		pendingToolCalls: Array.isArray(snapshot?.pendingToolCalls)
			? [...snapshot.pendingToolCalls]
			: [...(snapshot?.pendingToolCalls ?? [])],
		pendingToolCallDetails: [...(snapshot?.pendingToolCallDetails ?? [])],
		pendingUserMessages: [...(snapshot?.pendingUserMessages ?? [])],
	}
}

/** @param {any} snapshot @param {any} message */
function appendDisplayMessage(snapshot, message) {
	if (!message) return snapshot
	const messages = hasMessage(snapshot.messages, message)
		? snapshot.messages
		: [...(snapshot.messages ?? []), message]
	return { ...snapshot, messages }
}

/** @param {any} snapshot @param {any} message */
function appendMessage(snapshot, message) {
	if (!message) return snapshot
	const next = appendDisplayMessage(snapshot, message)
	const contextMessages = Array.isArray(snapshot.contextMessages)
		? hasMessage(snapshot.contextMessages, message)
			? snapshot.contextMessages
			: [...snapshot.contextMessages, message]
		: snapshot.contextMessages
	return { ...next, contextMessages }
}

/** @param {any} snapshot @param {any} message */
function removePendingUserMessage(snapshot, message) {
	if (!message || message.role !== "user") return snapshot
	const pendingUserMessages = (snapshot.pendingUserMessages ?? []).filter((item) => {
		const pending = item?.message ?? item
		if (pending?.messageId && message.messageId) return pending.messageId !== message.messageId
		return messageLogicalKey(pending) !== messageLogicalKey(message)
	})
	return pendingUserMessages.length === (snapshot.pendingUserMessages ?? []).length
		? snapshot
		: { ...snapshot, pendingUserMessages }
}

/**
 * Apply one authoritative event to a snapshot-shaped state object. This is
 * intentionally conservative: structural events such as compaction/tree
 * changes should still be followed by a fresh snapshot.
 * @param {any} snapshot
 * @param {any} event
 */
export function applySessionEvent(snapshot, event) {
	let next = cloneSessionSnapshot(snapshot)
	if (event?.sessionId && !next.sessionId) next.sessionId = event.sessionId
	if (event?.seq !== undefined) next.seq = event.seq
	if (event?.viewEpoch !== undefined) next.viewEpoch = event.viewEpoch
	if (!event?.type) return next

	switch (event.type) {
		case "agent_start":
			next.isStreaming = true
			next.errorMessage = undefined
			return next
		case "model_request_start":
			next.currentModelRequest = event.request
			next.isStreaming = true
			return next
		case "model_request_end":
			next.currentModelRequest = undefined
			return next
		case "message_start":
			if (event.message?.role === "assistant") {
				next.isStreaming = true
				next.streamingMessage = event.message
			} else if (event.message?.role === "user") next = removePendingUserMessage(next, event.message)
			return next
		case "message_update":
			if (event.message?.role === "assistant") {
				next.isStreaming = true
				next.streamingMessage = event.message
			}
			return next
		case "message_end": {
			if (!event.message) return next
			next = removePendingUserMessage(next, event.message)
			next = appendMessage(next, event.message)
			if (event.message.role === "assistant") next.streamingMessage = null
			return next
		}
		case "context_load":
			return appendDisplayMessage(next, event.message)
		case "tool_execution_start": {
			const id = event.toolCallId
			if (id && !next.pendingToolCalls.includes(id)) next.pendingToolCalls = [...next.pendingToolCalls, id]
			if (id && !next.pendingToolCallDetails.some((tool) => tool.id === id)) {
				next.pendingToolCallDetails = [...next.pendingToolCallDetails, { id, name: event.toolName, args: event.args }]
			}
			next.isStreaming = true
			return next
		}
		case "tool_execution_update": {
			const id = event.toolCallId
			if (!id) return next
			next.pendingToolCallDetails = next.pendingToolCallDetails.map((tool) =>
				tool.id === id ? { ...tool, name: event.toolName ?? tool.name, args: event.args ?? tool.args, partialResult: event.partialResult } : tool,
			)
			return next
		}
		case "tool_execution_end": {
			const id = event.toolCallId
			if (id) {
				next.pendingToolCalls = next.pendingToolCalls.filter((pendingId) => pendingId !== id)
				next.pendingToolCallDetails = next.pendingToolCallDetails.filter((tool) => tool.id !== id)
			}
			return next
		}
		case "agent_end":
			next.isStreaming = false
			next.streamingMessage = null
			next.currentModelRequest = undefined
			next.pendingToolCalls = []
			next.pendingToolCallDetails = []
			return next
		case "agent_view_metadata":
			if (event.metadata) next.agentView = event.metadata
			return next
		case "prompt_draft_update":
			if (event.draft) next.promptDraft = event.draft
			return next
		case "pending_user_messages_update":
			next.pendingUserMessages = [...(event.pendingUserMessages ?? [])]
			return next
		case "error":
			next.errorMessage = event.error ?? event.message ?? next.errorMessage
			next.isStreaming = false
			next.streamingMessage = null
			next.currentModelRequest = undefined
			next.pendingToolCalls = []
			next.pendingToolCallDetails = []
			return next
		default:
			return next
	}
}
