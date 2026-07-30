// Compact, authoritative session-local entry projection. Heavy immutable payloads stay in the global entry tables and are hydrated only when a caller explicitly requests them.

const CONFIG_CUSTOM_TYPES = new Set([
	"config",
	"session_global_config",
	"session_properties",
])

const DISPLAY_CUSTOM_TYPES = new Set([
	"bash_shortcut",
	"plan_update",
])

function compactImageBlock(block) {
	if (!block || typeof block !== "object") return block
	if (!Object.prototype.hasOwnProperty.call(block, "data") && !block.original?.data) return block
	const original = block.original && typeof block.original === "object"
		? Object.fromEntries(Object.entries(block.original).filter(([key]) => key !== "data"))
		: undefined
	return {
		...Object.fromEntries(Object.entries(block).filter(([key]) => key !== "data" && key !== "original")),
		...(original && Object.keys(original).length > 0 ? { original } : {}),
	}
}

function compactAssistantContent(content) {
	if (!Array.isArray(content)) return content
	return content
		.filter((block) => block?.type !== "thinking")
		.map((block) => block?.type === "image" ? compactImageBlock(block) : block)
}

function deferredFields(...fields) {
	return fields.filter(Boolean)
}

/** @param {any} message */
export function transcriptManifestMessage(message) {
	if (!message || typeof message !== "object") return message
	if (message.hidden === true || message.projectContext === true || message.compactionMemento === true || message.compactionSummary === true) {
		const omittedAuth = Object.prototype.hasOwnProperty.call(message, "auth")
		const omittedDetails = Object.prototype.hasOwnProperty.call(message, "details")
		const { auth: _auth, details: _details, ...base } = message
		return {
			...base,
			content: Array.isArray(message.content) ? [] : "",
			deferredPayload: deferredFields("content", omittedAuth ? "auth" : undefined, omittedDetails ? "details" : undefined),
		}
	}
	if (message.role === "toolResult" && message.isError !== true) {
		const { details: _details, ...base } = message
		return {
			...base,
			content: Array.isArray(message.content) ? [] : "",
			deferredPayload: deferredFields("content", Object.prototype.hasOwnProperty.call(message, "details") ? "details" : undefined),
		}
	}
	if (message.role === "assistant") {
		const content = compactAssistantContent(message.content)
		const omittedThinking = Array.isArray(message.content) && content.length !== message.content.length
		const omittedAuth = Object.prototype.hasOwnProperty.call(message, "auth")
		const omittedImageData = Array.isArray(message.content) && message.content.some((block) => block?.type === "image" && (Object.prototype.hasOwnProperty.call(block, "data") || block.original?.data))
		const { auth: _auth, ...base } = message
		return {
			...base,
			content,
			...(omittedThinking || omittedAuth || omittedImageData
				? { deferredPayload: deferredFields(omittedThinking ? "thinking" : undefined, omittedAuth ? "auth" : undefined, omittedImageData ? "imageData" : undefined) }
				: {}),
		}
	}
	if (Array.isArray(message.content)) {
		const omittedImageData = message.content.some((block) => block?.type === "image" && (Object.prototype.hasOwnProperty.call(block, "data") || block.original?.data))
		if (omittedImageData) {
			const content = message.content.map((block) => block?.type === "image" ? compactImageBlock(block) : block)
			return { ...message, content, deferredPayload: ["imageData"] }
		}
	}
	return message
}

function compactContextLoad(load) {
	if (!load || typeof load !== "object") return load
	return {
		...load,
		files: (load.files ?? []).map((file) => ({
			path: file?.path ?? "",
			...(file?.scopeDir ? { scopeDir: file.scopeDir } : {}),
			...(file?.identityPath ? { identityPath: file.identityPath } : {}),
			...(file?.hash ? { hash: file.hash } : {}),
		})),
	}
}

function compactCompactionData(data) {
	if (!data || typeof data !== "object") return undefined
	return {
		...(data.cutEntryId ? { cutEntryId: data.cutEntryId } : {}),
		...(data.displayMessage ? { displayMessage: transcriptManifestMessage(data.displayMessage) } : {}),
	}
}

function compactToolExecutionData(data) {
	if (!data || typeof data !== "object") return undefined
	const fields = ["version", "phase", "runId", "toolCallId", "toolName", "isError", "messageEntryId", "hasDurableMessage"]
	return Object.fromEntries(fields.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]))
}

function compactCustomData(entry) {
	if (CONFIG_CUSTOM_TYPES.has(entry.customType) || DISPLAY_CUSTOM_TYPES.has(entry.customType)) return entry.data
	if (entry.customType === "compaction") return compactCompactionData(entry.data)
	if (entry.customType === "tool_execution") return compactToolExecutionData(entry.data)
	return undefined
}

/** @param {any} entry */
export function sessionEntryManifestPayload(entry) {
	const contextLoad = entry.contextLoad ? compactContextLoad(entry.contextLoad) : undefined
	if (entry.type === "message") {
		return {
			message: transcriptManifestMessage(entry.message),
			...(contextLoad ? { contextLoad } : {}),
		}
	}
	if (entry.type === "label") {
		return {
			targetId: entry.targetId,
			...(entry.label !== undefined ? { label: entry.label } : {}),
			...(contextLoad ? { contextLoad } : {}),
		}
	}
	if (entry.type === "custom") {
		const data = compactCustomData(entry)
		return {
			customType: entry.customType,
			...(data !== undefined ? { data } : {}),
			...(contextLoad ? { contextLoad } : {}),
		}
	}
	if (entry.type === "context") return { contextLoad: contextLoad ?? { source: "unknown", files: [] } }
	throw new Error(`Unsupported session entry type: ${entry.type}`)
}

/** @param {{ entryId: string, parentEntryId?: string | null, timestamp: string, kind: string, manifestJson: string }} row */
export function sessionEntryFromManifestRow(row) {
	let payload
	try {
		payload = JSON.parse(row.manifestJson)
	} catch {
		throw new Error(`Invalid session entry manifest for ${row.entryId}`)
	}
	return {
		...payload,
		id: row.entryId,
		parentId: row.parentEntryId ?? null,
		timestamp: row.timestamp,
		type: row.kind,
	}
}

/** @param {any} message */
export function transcriptMessageNeedsHydration(message) {
	return Array.isArray(message?.deferredPayload) && message.deferredPayload.length > 0
}
