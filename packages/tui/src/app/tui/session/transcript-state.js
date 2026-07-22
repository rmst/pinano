import { createHash } from "node:crypto"

import { isProjectContextMessage } from "../../../../../server/src/app/project-context.js"
import { cloneSessionSnapshot } from "../../../../../server/src/app/session-state.js"

export function flattenContent(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text ?? "")
		.join("")
}

/** @param {any} msg */
export function isTranscriptMessageRenderable(msg) {
	return !!msg && !isProjectContextMessage(msg) && !msg.pinanoCompactionMemento && !msg.pinanoCompactionSummary
}

/**
 * Hash snapshot values into a compact structural digest so transcript reconciliation can stay content-sensitive without retaining a second serialized copy of large prompt images, tool payloads, or context metadata in the TUI.
 * @param {import("node:crypto").Hash} hash
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 */
function updateTranscriptDigest(hash, value, seen = new WeakSet()) {
	if (value === null) {
		hash.update("null;")
		return
	}
	const type = typeof value
	if (type === "string") {
		hash.update(`string:${value.length}:`)
		hash.update(value, "utf16le")
		hash.update(";")
		return
	}
	if (type === "number" || type === "bigint" || type === "boolean" || type === "undefined" || type === "symbol" || type === "function") {
		const text = String(value)
		hash.update(`${type}:${text.length}:`)
		hash.update(text, "utf16le")
		hash.update(";")
		return
	}
	if (Array.isArray(value)) {
		hash.update(`array:${value.length}[`)
		for (const item of value) updateTranscriptDigest(hash, item, seen)
		hash.update("]")
		return
	}
	if (seen.has(value)) {
		hash.update("cycle;")
		return
	}
	seen.add(value)
	const keys = Object.keys(value).sort()
	hash.update(`object:${keys.length}{`)
	for (const key of keys) {
		updateTranscriptDigest(hash, key, seen)
		updateTranscriptDigest(hash, /** @type {Record<string, unknown>} */ (value)[key], seen)
	}
	hash.update("}")
	seen.delete(value)
}

/** @param {unknown[]} values */
function transcriptDigest(values) {
	const hash = createHash("sha256")
	for (const value of values) updateTranscriptDigest(hash, value)
	return hash.digest("hex")
}

/** @param {any} msg */
export function transcriptMessageFingerprint(msg) {
	return transcriptDigest([
		msg?.role ?? "",
		msg?.stopReason ?? "",
		msg?.errorMessage ?? "",
		msg?.toolCallId ?? "",
		msg?.toolName ?? "",
		msg?.isError ?? "",
		msg?.compaction ?? "",
		msg?.removedCount ?? "",
		msg?.keptCount ?? "",
		msg?.mementoCount ?? "",
		msg?.tokensBefore ?? "",
		msg?.content,
		msg?.contextLoad,
		msg?.planUpdate,
	])
}

/** @param {any} msg */
export function transcriptMessageKey(msg) {
	if (!msg) return ""
	if (msg.entryId) return `entry:${msg.entryId}`
	if (msg.messageId) return `message:${msg.messageId}`
	return `logical:${transcriptDigest([
		msg?.role ?? "",
		msg?.timestamp ?? "",
		msg?.toolCallId ?? "",
		msg?.toolName ?? "",
		msg?.isError ?? "",
		msg?.stopReason ?? "",
		msg?.errorMessage ?? "",
		msg?.compaction ?? "",
		msg?.pinanoCompactionSummary ?? "",
		msg?.content,
		msg?.contextLoad,
		msg?.planUpdate,
	])}`
}

/** @param {any} msg */
export function transcriptMessageState(msg) {
	return { key: transcriptMessageKey(msg), fingerprint: transcriptMessageFingerprint(msg) }
}

/** @param {any} snapshot */
export function transcriptStateFromSnapshot(snapshot) {
	const messages = (snapshot?.messages ?? [])
		.filter(isTranscriptMessageRenderable)
		.map(transcriptMessageState)
	const streamingMessage = snapshot?.streamingMessage?.role === "assistant" && isTranscriptMessageRenderable(snapshot.streamingMessage)
		? transcriptMessageState(snapshot.streamingMessage)
		: null
	return { messages, streamingMessage }
}

/**
 * @param {{ messages: Array<{ key: string, fingerprint: string }>, streamingMessage: { key: string, fingerprint: string } | null }} a
 * @param {{ messages: Array<{ key: string, fingerprint: string }>, streamingMessage: { key: string, fingerprint: string } | null }} b
 */
export function transcriptStatesEqual(a, b) {
	if (a.messages.length !== b.messages.length) return false
	for (let i = 0; i < a.messages.length; i++) {
		if (a.messages[i].key !== b.messages[i].key || a.messages[i].fingerprint !== b.messages[i].fingerprint) return false
	}
	if (!a.streamingMessage || !b.streamingMessage) return a.streamingMessage === b.streamingMessage
	return a.streamingMessage.key === b.streamingMessage.key && a.streamingMessage.fingerprint === b.streamingMessage.fingerprint
}

/** @param {any} value */
export function transcriptCursor(value) {
	const cursor = {}
	if (typeof value?.seq === "number") cursor.seq = value.seq
	if (typeof value?.viewEpoch === "number") cursor.viewEpoch = value.viewEpoch
	return Object.keys(cursor).length > 0 ? cursor : undefined
}

/**
 * @param {{ seq?: number, viewEpoch?: number } | undefined} cursor
 * @param {any} snapshot
 */
export function cursorIsAfterSnapshot(cursor, snapshot) {
	if (!cursor) return true
	if (typeof cursor.viewEpoch === "number" && typeof snapshot?.viewEpoch === "number") {
		if (cursor.viewEpoch > snapshot.viewEpoch) return true
		if (cursor.viewEpoch < snapshot.viewEpoch) return false
	}
	if (typeof cursor.seq === "number" && typeof snapshot?.seq === "number") return cursor.seq > snapshot.seq
	return true
}

/** Merge durable messages from an older same-view snapshot into the current live snapshot without rolling back newer streaming/status state. Messages known to belong to an older view epoch are pruned when the stale snapshot is the newer branch baseline.
 * @param {any} current
 * @param {any} stale
 * @param {Map<string, { seq?: number, viewEpoch?: number }>} [messageCursors]
 */
export function mergeStaleSnapshotMessages(current, stale, messageCursors = new Map()) {
	const staleMessages = stale?.messages ?? []
	if (!current) return null
	const currentMessages = current.messages ?? []
	const usedCurrentIndexes = new Set()
	const mergedMessages = []
	let changed = false
	for (const staleMessage of staleMessages) {
		const key = transcriptMessageKey(staleMessage)
		const currentIndex = currentMessages.findIndex((message, index) =>
			!usedCurrentIndexes.has(index) && transcriptMessageKey(message) === key,
		)
		if (currentIndex >= 0) {
			mergedMessages.push(currentMessages[currentIndex])
			usedCurrentIndexes.add(currentIndex)
		} else {
			mergedMessages.push(staleMessage)
			changed = true
		}
	}
	for (let i = 0; i < currentMessages.length; i++) {
		if (usedCurrentIndexes.has(i)) continue
		const message = currentMessages[i]
		if (cursorIsAfterSnapshot(messageCursors.get(transcriptMessageKey(message)), stale)) mergedMessages.push(message)
		else changed = true
	}
	return changed ? cloneSessionSnapshot({ ...current, messages: mergedMessages }) : null
}

/** @param {string} iso */
