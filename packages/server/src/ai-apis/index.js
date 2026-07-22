// Public API. `stream`/`complete` are the recommended entry points — they
// dispatch on `model.transport` ("chat" → /v1/chat/completions, "responses" →
// /v1/responses). Default is "chat".

import { streamOpenAI, completeOpenAI } from "./openai.js"
import { streamOpenAIResponses, completeOpenAIResponses } from "./openai-responses.js"
import { streamCodex, completeCodex } from "./codex/index.js"

export function stream(model, context, options) {
	if (model?.provider === "openai-codex") return streamCodex(model, context, options)
	if (model?.transport === "responses") return streamOpenAIResponses(model, context, options)
	return streamOpenAI(model, context, options)
}

export async function complete(model, context, options) {
	if (model?.provider === "openai-codex") return completeCodex(model, context, options)
	if (model?.transport === "responses") return completeOpenAIResponses(model, context, options)
	return completeOpenAI(model, context, options)
}

export { streamOpenAI, completeOpenAI } from "./openai.js"
export { streamOpenAIResponses, completeOpenAIResponses } from "./openai-responses.js"
export { AssistantMessageEventStream, EventStream } from "./event-stream.js"
export { parseStreamingJson, parseJsonWithRepair, repairJson } from "./json-parse.js"
export { sanitizeSurrogates } from "./sanitize-unicode.js"
export { parseSSE } from "./sse.js"
export { transformMessages } from "./transform-messages.js"
export { validateValue, validateToolCall, validateToolArguments } from "./validate.js"
