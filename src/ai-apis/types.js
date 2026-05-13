// Type definitions for ai-apis. JSDoc-only — no runtime values.

/**
 * @typedef {object} TextContent
 * @property {"text"} type
 * @property {string} text
 * @property {string} [textSignature]
 */

/**
 * @typedef {object} ThinkingContent
 * @property {"thinking"} type
 * @property {string} thinking
 * @property {string} [thinkingSignature]
 * @property {boolean} [redacted]
 */

/**
 * @typedef {object} ImageContent
 * @property {"image"} type
 * @property {string} data Base64-encoded bytes
 * @property {string} mimeType
 */

/**
 * @typedef {object} ToolCall
 * @property {"toolCall"} type
 * @property {string} id
 * @property {string} name
 * @property {Record<string, any>} arguments
 */

/**
 * @typedef {object} Cost
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} total
 */

/**
 * @typedef {object} Usage
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} totalTokens
 * @property {Cost} cost
 */

/**
 * @typedef {"stop" | "length" | "toolUse" | "error" | "aborted"} StopReason
 */

/**
 * @typedef {object} UserMessage
 * @property {"user"} role
 * @property {string | (TextContent | ImageContent)[]} content
 * @property {number} [timestamp]
 */

/**
 * @typedef {object} AssistantMessage
 * @property {"assistant"} role
 * @property {(TextContent | ThinkingContent | ToolCall)[]} content
 * @property {string} provider
 * @property {string} model
 * @property {string} [responseModel]
 * @property {string} [responseId]
 * @property {Usage} usage
 * @property {StopReason} stopReason
 * @property {string} [errorMessage]
 * @property {number} timestamp
 */

/**
 * @typedef {object} ToolResultMessage
 * @property {"toolResult"} role
 * @property {string} toolCallId
 * @property {string} toolName
 * @property {(TextContent | ImageContent)[]} content
 * @property {boolean} isError
 * @property {number} [timestamp]
 */

/**
 * @typedef {UserMessage | AssistantMessage | ToolResultMessage} Message
 */

/**
 * A tool definition. `parameters` is a plain JSON Schema object.
 * @typedef {object} Tool
 * @property {string} name
 * @property {string} description
 * @property {Record<string, any>} parameters JSON Schema for the tool arguments
 */

/**
 * @typedef {object} Context
 * @property {string} [systemPrompt]
 * @property {Message[]} messages
 * @property {Tool[]} [tools]
 */

/**
 * Pricing in USD per million tokens.
 * @typedef {object} ModelCost
 * @property {number} [input]
 * @property {number} [output]
 * @property {number} [cacheRead]
 * @property {number} [cacheWrite]
 */

/**
 * Compatibility flags for OpenAI-compatible servers (Ollama, vLLM, LM Studio, etc).
 * Defaults match OpenAI's hosted Chat Completions API.
 * @typedef {object} OpenAICompat
 * @property {boolean} [supportsStore] Send `store: false`. Default: true.
 * @property {boolean} [supportsDeveloperRole] Use `developer` role for system prompt with reasoning models. Default: true.
 * @property {boolean} [supportsReasoningEffort] Send `reasoning_effort`. Default: true.
 * @property {boolean} [supportsUsageInStreaming] Send `stream_options.include_usage`. Default: true.
 * @property {boolean} [supportsStrictMode] Include `strict: false` in tool defs. Default: true.
 * @property {"max_completion_tokens" | "max_tokens"} [maxTokensField] Default: max_completion_tokens.
 * @property {boolean} [requiresToolResultName] Send `name` on tool messages. Default: false.
 * @property {boolean} [requiresAssistantAfterToolResult] Insert empty assistant after tool results. Default: false.
 * @property {boolean} [supportsPromptCacheKey] Send `prompt_cache_key` from sessionId. Default: true.
 */

/**
 * @typedef {object} Model
 * @property {string} id Model id sent to the API
 * @property {string} [name] Human-readable name
 * @property {string} [provider] Free-form provider tag (e.g. "openai", "ollama")
 * @property {string} baseUrl API base URL, e.g. "https://api.openai.com/v1"
 * @property {boolean} [reasoning] Whether the model supports reasoning_effort
 * @property {("text" | "image")[]} [input] Modalities the model accepts. Default: ["text"]
 * @property {ModelCost} [cost]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {Record<string, string>} [headers] Extra HTTP headers
 * @property {OpenAICompat} [compat]
 */

/**
 * @typedef {object} StreamOptions
 * @property {string} [apiKey]
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {AbortSignal} [signal]
 * @property {string} [sessionId] Sent as prompt_cache_key when supported
 * @property {Record<string, string>} [headers]
 * @property {(payload: any, model: Model) => any} [onPayload]
 * @property {(response: { status: number, headers: Record<string, string> }, model: Model) => void | Promise<void>} [onResponse]
 * @property {"auto" | "none" | "required" | { type: "function", function: { name: string } }} [toolChoice]
 * @property {"minimal" | "low" | "medium" | "high"} [reasoningEffort]
 */

/**
 * @typedef {{type: "start", partial: AssistantMessage}
 *   | {type: "text_start", contentIndex: number, partial: AssistantMessage}
 *   | {type: "text_delta", contentIndex: number, delta: string, partial: AssistantMessage}
 *   | {type: "text_end", contentIndex: number, content: string, partial: AssistantMessage}
 *   | {type: "thinking_start", contentIndex: number, partial: AssistantMessage}
 *   | {type: "thinking_delta", contentIndex: number, delta: string, partial: AssistantMessage}
 *   | {type: "thinking_end", contentIndex: number, content: string, partial: AssistantMessage}
 *   | {type: "toolcall_start", contentIndex: number, partial: AssistantMessage}
 *   | {type: "toolcall_delta", contentIndex: number, delta: string, partial: AssistantMessage}
 *   | {type: "toolcall_end", contentIndex: number, toolCall: ToolCall, partial: AssistantMessage}
 *   | {type: "done", reason: "stop" | "length" | "toolUse", message: AssistantMessage}
 *   | {type: "error", reason: "aborted" | "error", error: AssistantMessage}
 * } AssistantMessageEvent
 */

export {}
