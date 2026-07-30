// Codex Responses API client (ChatGPT subscription).
//
// Hits https://chatgpt.com/backend-api/codex/responses (or wherever
// model.baseUrl points) using a Codex OAuth access token in the
// Authorization header plus the chatgpt-account-id header extracted
// from the JWT.
//
import { randomUUID } from "node:crypto"

import { AssistantMessageEventStream } from "../event-stream.js"
import { validateMessageHistory } from "../message-history.js"
import { RetryableModelError, classifyModelError, retryableModelErrorDetails } from "../model-errors.js"
import { beginModelRequest, finishModelRequest } from "../model-io-log.js"
import { executeResponsesRequest, firstStreamEventTimeoutMs, streamEventInactivityTimeoutMs } from "../responses-transport.js"
import { sanitizeSurrogates } from "../sanitize-unicode.js"
import { buildAssistantAuth, emptyUsage } from "../usage.js"
import { convertResponsesMessages, convertResponsesTools } from "./responses-shared.js"
import { requestCodexUsage } from "./usage.js"
import {
	codexWebSocketConnectTimeoutMs,
	codexWebSocketConnectionIdentity,
	codexWebSocketFallbackActive,
	disableCodexWebSocketForSession,
	executeCodexWebSocket,
	isCodexWebSocketProtocolError,
} from "./websocket.js"

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api"
const JWT_CLAIM_PATH = "https://api.openai.com/auth"
const REMOTE_COMPACTION_BETA = "remote_compaction_v2"
const WEBSOCKET_BETA = "responses_websockets=2026-02-06"
const WEBSOCKET_CONNECTION_LIMIT_CODE = "websocket_connection_limit_reached"
const CODEX_PLAN_LOOKUP_TIMEOUT_MS = 2_000
const UNSUPPORTED_CHATGPT_ACCOUNT_MESSAGE = /^The '[^'\r\n]+' model is not supported when using Codex with a ChatGPT account\.$/

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

function responsesLiteInstructionsMessage(systemPrompt) {
	if (typeof systemPrompt !== "string" || systemPrompt.length === 0) return undefined
	return {
		type: "message",
		role: "developer",
		content: [{ type: "input_text", text: sanitizeSurrogates(systemPrompt) }],
	}
}

function responsesLiteInput(systemPrompt, tools, messages) {
	const input = [{
		type: "additional_tools",
		role: "developer",
		tools,
	}]
	const instructions = responsesLiteInstructionsMessage(systemPrompt)
	if (instructions) input.push(instructions)
	input.push(...messages)
	return input
}

function buildBaseHeaders(model, accountId, token, optionsHeaders) {
	const headers = new Headers(model.headers ?? {})
	if (optionsHeaders) {
		for (const [k, v] of Object.entries(optionsHeaders)) headers.set(k, v)
	}
	headers.set("Authorization", `Bearer ${token}`)
	headers.set("chatgpt-account-id", accountId)
	headers.set("originator", "pi")
	if (model.compaction?.remoteResponses === true) {
		const betaFeatures = new Set((headers.get("x-codex-beta-features") ?? "").split(",").map((value) => value.trim()).filter(Boolean))
		betaFeatures.add(REMOTE_COMPACTION_BETA)
		headers.set("x-codex-beta-features", [...betaFeatures].join(","))
	}
	if (model.useResponsesLite) headers.set("x-openai-internal-codex-responses-lite", "true")
	return headers
}

function buildSseHeaders(model, accountId, token, sessionId, clientRequestId, optionsHeaders) {
	const headers = buildBaseHeaders(model, accountId, token, optionsHeaders)
	headers.set("OpenAI-Beta", "responses=experimental")
	headers.set("accept", "text/event-stream")
	headers.set("content-type", "application/json")
	if (sessionId) {
		headers.set("session_id", sessionId)
		headers.set("x-client-request-id", clientRequestId || randomUUID())
	}
	return headers
}

function buildWebSocketHeaders(model, accountId, token, requestId, optionsHeaders) {
	const headers = buildBaseHeaders(model, accountId, token, optionsHeaders)
	headers.delete("accept")
	headers.delete("content-type")
	headers.set("OpenAI-Beta", WEBSOCKET_BETA)
	headers.set("session-id", requestId)
	headers.set("x-client-request-id", requestId)
	return headers
}

function buildBody(model, context, options) {
	const messages = convertResponsesMessages(model, context, { includeSystemPrompt: false })
	const tools = convertResponsesTools(context.tools ?? [], { strict: null })
	const body = {
		model: model.wireModel ?? model.id,
		store: false,
		stream: true,
		instructions: model.useResponsesLite ? "" : context.systemPrompt,
		input: model.useResponsesLite ? responsesLiteInput(context.systemPrompt, tools, messages) : messages,
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.sessionId,
		tool_choice: options?.toolChoice ?? "auto",
	}
	if (model.useResponsesLite) {
		body.parallel_tool_calls = false
	} else {
		if (model.supportsParallelToolCalls ?? true) body.parallel_tool_calls = true
		if (context.tools && context.tools.length > 0) body.tools = tools
	}
	const textVerbosity = model.supportsTextVerbosity === false ? undefined : options?.textVerbosity ?? model.defaultTextVerbosity
	if (textVerbosity !== undefined) body.text = { verbosity: textVerbosity }
	if (options?.temperature !== undefined) body.temperature = options.temperature
	if (options?.serviceTier !== undefined) body.service_tier = options.serviceTier
	if (options?.reasoningEffort !== undefined && options.reasoningEffort !== null) {
		const effort = options.reasoningEffort === "none" ? "none" : options.reasoningEffort
		body.reasoning = {
			effort,
			summary: options.reasoningSummary ?? "auto",
		}
		if (model.useResponsesLite) body.reasoning.context = "all_turns"
	}
	if (options?.compactionTrigger === true) body.input.push({ type: "compaction_trigger" })
	return body
}

function codexPlanLabel(value) {
	if (typeof value !== "string") return undefined
	const normalized = value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ")
	if (!normalized || normalized.length > 64 || !/^[a-zA-Z0-9 ]+$/.test(normalized)) return undefined
	return normalized.split(" ").map((word) => `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`).join(" ")
}

async function currentCodexPlanLabel(context) {
	if (!context?.access || context.signal?.aborted) return undefined
	const timeoutSignal = AbortSignal.timeout(CODEX_PLAN_LOOKUP_TIMEOUT_MS)
	const signal = context.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal

	try {
		const usage = await requestCodexUsage({
			baseUrl: context.baseUrl,
			access: context.access,
			accountId: context.accountId,
			signal,
		})
		return codexPlanLabel(usage?.plan_type)
	} catch {
		return undefined
	}
}

async function enrichUnsupportedChatGptAccountMessage(message, context) {
	if (!UNSUPPORTED_CHATGPT_ACCOUNT_MESSAGE.test(message)) return message
	const plan = await currentCodexPlanLabel(context)
	return plan ? message.replace("a ChatGPT account.", `a ChatGPT ${plan} account.`) : message
}

async function parseErrorResponse(rawText, status, errorContext) {
	let message = rawText || `HTTP ${status}`
	let friendly
	let code
	let type
	let retryable
	try {
		const parsed = JSON.parse(rawText)
		const err = parsed?.error
		if (err) {
			code = err.code || err.type || undefined
			type = err.type || undefined
			const codeText = code || ""
			const hardUsageLimit = /usage_limit_reached|usage_not_included/i.test(codeText)
			const transientRateLimit = /rate_limit_exceeded/i.test(codeText)
			if (hardUsageLimit || transientRateLimit || status === 429) {
				const plan = err.plan_type ? ` (${String(err.plan_type).toLowerCase()} plan)` : ""
				const mins = err.resets_at
					? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
					: undefined
				const when = mins !== undefined ? ` Try again in ~${mins} min.` : ""
				friendly = `You have hit your ChatGPT usage limit${plan}.${when}`.trim()
			}
			message = err.message || friendly || message
			if (hardUsageLimit) retryable = false
			else if (transientRateLimit) retryable = true
			if (/server_error|server_is_overloaded|service_unavailable_error/i.test(codeText)) retryable = true
		} else if (typeof parsed?.detail === "string") {
			message = parsed.detail
			if (status === 400 && /^Unsupported content type$/i.test(parsed.detail.trim())) {
				code = "unsupported_content_type"
				type = "codex_transient_http_error"
				friendly = "Codex temporarily rejected the request as an unsupported content type"
				retryable = true
			}
		} else if (typeof parsed?.message === "string") {
			message = parsed.message
		}
	} catch {}
	message = await enrichUnsupportedChatGptAccountMessage(message, errorContext)
	return { message, friendly, code, type, retryable }
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
	return classifyModelError({
		code: info.code,
		type: info.type,
		message: info.message,
	}).retryable
}

function markCodexApiError(error) {
	error.codexApiError = true
	return error
}

function isCodexApiError(error) {
	return error?.codexApiError === true
}

function codexTransport(model, options) {
	const value = options?.codexTransport ?? model?.codexTransport ?? "auto"
	if (value === "auto" || value === "sse" || value === "websocket") return value
	throw new Error(`Unsupported Codex transport: ${value}`)
}

function resolveCodexWebSocketUrl(baseUrl) {
	const url = new URL(resolveCodexUrl(baseUrl))
	if (url.protocol === "https:") url.protocol = "wss:"
	else if (url.protocol === "http:") url.protocol = "ws:"
	else throw new Error(`Unsupported Codex WebSocket URL protocol: ${url.protocol}`)
	return url.toString()
}

function isWebSocketConnectionLimit(error) {
	return error?.code === WEBSOCKET_CONNECTION_LIMIT_CODE
}

function retryableWebSocketFailure(error, started) {
	return new RetryableModelError(
		`Codex WebSocket transport failed: ${error instanceof Error ? error.message : String(error)}`,
		{
			code: "websocket_transport_error",
			type: "websocket_transport_error",
			phase: started ? "stream" : "before_first_event",
			cause: error,
		},
	)
}

// Map raw Codex Responses events into the shape processResponsesStream expects.
// Codex emits `response.done` and `response.incomplete` where the standard
// Responses API would emit `response.completed`; rename for uniformity.
async function* mapCodexEvents(events, errorContext) {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined
		if (!type) continue

		if (type === "error") {
			const info = codexErrorInfo(event)
			let message = info.message || info.code || JSON.stringify(event)
			if (retryableCodexStreamError(info)) {
				throw markCodexApiError(new RetryableModelError(`Codex temporarily unavailable: ${message}`, {
					code: info.code || undefined,
					type: info.type || undefined,
					cause: info.raw,
				}))
			}
			message = await enrichUnsupportedChatGptAccountMessage(message, errorContext)
			const error = new Error(`Codex error: ${message}`)
			error.code = info.code || undefined
			throw markCodexApiError(error)
		}
		if (type === "response.failed") {
			const info = codexErrorInfo(event.response ?? event)
			let msg = info.message || event.response?.error?.message || "Codex response failed"
			if (retryableCodexStreamError(info)) {
				throw markCodexApiError(new RetryableModelError(`Codex temporarily unavailable: ${msg}`, {
					code: info.code || undefined,
					type: info.type || undefined,
					cause: event,
				}))
			}
			msg = await enrichUnsupportedChatGptAccountMessage(msg, errorContext)
			const error = new Error(msg)
			error.code = info.code || undefined
			throw markCodexApiError(error)
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
			const errorContext = { baseUrl: model.baseUrl, access: apiKey, accountId, signal: options?.signal }
			const mapEvents = (events) => mapCodexEvents(events, errorContext)
			output.auth = buildAssistantAuth(model, options, { accountId })
			let body = buildBody(model, context, options)
			if (options?.onPayload) {
				const next = await options.onPayload(body, model)
				if (next !== undefined) body = next
			}

			const bodyJson = JSON.stringify(body)
			modelLog = beginModelRequest({ model, transport: "codex", requestJson: bodyJson, options })
			if (modelLog?.id) output.modelRequestId = modelLog.id

			const transport = codexTransport(model, options)
			let nextAttemptIndex = 0
			let websocketCompleted = false
			if (transport !== "sse") {
				const websocketUrl = resolveCodexWebSocketUrl(model.baseUrl)
				const websocketRequestId = options?.sessionId || randomUUID()
				const websocketHeaders = buildWebSocketHeaders(model, accountId, apiKey, websocketRequestId, options?.headers)
				const websocketIdentity = codexWebSocketConnectionIdentity(websocketUrl, websocketHeaders)
				// Automatic transport never sends credentials over a plaintext WebSocket. Embeddings can still opt into a local ws: endpoint by supplying its constructor, and forced WebSocket mode remains explicit.
				const automaticWebSocketEligible = websocketUrl.startsWith("wss:")
					|| typeof options?.webSocketConstructor === "function"
				const fallbackActive = transport === "auto" && (
					!automaticWebSocketEligible
					|| codexWebSocketFallbackActive(options?.sessionId, websocketIdentity)
				)
				if (!fallbackActive) {
					let retriedConnectionLimit = false
					while (true) {
						let websocketStarted = false
						try {
							await executeCodexWebSocket({
								url: websocketUrl,
								headers: websocketHeaders,
								identity: websocketIdentity,
								body,
								output,
								stream,
								model,
								context,
								signal: options?.signal,
								sessionId: options?.sessionId,
								cacheContext: true,
								mapEvents,
								modelLog,
								attemptIndex: nextAttemptIndex++,
								onStart: () => {
									websocketStarted = true
								},
								connectTimeoutMs: codexWebSocketConnectTimeoutMs(options?.webSocketConnectTimeoutMs),
								firstEventTimeoutMs: firstStreamEventTimeoutMs(model, options?.firstStreamEventTimeoutMs),
								eventInactivityTimeoutMs: streamEventInactivityTimeoutMs(
									model,
									options?.streamEventInactivityTimeoutMs,
									options?.streamInactivityTimeoutMs,
								),
								WebSocketConstructor: options?.webSocketConstructor,
								pricingContext: { serviceTier: options?.serviceTier },
							})
							websocketCompleted = true
							break
						} catch (error) {
							if (options?.signal?.aborted) throw error
							const connectionLimit = !websocketStarted && isWebSocketConnectionLimit(error)
							if (connectionLimit && !retriedConnectionLimit) {
								retriedConnectionLimit = true
								continue
							}
							if (isCodexApiError(error) && !connectionLimit) throw error
							if (isCodexWebSocketProtocolError(error)) throw error
							if (transport === "websocket") throw error

							disableCodexWebSocketForSession(options?.sessionId, websocketIdentity)
							if (websocketStarted) throw retryableWebSocketFailure(error, true)
							break
						}
					}
				}
			}

			const execute = (requestBodyJson) => executeResponsesRequest({
				url: resolveCodexUrl(model.baseUrl),
				headers: buildSseHeaders(model, accountId, apiKey, options?.sessionId, modelLog?.id, options?.headers),
				bodyJson: requestBodyJson,
				output,
				stream,
				model,
				signal: options?.signal,
				onResponse: options?.onResponse,
				mapEvents,
				parseError: (rawText, status) => parseErrorResponse(rawText, status, errorContext),
				modelLog,
				pricingContext: { serviceTier: options?.serviceTier },
				responseHeaderTimeoutMs: options?.responseHeaderTimeoutMs,
				streamInactivityTimeoutMs: options?.streamInactivityTimeoutMs,
				firstStreamEventTimeoutMs: options?.firstStreamEventTimeoutMs,
				streamEventInactivityTimeoutMs: options?.streamEventInactivityTimeoutMs,
				attemptIndexOffset: nextAttemptIndex,
			})
			if (!websocketCompleted) await execute(bodyJson)

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
