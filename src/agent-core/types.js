// JSDoc typedefs for the agent loop.
//
// `AgentMessage` is `Message | <custom messages>`. Apps that need extra
// transcript entries (notifications, artifacts, …) extend the union manually
// where they import these types — JS has no declaration merging, so the union
// stays open via the `any` escape hatch in JSDoc usages.

/**
 * @typedef {import("../ai-apis/types.js").TextContent} TextContent
 * @typedef {import("../ai-apis/types.js").ImageContent} ImageContent
 * @typedef {import("../ai-apis/types.js").Message} Message
 * @typedef {import("../ai-apis/types.js").AssistantMessage} AssistantMessage
 * @typedef {import("../ai-apis/types.js").AssistantMessageEvent} AssistantMessageEvent
 * @typedef {import("../ai-apis/types.js").ToolResultMessage} ToolResultMessage
 * @typedef {import("../ai-apis/types.js").ToolCall} ToolCall
 * @typedef {import("../ai-apis/types.js").Tool} Tool
 * @typedef {import("../ai-apis/types.js").Model} Model
 * @typedef {import("../ai-apis/types.js").Context} Context
 */

/** @typedef {"off" | "minimal" | "low" | "medium" | "high"} ThinkingLevel */

/** @typedef {"sequential" | "parallel"} ToolExecutionMode */

/** @typedef {Message | { role: string, [k: string]: any }} AgentMessage */

/** @typedef {{ type: "toolCall", id: string, name: string, arguments: Record<string, any> }} AgentToolCall */

/**
 * @template T
 * @typedef {object} AgentToolResult
 * @property {(TextContent | ImageContent)[]} content
 * @property {T} details
 * @property {boolean} [terminate]
 */

/**
 * @template [T=any]
 * @callback AgentToolUpdateCallback
 * @param {AgentToolResult<T>} partial
 * @returns {void}
 */

/**
 * @template [TDetails=any]
 * @typedef {Tool & {
 *   label: string,
 *   prepareArguments?: (args: unknown) => Record<string, any>,
 *   execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<TDetails>) => Promise<AgentToolResult<TDetails>>,
 *   executionMode?: ToolExecutionMode,
 * }} AgentTool
 */

/**
 * @typedef {object} AgentContext
 * @property {string} systemPrompt
 * @property {AgentMessage[]} messages
 * @property {AgentTool[]} [tools]
 */

/**
 * @typedef {object} BeforeToolCallContext
 * @property {AssistantMessage} assistantMessage
 * @property {AgentToolCall} toolCall
 * @property {unknown} args
 * @property {AgentContext} context
 */

/**
 * @typedef {object} BeforeToolCallResult
 * @property {boolean} [block]
 * @property {string} [reason]
 */

/**
 * @typedef {object} AfterToolCallContext
 * @property {AssistantMessage} assistantMessage
 * @property {AgentToolCall} toolCall
 * @property {unknown} args
 * @property {AgentToolResult<any>} result
 * @property {boolean} isError
 * @property {AgentContext} context
 */

/**
 * @typedef {object} AfterToolCallResult
 * @property {(TextContent | ImageContent)[]} [content]
 * @property {unknown} [details]
 * @property {boolean} [isError]
 * @property {boolean} [terminate]
 */

/**
 * @typedef {object} ShouldStopAfterTurnContext
 * @property {AssistantMessage} message
 * @property {ToolResultMessage[]} toolResults
 * @property {AgentContext} context
 * @property {AgentMessage[]} newMessages
 */

/**
 * @typedef {object} AgentLoopConfig
 * @property {Model} model
 * @property {ThinkingLevel} [reasoning]
 * @property {string} [apiKey]
 * @property {string} [sessionId]
 * @property {AbortSignal} [signal]
 * @property {ToolExecutionMode} [toolExecution]
 * @property {(payload: any, model: Model) => any} [onPayload]
 * @property {(response: { status: number, headers: Record<string, string> }, model: Model) => void | Promise<void>} [onResponse]
 * @property {(messages: AgentMessage[]) => Message[] | Promise<Message[]>} convertToLlm
 * @property {(messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>} [transformContext]
 * @property {(provider: string) => Promise<string | undefined> | string | undefined} [getApiKey]
 * @property {(context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>} [shouldStopAfterTurn]
 * @property {() => Promise<AgentMessage[]>} [getSteeringMessages]
 * @property {() => Promise<AgentMessage[]>} [getFollowUpMessages]
 * @property {(context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>} [beforeToolCall]
 * @property {(context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>} [afterToolCall]
 */

/**
 * @typedef {{ type: "agent_start" }
 *   | { type: "agent_end", messages: AgentMessage[] }
 *   | { type: "turn_start" }
 *   | { type: "turn_end", message: AgentMessage, toolResults: ToolResultMessage[] }
 *   | { type: "message_start", message: AgentMessage }
 *   | { type: "message_update", message: AgentMessage, assistantMessageEvent: AssistantMessageEvent }
 *   | { type: "message_end", message: AgentMessage }
 *   | { type: "tool_execution_start", toolCallId: string, toolName: string, args: any }
 *   | { type: "tool_execution_update", toolCallId: string, toolName: string, args: any, partialResult: any }
 *   | { type: "tool_execution_end", toolCallId: string, toolName: string, result: any, isError: boolean }
 * } AgentEvent
 */

/**
 * Stream function signature used by the agent. Must return (or resolve to) an
 * `AssistantMessageEventStream` from ai-apis. Errors should be encoded in the
 * stream — never thrown.
 * @typedef {(model: Model, ctx: Context, options: any) => any} StreamFn
 */

export {}
