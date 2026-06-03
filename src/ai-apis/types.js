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
 * @property {"high" | "original" | "auto" | "low"} [detail]
 * @property {number} [widthPx]
 * @property {number} [heightPx]
 */

/**
 * @typedef {object} ToolCall
 * @property {"toolCall"} type
 * @property {string} id
 * @property {string} name
 * @property {Record<string, any>} [arguments] JSON/function tool arguments.
 * @property {string} [input] Custom/freeform tool input.
 */

/**
 * @typedef {object} Cost
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} total
 * @property {"USD" | string} [currency]
 * @property {string} [pricingVersion]
 */

/**
 * Provider/account context used for usage accounting. `credentialId` is the
 * local credential slot, not a secret.
 * @typedef {object} AssistantAuth
 * @property {string} [provider]
 * @property {string} [credentialId]
 * @property {string} [accountId]
 * @property {string} [subscriptionId]
 */

/**
 * @typedef {object} Usage
 * @property {number} input Non-cached, non-cache-write input tokens.
 * @property {number} output Provider/billing output tokens; reasoning output is a subset when reported.
 * @property {number} [reasoningOutput]
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} totalTokens Provider total when reported; otherwise normalized sum.
 * @property {number} [providerTotalTokens]
 * @property {any} [raw] Raw provider usage payload, for future accounting/backfills.
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
 * @property {AssistantAuth} [auth]
 * @property {string} [responseModel]
 * @property {string} [responseId]
 * @property {string} [modelRequestId] ID in model I/O log when enabled.
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
 * A JSON/function tool definition. `parameters` is a plain JSON Schema object.
 *
 * @typedef {object} FunctionTool
 * @property {"function"} [kind]
 * @property {string} name
 * @property {string} description
 * @property {Record<string, any>} parameters JSON Schema for the tool arguments
 *
 * @typedef {object} CustomTool
 * @property {"custom"} kind
 * @property {string} name
 * @property {string} description
 * @property {{ type: "grammar", syntax: "lark", definition: string }} [format]
 *
 * @typedef {FunctionTool | CustomTool} Tool
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
 * @property {string} [costVersion]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {number|false|null} [responseHeaderTimeoutMs] Override Responses transport timeout before response headers.
 * @property {number|false|null} [streamInactivityTimeoutMs] Override timeout while waiting for SSE stream data after response headers.
 * @property {Record<string, string>} [headers] Extra HTTP headers
 * @property {OpenAICompat} [compat]
 * @property {boolean} [supportsTextVerbosity]
 * @property {"low" | "medium" | "high"} [defaultTextVerbosity]
 * @property {boolean} [supportsParallelToolCalls]
 * @property {("none" | "minimal" | "low" | "medium" | "high" | "xhigh")[]} [supportedReasoningLevels]
 * @property {"none" | "minimal" | "low" | "medium" | "high" | "xhigh"} [defaultReasoningLevel]
 * @property {string} [baseInstructionsKey]
 * @property {string} [maintenanceModelRef]
 * @property {"default" | "codex"} [toolProfile]
 */

/**
 * @typedef {object} StreamOptions
 * @property {string} [apiKey]
 * @property {AssistantAuth} [auth]
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {AbortSignal} [signal]
 * @property {string} [sessionId] Sent as prompt_cache_key when supported
 * @property {number|false|null} [responseHeaderTimeoutMs] Override Responses transport timeout before response headers.
 * @property {number|false|null} [streamInactivityTimeoutMs] Override timeout while waiting for SSE stream data after response headers.
 * @property {string} [serviceTier]
 * @property {Record<string, string>} [headers]
 * @property {(payload: any, model: Model) => any} [onPayload]
 * @property {(response: { status: number, headers: Record<string, string> }, model: Model) => void | Promise<void>} [onResponse]
 * @property {"auto" | "none" | "required" | { type: "function", function: { name: string } }} [toolChoice]
 * @property {"none" | "minimal" | "low" | "medium" | "high" | "xhigh"} [reasoningEffort]
 * @property {"low" | "medium" | "high"} [textVerbosity]
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
