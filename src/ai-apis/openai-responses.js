// OpenAI Responses API client (api.openai.com/v1/responses) using a regular
// API key. Shares message conversion + stream processing with the Codex
// client; only the URL, auth header, and (lack of) Codex-specific headers
// differ.
//
// Use this transport for reasoning models that combine tools with
// reasoning_effort — those are no longer supported on /v1/chat/completions.

import { AssistantMessageEventStream } from "./event-stream.js"
import { convertResponsesMessages, convertResponsesTools } from "./codex/responses-shared.js"
import { executeResponsesRequest } from "./responses-transport.js"

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
		parallel_tool_calls: true,
	}
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
	if (options?.textVerbosity) body.text = { verbosity: options.textVerbosity }
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

function envApiKey() {
	if (typeof process === "undefined") return undefined
	return process.env?.OPENAI_API_KEY
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}
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
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		}

		try {
			const apiKey = options?.apiKey ?? envApiKey() ?? ""
			if (!apiKey) {
				throw new Error(
					"OpenAI API key is required. Pass options.apiKey or set the OPENAI_API_KEY environment variable.",
				)
			}

			let body = buildBody(model, context, options)
			if (options?.onPayload) {
				const next = await options.onPayload(body, model)
				if (next !== undefined) body = next
			}

			await executeResponsesRequest({
				url: buildUrl(model.baseUrl),
				headers: buildHeaders(model, apiKey, options?.headers),
				bodyJson: JSON.stringify(body),
				output,
				stream,
				model,
				signal: options?.signal,
				onResponse: options?.onResponse,
				parseError: parseErrorResponse,
			})

			if (options?.signal?.aborted) throw new Error("Request was aborted")
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason")
			}

			stream.push({ type: "done", reason: output.stopReason, message: output })
			stream.end()
		} catch (error) {
			for (const block of output.content) delete block.partialJson
			output.stopReason = options?.signal?.aborted ? "aborted" : "error"
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error)
			stream.push({ type: "error", reason: output.stopReason, error: output })
			stream.end()
		}
	})()

	return stream
}

export async function completeOpenAIResponses(model, context, options) {
	return streamOpenAIResponses(model, context, options).result()
}
