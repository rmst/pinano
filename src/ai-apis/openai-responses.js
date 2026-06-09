// OpenAI Responses API client (api.openai.com/v1/responses) using a regular
// API key. Shares message conversion + stream processing with the Codex
// client; only the URL, auth header, and (lack of) Codex-specific headers
// differ.
//
// Use this transport for reasoning models that combine tools with
// reasoning_effort — those are no longer supported on /v1/chat/completions.

import { AssistantMessageEventStream } from "./event-stream.js"
import { missingApiKeyMessage, providerConfiguredApiKey } from "./api-key.js"
import { validateMessageHistory } from "./message-history.js"
import { convertResponsesMessages, convertResponsesTools } from "./codex/responses-shared.js"
import { beginModelRequest, finishModelRequest } from "./model-io-log.js"
import { executeResponsesRequest } from "./responses-transport.js"
import { retryableModelErrorDetails } from "./model-errors.js"
import { buildAssistantAuth, emptyUsage } from "./usage.js"

function buildUrl(baseUrl) {
	const trimmed = (baseUrl ?? "").replace(/\/+$/, "")
	return `${trimmed}/responses`
}

function buildHeaders(model, apiKey, optionsHeaders) {
	const headers = new Headers(model.headers ?? {})
	if (optionsHeaders) {
		for (const [k, v] of Object.entries(optionsHeaders)) headers.set(k, v)
	}
	headers.set("Authorization", `Bearer ${apiKey}`)
	headers.set("Accept", "text/event-stream")
	headers.set("Content-Type", "application/json")
	return headers
}

function buildBody(model, context, options) {
	const messages = convertResponsesMessages(model, context, { includeSystemPrompt: false })
	const body = {
		model: model.id,
		store: false,
		stream: true,
		input: messages,
	}
	if (model.supportsParallelToolCalls ?? true) body.parallel_tool_calls = true
	if (context.systemPrompt) body.instructions = context.systemPrompt
	if (options?.maxTokens != null) body.max_output_tokens = options.maxTokens
	if (options?.temperature !== undefined) body.temperature = options.temperature
	if (context.tools && context.tools.length > 0) {
		body.tools = convertResponsesTools(context.tools, { strict: null })
		body.tool_choice = options?.toolChoice ?? "auto"
	}
	if (model.reasoning && options?.reasoningEffort) {
		body.reasoning = {
			effort: options.reasoningEffort,
			summary: options.reasoningSummary ?? "auto",
		}
		// `include` only works with store:false (which we set above) and gives
		// us the encrypted reasoning blob needed for replay across turns.
		body.include = ["reasoning.encrypted_content"]
	}
	const textVerbosity = model.supportsTextVerbosity === false ? undefined : options?.textVerbosity ?? model.defaultTextVerbosity
	if (textVerbosity !== undefined) body.text = { verbosity: textVerbosity }
	if (options?.sessionId) body.prompt_cache_key = options.sessionId
	return body
}

async function parseErrorResponse(rawText, status) {
	let message = rawText || `HTTP ${status}`
	try {
		const parsed = JSON.parse(rawText)
		const err = parsed?.error
		if (err?.message) message = err.message
		else if (parsed?.message) message = parsed.message
	} catch {}
	return { message }
}

/**
 * Open a streaming /v1/responses request. Returns an AssistantMessageEventStream.
 * Errors arrive as `error` events on the stream, never as thrown exceptions
 * from this function.
 */
export function streamOpenAIResponses(model, context, options) {
	const stream = new AssistantMessageEventStream()

	;(async () => {
		const output = {
			role: "assistant",
			content: [],
			provider: model.provider ?? "openai",
			model: model.id,
			auth: buildAssistantAuth(model, options),
			usage: emptyUsage(model),
			stopReason: "stop",
			timestamp: Date.now(),
		}

		let modelLog = null
		try {
			validateMessageHistory(context.messages)
			const apiKey = options?.apiKey ?? providerConfiguredApiKey(model) ?? ""
			if (!apiKey) throw new Error(missingApiKeyMessage(model))

			let body = buildBody(model, context, options)
			if (options?.onPayload) {
				const next = await options.onPayload(body, model)
				if (next !== undefined) body = next
			}

			const bodyJson = JSON.stringify(body)
			modelLog = beginModelRequest({ model, transport: "responses", requestJson: bodyJson, options })
			if (modelLog?.id) output.modelRequestId = modelLog.id

			const execute = (requestBodyJson) => executeResponsesRequest({
				url: buildUrl(model.baseUrl),
				headers: buildHeaders(model, apiKey, options?.headers),
				bodyJson: requestBodyJson,
				output,
				stream,
				model,
				signal: options?.signal,
				onResponse: options?.onResponse,
				parseError: parseErrorResponse,
				modelLog,
				responseHeaderTimeoutMs: options?.responseHeaderTimeoutMs,
				streamInactivityTimeoutMs: options?.streamInactivityTimeoutMs,
				firstStreamEventTimeoutMs: options?.firstStreamEventTimeoutMs,
				streamEventInactivityTimeoutMs: options?.streamEventInactivityTimeoutMs,
			})
			await execute(bodyJson)

			if (options?.signal?.aborted) throw new Error("Request was aborted")
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason")
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

export async function completeOpenAIResponses(model, context, options) {
	return streamOpenAIResponses(model, context, options).result()
}
