// Session entry types. The on-disk format is a header line followed by one
// JSON entry per line; entries form a tree via `parentId` adjacency.
//
// Pinano uses a small subset of pi-mono's session entries:
//   - "message"      a transcript message (user, assistant, toolResult, …)
//   - "label"        attach a human label to another entry (for branch picking)
//   - "session_info" rename the session
//   - "custom"       app-defined extension hook (data is opaque)

/**
 * @typedef {object} BaseEntry
 * @property {string} id
 * @property {string | null} parentId
 * @property {string} timestamp ISO 8601
 */

/**
 * @typedef {BaseEntry & { type: "message", message: import("../agent-core/types.js").AgentMessage }} MessageEntry
 * @typedef {BaseEntry & { type: "label", targetId: string, label?: string }} LabelEntry
 * @typedef {BaseEntry & { type: "session_info", name: string }} SessionInfoEntry
 * @typedef {BaseEntry & { type: "custom", customType: string, data?: unknown }} CustomEntry
 */

/** @typedef {MessageEntry | LabelEntry | SessionInfoEntry | CustomEntry} SessionEntry */

/**
 * @typedef {object} SessionMetadata
 * @property {string} id
 * @property {string} createdAt ISO 8601
 * @property {string} cwd
 * @property {string} [parentSessionPath]
 */

export {}
