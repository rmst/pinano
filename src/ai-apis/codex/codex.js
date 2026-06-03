// Codex Responses API client (ChatGPT subscription).
//
// Hits https://chatgpt.com/backend-api/codex/responses (or wherever
// model.baseUrl points) using a Codex OAuth access token in the
// Authorization header plus the chatgpt-account-id header extracted
// from the JWT.
//
// SSE only — the WebSocket transport in pi-mono is for connection-cached
// session continuation, which we skip in this port.

import { randomUUID } from "node:crypto"

import { AssistantMessageEventStream } from "../event-stream.js"
import { validateMessageHistory } from "../message-history.js"
import { RetryableModelError, classifyModelError, retryableModelErrorDetails } from "../model-errors.js"
import { beginModelRequest, finishModelRequest } from "../model-io-log.js"
import { executeResponsesRequest } from "../responses-transport.js"
import { buildAssistantAuth, emptyUsage } from "../usage.js"
import { convertResponsesMessages, convertResponsesTools } from "./responses-shared.js"

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api"
const JWT_CLAIM_PATH = "https://api.openai.com/auth"

function decodeJwt(token) {
	try {
		const parts = token.split(".")
		if (parts.length !== 3) return null
		const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/")
		const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
		return JSON.parse(atob(padded + padding))
	} catch {
		return null
	}
}

function extractAccountId(token) {
	const payload = decodeJwt(token)
	const id = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("Failed to extract chatgpt_account_id from token")
	}
	return id
}

function resolveCodexUrl(baseUrl) {
	const raw = (baseUrl ?? "").trim().length > 0 ? baseUrl : DEFAULT_BASE_URL
	const normalized = raw.replace(/\/+$/, "")
	if (normalized.endsWith("/codex/responses")) return normalized
	if (normalized.endsWith("/codex")) return `${normalized}/responses`
	return `${normalized}/codex/responses`
}

function buildHeaders(model, accountId, token, sessionId, clientRequestId, optionsHeaders) {
	const headers = new Headers(model.headers ?? {})
	if (optionsHeaders) {
		for (const [k, v] of Object.entries(optionsHeaders)) headers.set(k, v)
	}
	headers.set("Authorization", `Bearer ${token}`)
	headers.set("chatgpt-account-id", accountId)
	headers.set("originator", "pi")
	headers.set("OpenAI-Beta", "responses=experimental")
	headers.set("accept", "text/event-stream")
	headers.set("content-type", "application/json")
	if (sessionId) {
		headers.set("session_id", sessionId)
		headers.set("x-client-request-id", clientRequestId || randomUUID())
	}
	return headers
}

function buildBody(model, context, options) {
	const messages = convertResponsesMessages(model, context, { includeSystemPrompt: false })
	const body = {
		model: model.wireModel ?? model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt,
		input: messages,
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.sessionId,
		tool_choice: "auto",
	}
	if (model.supportsParallelToolCalls ?? true) body.parallel_tool_calls = true
	const textVerbosity = model.supportsTextVerbosity === false ? undefined : options?.textVerbosity ?? model.defaultTextVerbosity
	if (textVerbosity !== undefined) body.text = { verbosity: textVerbosity }
	if (options?.temperature !== undefined) body.temperature = options.temperature
	if (options?.serviceTier !== undefined) body.service_tier = options.serviceTier
	if (context.tools && context.tools.length > 0) {
		body.tools = convertResponsesTools(context.tools, { strict: null })
	}
	if (options?.reasoningEffort !== undefined && options.reasoningEffort !== null) {
		const effort = options.reasoningEffort === "none" ? "none" : options.reasoningEffort
		body.reasoning = {
			effort,
			summary: options.reasoningSummary ?? "auto",
		}
	}
	return body
}

async function parseErrorResponse(rawText, status) {
	let message = rawText || `HTTP ${status}`
	let friendly
	try {
		const parsed = JSON.parse(rawText)
		const err = parsed?.error
		if (err) {
			const code = err.code || err.type || ""
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || status === 429) {
				const plan = err.plan_type ? ` (${String(err.plan_type).toLowerCase()} plan)` : ""
				const mins = err.resets_at
					? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
					: undefined
				const when = mins !== undefined ? ` Try again in ~${mins} min.` : ""
				friendly = `You have hit your ChatGPT usage limit${plan}.${when}`.trim()
			}
			message = err.message || friendly || message
		}
	} catch {}
	return { message, friendly }
}

function codexErrorInfo(event) {
	const err = event.error && typeof event.error === "object" ? event.error : undefined
	return {
		code: String(err?.code ?? event.code ?? ""),
		type: String(err?.type ?? ""),
		message: String(err?.message ?? event.message ?? ""),
		raw: event,
	}
}

function retryableCodexStreamError(info) {
	return /server_is_overloaded|service_unavailable_error|rate_limit_exceeded/i.test(`${info.type} ${info.code}`)
		|| classifyModelError(info.message).retryable
}

// Map raw Codex SSE events into the shape processResponsesStream expects.
// Codex emits `response.done` and `response.incomplete` where the standard
// Responses API would emit `response.completed`; rename for uniformity.
async function* mapCodexEvents(events) {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined
		if (!type) continue

		if (type === "error") {
			const info = codexErrorInfo(event)
			const message = info.message || info.code || JSON.stringify(event)
			if (retryableCodexStreamError(info)) {
				throw new RetryableModelError(`Codex temporarily unavailable: ${message}`, {
					code: info.code || undefined,
					type: info.type || undefined,
					cause: info.raw,
				})
			}
			throw new Error(`Codex error: ${message}`)
		}
		if (type === "response.failed") {
			const info = codexErrorInfo(event.response ?? event)
			const msg = info.message || event.response?.error?.message || "Codex response failed"
			if (retryableCodexStreamError(info)) {
				throw new RetryableModelError(`Codex temporarily unavailable: ${msg}`, {
					code: info.code || undefined,
					type: info.type || undefined,
					cause: event,
				})
			}
			throw new Error(msg)
		}
		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			yield { ...event, type: "response.completed" }
			return
		}
		yield event
	}
}

/**
 * Open a streaming Codex response. Returns an AssistantMessageEventStream.
 * Errors arrive as `error` events on the stream, never as thrown exceptions
 * from this function.
 *
 * Required: options.apiKey is the Codex OAuth access token (the `access`
 * field returned by loginCodex).
 */
export function streamCodex(model, context, options) {
	const stream = new AssistantMessageEventStream()

	;(async () => {
		const output = {
			role: "assistant",
			content: [],
			provider: model.provider ?? "openai-codex",
			model: model.id,
			auth: buildAssistantAuth(model, options),
			usage: emptyUsage(model),
			stopReason: "stop",
			timestamp: Date.now(),
		}

		let modelLog = null
		try {
			validateMessageHistory(context.messages)
			const apiKey = options?.apiKey
			if (!apiKey) throw new Error("Codex requires an OAuth access token via options.apiKey")

			const accountId = extractAccountId(apiKey)
			output.auth = buildAssistantAuth(model, options, { accountId })
			let body = buildBody(model, context, options)
			if (options?.onPayload) {
				const next = await options.onPayload(body, model)
				if (next !== undefined) body = next
			}

			const bodyJson = JSON.stringify(body)
			modelLog = beginModelRequest({ model, transport: "codex", requestJson: bodyJson, options })
			if (modelLog?.id) output.modelRequestId = modelLog.id

			const execute = (requestBodyJson) => executeResponsesRequest({
				url: resolveCodexUrl(model.baseUrl),
				headers: buildHeaders(model, accountId, apiKey, options?.sessionId, modelLog?.id, options?.headers),
				bodyJson: requestBodyJson,
				output,
				stream,
				model,
				signal: options?.signal,
				onResponse: options?.onResponse,
				mapEvents: mapCodexEvents,
				parseError: parseErrorResponse,
				modelLog,
				responseHeaderTimeoutMs: options?.responseHeaderTimeoutMs,
				streamInactivityTimeoutMs: options?.streamInactivityTimeoutMs,
			})
			await execute(bodyJson)

			if (options?.signal?.aborted) throw new Error("Request was aborted")
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Codex returned an error stop reason")
			}

			finishModelRequest(modelLog, { status: "completed", finalMessage: output })
			stream.push({ type: "done", reason: output.stopReason, message: output })
			stream.end()
		} catch (error) {
			for (const block of output.content) delete block.partialJson
			output.stopReason = options?.signal?.aborted ? "aborted" : "error"
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error)
			const errorDetails = retryableModelErrorDetails(error)
			if (errorDetails) output.errorDetails = errorDetails
			finishModelRequest(modelLog, { status: output.stopReason, finalMessage: output, error: output.errorMessage })
			stream.push({ type: "error", reason: output.stopReason, error: output })
			stream.end()
		}
	})()

	return stream
}

export async function completeCodex(model, context, options) {
	return streamCodex(model, context, options).result()
}
