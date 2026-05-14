// RPC protocol types. Ported from pi-mono `coding-agent/src/modes/rpc/rpc-types.ts`
// (commit 3d5cbe98). Verbatim where possible so the cross-walk to pi stays trivial.
//
// Pinano-specific deviations are flagged inline. Commands pi has but pinano
// can't yet fulfil are kept here as comments rather than deleted, so the next
// person porting the missing feature can just uncomment + wire.
//
// Protocol summary:
//   - Commands: JSON objects with `type`, optional `id` for correlation.
//   - Responses: JSON objects with `type:"response"`, `command`, `success`,
//     and optional `data`/`error`.
//   - Events: AgentEvent objects from agent-core, JSON-serialized as-is.

/** @typedef {import("../ai-apis/types.js").ImageContent} ImageContent */

/**
 * Mirrors agent-core ThinkingLevel without importing JS types.
 * @typedef {"off" | "minimal" | "low" | "medium" | "high"} ThinkingLevel
 */

/**
 * Pinano model shape — subset of pi's Model<any>. Whatever ai-apis consumes.
 * @typedef {object} RpcModel
 * @property {string} id
 * @property {string} provider
 * @property {string} baseUrl
 * @property {boolean} reasoning
 * @property {number} contextWindow
 * @property {number} maxTokens
 * @property {{ input: number, output: number, cacheRead: number, cacheWrite: number }} cost
 */

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

/**
 * @typedef {(
 *   | { id?: string, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }
 *   | { id?: string, type: "steer", message: string, images?: ImageContent[] }
 *   | { id?: string, type: "follow_up", message: string, images?: ImageContent[] }
 *   | { id?: string, type: "abort" }
 *   | { id?: string, type: "new_session", parentSession?: string }
 *   | { id?: string, type: "get_state" }
 *   | { id?: string, type: "set_model", provider: string, modelId: string }
 *   | { id?: string, type: "cycle_model" }
 *   | { id?: string, type: "get_available_models" }
 *   | { id?: string, type: "set_thinking_level", level: ThinkingLevel }
 *   | { id?: string, type: "cycle_thinking_level" }
 *   | { id?: string, type: "set_steering_mode", mode: "all" | "one-at-a-time" }
 *   | { id?: string, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }
 *   | { id?: string, type: "compact", customInstructions?: string }
 *   | { id?: string, type: "get_session_stats" }
 *   | { id?: string, type: "switch_session", sessionPath: string }
 *   | { id?: string, type: "fork", entryId: string }
 *   | { id?: string, type: "get_fork_messages" }
 *   | { id?: string, type: "get_last_assistant_text" }
 *   | { id?: string, type: "set_session_name", name: string }
 *   | { id?: string, type: "get_messages" }
 * )} RpcCommand
 */

// ============================================================================
// RPC Slash Command (for get_commands response — kept for later)
// ============================================================================

/**
 * @typedef {object} RpcSlashCommand
 * @property {string} name
 * @property {string} [description]
 * @property {"extension" | "prompt" | "skill"} source
 * @property {"user" | "project" | "path"} [location]
 * @property {string} [path]
 */

// ============================================================================
// RPC State
// ============================================================================

/**
 * @typedef {object} RpcSessionState
 * @property {RpcModel} [model]
 * @property {ThinkingLevel} thinkingLevel
 * @property {boolean} isStreaming
 * @property {boolean} isCompacting
 * @property {"all" | "one-at-a-time"} steeringMode
 * @property {"all" | "one-at-a-time"} followUpMode
 * @property {string} [sessionFile]
 * @property {string} sessionId
 * @property {string} [sessionName]
 * @property {boolean} autoCompactionEnabled
 * @property {number} messageCount
 * @property {number} pendingMessageCount
 */

/**
 * @typedef {object} RpcSessionStats
 * @property {number} messageCount
 * @property {number} tokensUsed
 * @property {number} contextWindow
 * @property {number} usageRatio
 */

/**
 * @typedef {object} RpcCompactionResult
 * @property {string} summary
 * @property {number} keptCount
 * @property {number} removedCount
 * @property {number} tokensBefore
 */

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

/**
 * @typedef {(
 *   | { id?: string, type: "response", command: "prompt", success: true }
 *   | { id?: string, type: "response", command: "steer", success: true }
 *   | { id?: string, type: "response", command: "follow_up", success: true }
 *   | { id?: string, type: "response", command: "abort", success: true }
 *   | { id?: string, type: "response", command: "new_session", success: true, data: { cancelled: boolean, sessionId: string } }
 *   | { id?: string, type: "response", command: "get_state", success: true, data: RpcSessionState }
 *   | { id?: string, type: "response", command: "set_model", success: true, data: RpcModel }
 *   | { id?: string, type: "response", command: "cycle_model", success: true, data: { model: RpcModel, thinkingLevel: ThinkingLevel, isScoped: boolean } | null }
 *   | { id?: string, type: "response", command: "get_available_models", success: true, data: { models: RpcModel[] } }
 *   | { id?: string, type: "response", command: "set_thinking_level", success: true }
 *   | { id?: string, type: "response", command: "cycle_thinking_level", success: true, data: { level: ThinkingLevel } | null }
 *   | { id?: string, type: "response", command: "set_steering_mode", success: true }
 *   | { id?: string, type: "response", command: "set_follow_up_mode", success: true }
 *   | { id?: string, type: "response", command: "compact", success: true, data: RpcCompactionResult }
 *   | { id?: string, type: "response", command: "get_session_stats", success: true, data: RpcSessionStats }
 *   | { id?: string, type: "response", command: "switch_session", success: true, data: { cancelled: boolean } }
 *   | { id?: string, type: "response", command: "fork", success: true, data: { text: string, cancelled: boolean } }
 *   | { id?: string, type: "response", command: "get_fork_messages", success: true, data: { messages: Array<{ entryId: string, text: string }> } }
 *   | { id?: string, type: "response", command: "get_last_assistant_text", success: true, data: { text: string | null } }
 *   | { id?: string, type: "response", command: "set_session_name", success: true }
 *   | { id?: string, type: "response", command: "get_messages", success: true, data: { messages: any[] } }
 *   | { id?: string, type: "response", command: string, success: false, error: string }
 * )} RpcResponse
 */

// ============================================================================
// Helper type for extracting command types
// ============================================================================

/** @typedef {RpcCommand["type"]} RpcCommandType */

export {}
