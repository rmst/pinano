// Session entry types. Entries form a tree via `parentId` adjacency and are
// stored canonically in normalized SQLite tables.
//
// Cerex uses a small subset of pi-mono's session entries:
//   - "message"      a transcript message (user, assistant, toolResult, …)
//   - "label"        attach a human label to another entry (for branch picking)
//   - "custom"       app-defined extension hook; app code gives selected
//                      custom types replay semantics (e.g. compaction,
//                      durable tool_execution recovery markers)
//   - "context"      exact AGENTS.md/CLAUDE.md snapshots anchored to the
//                      branch but projected outside conversation history

/**
 * @typedef {object} BaseEntry
 * @property {string} id
 * @property {string | null} parentId
 * @property {string} timestamp ISO 8601
 */

/**
 * @typedef {{ source: string, cwd?: string, loadedAt?: string, disabled?: boolean, files: Array<{ path: string, scopeDir?: string, identityPath?: string, content: string, hash?: string }> }} ContextLoad
 * @typedef {BaseEntry & { type: "message", message: import("../agent-core/types.js").AgentMessage, contextLoad?: ContextLoad }} MessageEntry
 * @typedef {BaseEntry & { type: "label", targetId: string, label?: string, contextLoad?: ContextLoad }} LabelEntry
 * @typedef {BaseEntry & { type: "custom", customType: string, data?: unknown, contextLoad?: ContextLoad }} CustomEntry
 * @typedef {BaseEntry & { type: "context", contextLoad: ContextLoad }} ContextEntry
 */

/** @typedef {MessageEntry | LabelEntry | CustomEntry | ContextEntry} SessionEntry */

/**
 * @typedef {object} SessionMetadata
 * @property {string} id
 * @property {string} createdAt ISO 8601
 * @property {string} cwd
 */

export {}
