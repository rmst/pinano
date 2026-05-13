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

import type { ImageContent } from "../ai-apis/types.js"

/** Mirrors agent-core ThinkingLevel without importing JS types. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high"

/** Pinano model shape — subset of pi's Model<any>. Whatever ai-apis consumes. */
export interface RpcModel {
	id: string
	provider: string
	baseUrl: string
	reasoning: boolean
	contextWindow: number
	maxTokens: number
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction (pinano: no customInstructions yet — drop-in with default prompt)
	| { id?: string; type: "compact"; customInstructions?: string }
	// pinano always-on auto-compaction (transformContext gate); toggle deferred.
	// | { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry — not implemented in pinano (no auto-retry feature).
	// | { id?: string; type: "set_auto_retry"; enabled: boolean }
	// | { id?: string; type: "abort_retry" }

	// Bash — being added in the parallel `pinano-features` worktree
	// (bash-shortcut.ts). Once that lands, uncomment and wire to the same exec.
	// | { id?: string; type: "bash"; command: string }
	// | { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	// Won't add — pi-only feature.
	// | { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands available for invocation via prompt — depends on extensions /
	// skills / prompt templates, none of which pinano has yet. Parallel work
	// may add some. Uncomment and populate from the registry when it lands.
	// | { id?: string; type: "get_commands" }

// ============================================================================
// RPC Slash Command (for get_commands response — kept for later)
// ============================================================================

export interface RpcSlashCommand {
	name: string
	description?: string
	source: "extension" | "prompt" | "skill"
	location?: "user" | "project" | "path"
	path?: string
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: RpcModel
	thinkingLevel: ThinkingLevel
	isStreaming: boolean
	isCompacting: boolean
	steeringMode: "all" | "one-at-a-time"
	followUpMode: "all" | "one-at-a-time"
	sessionFile?: string
	sessionId: string
	sessionName?: string
	autoCompactionEnabled: boolean
	messageCount: number
	pendingMessageCount: number
}

export interface RpcSessionStats {
	messageCount: number
	tokensUsed: number
	contextWindow: number
	usageRatio: number
}

export interface RpcCompactionResult {
	summary: string
	keptCount: number
	removedCount: number
	tokensBefore: number
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

export type RpcResponse =
	// Prompting (async — events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean; sessionId: string } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| { id?: string; type: "response"; command: "set_model"; success: true; data: RpcModel }
	| {
			id?: string
			type: "response"
			command: "cycle_model"
			success: true
			data: { model: RpcModel; thinkingLevel: ThinkingLevel; isScoped: boolean } | null
	  }
	| { id?: string; type: "response"; command: "get_available_models"; success: true; data: { models: RpcModel[] } }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string
			type: "response"
			command: "cycle_thinking_level"
			success: true
			data: { level: ThinkingLevel } | null
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: RpcCompactionResult }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: RpcSessionStats }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string
			type: "response"
			command: "get_fork_messages"
			success: true
			data: { messages: Array<{ entryId: string; text: string }> }
	  }
	| {
			id?: string
			type: "response"
			command: "get_last_assistant_text"
			success: true
			data: { text: string | null }
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: any[] } }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string }

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"]
