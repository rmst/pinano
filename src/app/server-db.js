// SQLite database for Pinano server/web mode.
//
// This is the canonical store for sessions, transcript/tree entries, run
// records, service lifecycle rows, and server/client coordination. Keep schema
// changes as explicit migrations using PRAGMA user_version, matching the
// pattern used in our other apps.

import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { serverDbPath } from "./paths.js"
import {
	LEGACY_SESSION_CUSTOM_TYPE_WEB_REWIND,
	LEGACY_SESSION_CUSTOM_TYPE_WEB_TREE_SWITCH,
	SESSION_CUSTOM_TYPE_BRANCH_SWITCH,
	SESSION_CUSTOM_TYPE_REWIND,
} from "./session-custom-types.js"

const SCHEMA_VERSION = 27
const SESSION_PREVIEW_BATCH_SIZE = 200

const HIDDEN_MESSAGE_EXTRA_SQL = `
	em.extra_json IS NOT NULL
	AND json_valid(em.extra_json)
	AND (
		COALESCE(json_extract(em.extra_json, '$.pinanoAutomated'), 0) = 1
		OR COALESCE(json_extract(em.extra_json, '$.pinanoHidden'), 0) = 1
		OR COALESCE(json_extract(em.extra_json, '$.pinanoCompactionMemento'), 0) = 1
		OR COALESCE(json_extract(em.extra_json, '$.pinanoCompactionSummary'), 0) = 1
		OR json_type(em.extra_json, '$.pinanoMaintenance') IS NOT NULL
	)
`

const PROJECT_CONTEXT_EXTRA_SQL = `
	em.role = 'user'
	AND em.extra_json IS NOT NULL
	AND json_valid(em.extra_json)
	AND COALESCE(json_extract(em.extra_json, '$.projectContext'), 0) = 1
`

const migrations = [
	// v0 → v1: initial server metadata schema.
	(db) => {
		db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				cwd TEXT NOT NULL,
				path TEXT NOT NULL,
				name TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				deleted_at TEXT
			)
		`)
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_sessions_cwd_updated
			ON sessions(cwd, updated_at DESC)
		`)
		db.exec(`
			CREATE TABLE IF NOT EXISTS runs (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id),
				status TEXT NOT NULL,
				started_at TEXT NOT NULL,
				ended_at TEXT,
				error TEXT,
				stop_reason TEXT
			)
		`)
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_runs_session_started
			ON runs(session_id, started_at DESC)
		`)
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_runs_status
			ON runs(status)
		`)
	},
	// v1 → v2: explicit per-session runtime state. This is distinct from
	// latest run status: idle sessions are waiting for user input, whereas
	// interrupted/paused sessions stopped at a resumable boundary.
	(db) => {
		db.exec("ALTER TABLE sessions ADD COLUMN runtime_state TEXT NOT NULL DEFAULT 'idle'")
		db.exec("ALTER TABLE sessions ADD COLUMN runtime_state_updated_at TEXT")
	},
	// v2 → v3: model-generated metadata for agent-view rows.
	(db) => {
		db.exec("ALTER TABLE sessions ADD COLUMN agent_view_state TEXT")
		db.exec("ALTER TABLE sessions ADD COLUMN agent_view_description TEXT")
		db.exec("ALTER TABLE sessions ADD COLUMN agent_view_needs_input TEXT")
		db.exec("ALTER TABLE sessions ADD COLUMN agent_view_result TEXT")
		db.exec("ALTER TABLE sessions ADD COLUMN agent_view_updated_at TEXT")
	},
	// v3 → v4: durable service lifecycle records. A service crash may prevent
	// in-process cleanup, so startup recovery turns stale running rows into an
	// explicit "unexpected_exit" record.
	(db) => {
		db.exec(`
			CREATE TABLE IF NOT EXISTS service_runs (
				id TEXT PRIMARY KEY,
				pid INTEGER,
				cwd TEXT NOT NULL,
				transport TEXT,
				port INTEGER,
				code_fingerprint TEXT,
				status TEXT NOT NULL,
				started_at TEXT NOT NULL,
				ended_at TEXT,
				exit_code INTEGER,
				signal TEXT,
				reason TEXT
			)
		`)
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_service_runs_status_started
			ON service_runs(status, started_at DESC)
		`)
	},
	// v4 → v5: retired agent-view summary fields used to live here.
	() => {},
	// v5 → v6: retired agent-view summary coverage marker used to live here.
	() => {},
	// v6 → v7: stable project/work-area tag for agent-view rows.
	(db) => {
		db.exec("ALTER TABLE sessions ADD COLUMN agent_view_project_tag TEXT")
	},
	// v7 → v8: move transcript/tree state from per-session JSONL files into
	// normalized SQLite tables. The old sessions.path column is intentionally
	// removed; sessions are addressed by id, not by file path.
	(db) => {
		db.exec(`
			CREATE TABLE sessions_new (
				id TEXT PRIMARY KEY,
				cwd TEXT NOT NULL,
				name TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				deleted_at TEXT,
				active_leaf_entry_id TEXT,
				runtime_state TEXT NOT NULL DEFAULT 'idle',
				runtime_state_updated_at TEXT,
				agent_view_state TEXT,
				agent_view_description TEXT,
				agent_view_needs_input TEXT,
				agent_view_result TEXT,
				agent_view_updated_at TEXT,
				agent_view_project_tag TEXT
			)
		`)
		db.exec(`
			INSERT INTO sessions_new (
				id,
				cwd,
				name,
				created_at,
				updated_at,
				deleted_at,
				runtime_state,
				runtime_state_updated_at,
				agent_view_state,
				agent_view_description,
				agent_view_needs_input,
				agent_view_result,
				agent_view_updated_at,
				agent_view_project_tag
			)
			SELECT
				id,
				cwd,
				name,
				created_at,
				updated_at,
				deleted_at,
				runtime_state,
				runtime_state_updated_at,
				agent_view_state,
				agent_view_description,
				agent_view_needs_input,
				agent_view_result,
				agent_view_updated_at,
				agent_view_project_tag
			FROM sessions
		`)
		db.exec(`
			CREATE TABLE runs_preserved AS
			SELECT id, session_id, status, started_at, ended_at, error, stop_reason
			FROM runs
		`)
		db.exec("DROP TABLE runs")
		db.exec("DROP TABLE sessions")
		db.exec("ALTER TABLE sessions_new RENAME TO sessions")
		db.exec(`
			CREATE TABLE runs (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id),
				status TEXT NOT NULL,
				started_at TEXT NOT NULL,
				ended_at TEXT,
				error TEXT,
				stop_reason TEXT
			)
		`)
		db.exec(`
			INSERT INTO runs (id, session_id, status, started_at, ended_at, error, stop_reason)
			SELECT id, session_id, status, started_at, ended_at, error, stop_reason
			FROM runs_preserved
		`)
		db.exec("DROP TABLE runs_preserved")
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_runs_session_started
			ON runs(session_id, started_at DESC)
		`)
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_runs_status
			ON runs(status)
		`)
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_sessions_cwd_updated
			ON sessions(cwd, updated_at DESC)
		`)
		db.exec(`
			CREATE TABLE IF NOT EXISTS session_entries (
				session_id TEXT NOT NULL REFERENCES sessions(id),
				id TEXT NOT NULL,
				parent_id TEXT,
				seq INTEGER NOT NULL,
				timestamp TEXT NOT NULL,
				kind TEXT NOT NULL,
				PRIMARY KEY (session_id, id),
				UNIQUE (session_id, seq)
			)
		`)
		db.exec("CREATE INDEX IF NOT EXISTS idx_session_entries_seq ON session_entries(session_id, seq)")
		db.exec("CREATE INDEX IF NOT EXISTS idx_session_entries_parent ON session_entries(session_id, parent_id)")
		db.exec("CREATE INDEX IF NOT EXISTS idx_session_entries_kind ON session_entries(session_id, kind)")
		db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				session_id TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				role TEXT NOT NULL,
				content_format TEXT NOT NULL,
				timestamp INTEGER,
				provider TEXT,
				model TEXT,
				auth_json TEXT,
				response_model TEXT,
				response_id TEXT,
				model_request_id TEXT,
				stop_reason TEXT,
				error_message TEXT,
				tool_call_id TEXT,
				tool_name TEXT,
				is_error INTEGER,
				details_json TEXT,
				extra_json TEXT,
				PRIMARY KEY (session_id, entry_id),
				FOREIGN KEY (session_id, entry_id) REFERENCES session_entries(session_id, id)
			)
		`)
		db.exec("CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(session_id, role)")
		db.exec("CREATE INDEX IF NOT EXISTS idx_messages_tool_call ON messages(session_id, tool_call_id)")
		db.exec(`
			CREATE TABLE IF NOT EXISTS message_blocks (
				session_id TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				type TEXT NOT NULL,
				text TEXT,
				text_signature TEXT,
				thinking TEXT,
				thinking_signature TEXT,
				redacted INTEGER,
				image_data TEXT,
				image_mime_type TEXT,
				image_detail TEXT,
				image_width_px INTEGER,
				image_height_px INTEGER,
				tool_call_id TEXT,
				tool_name TEXT,
				tool_args_json TEXT,
				payload_json TEXT,
				PRIMARY KEY (session_id, entry_id, ordinal),
				FOREIGN KEY (session_id, entry_id) REFERENCES session_entries(session_id, id)
			)
		`)
		db.exec("CREATE INDEX IF NOT EXISTS idx_message_blocks_tool_call ON message_blocks(session_id, tool_call_id)")
		db.exec(`
			CREATE TABLE IF NOT EXISTS usage (
				session_id TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				input_tokens INTEGER NOT NULL DEFAULT 0,
				output_tokens INTEGER NOT NULL DEFAULT 0,
				reasoning_output_tokens INTEGER,
				cache_read_tokens INTEGER NOT NULL DEFAULT 0,
				cache_write_tokens INTEGER NOT NULL DEFAULT 0,
				total_tokens INTEGER NOT NULL DEFAULT 0,
				provider_total_tokens INTEGER,
				cost_input REAL NOT NULL DEFAULT 0,
				cost_output REAL NOT NULL DEFAULT 0,
				cost_cache_read REAL NOT NULL DEFAULT 0,
				cost_cache_write REAL NOT NULL DEFAULT 0,
				cost_total REAL NOT NULL DEFAULT 0,
				cost_currency TEXT,
				pricing_version TEXT,
				raw_json TEXT,
				PRIMARY KEY (session_id, entry_id),
				FOREIGN KEY (session_id, entry_id) REFERENCES session_entries(session_id, id)
			)
		`)
		db.exec(`
			CREATE TABLE IF NOT EXISTS labels (
				session_id TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				target_entry_id TEXT NOT NULL,
				label TEXT,
				PRIMARY KEY (session_id, entry_id),
				FOREIGN KEY (session_id, entry_id) REFERENCES session_entries(session_id, id)
			)
		`)
		db.exec("CREATE INDEX IF NOT EXISTS idx_labels_target ON labels(session_id, target_entry_id)")
		db.exec(`
			CREATE TABLE IF NOT EXISTS session_info_entries (
				session_id TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				name TEXT NOT NULL,
				PRIMARY KEY (session_id, entry_id),
				FOREIGN KEY (session_id, entry_id) REFERENCES session_entries(session_id, id)
			)
		`)
		db.exec(`
			CREATE TABLE IF NOT EXISTS custom_entries (
				session_id TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				custom_type TEXT NOT NULL,
				data_json TEXT,
				PRIMARY KEY (session_id, entry_id),
				FOREIGN KEY (session_id, entry_id) REFERENCES session_entries(session_id, id)
			)
		`)
		db.exec("CREATE INDEX IF NOT EXISTS idx_custom_entries_type ON custom_entries(session_id, custom_type)")
	},
	// v8 → v9: first-class project instruction snapshots. Context loads are
	// anchored to the same session-entry tree as messages, but are projected
	// separately from conversation so compaction never summarizes them.
	(db) => {
		db.exec(`
			CREATE TABLE IF NOT EXISTS context_loads (
				session_id TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				source TEXT NOT NULL,
				cwd TEXT,
				loaded_at TEXT NOT NULL,
				disabled INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (session_id, entry_id),
				FOREIGN KEY (session_id, entry_id) REFERENCES session_entries(session_id, id)
			)
		`)
		db.exec("CREATE INDEX IF NOT EXISTS idx_context_loads_source ON context_loads(session_id, source)")
		db.exec(`
			CREATE TABLE IF NOT EXISTS context_files (
				session_id TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				path TEXT NOT NULL,
				scope_dir TEXT,
				content TEXT NOT NULL,
				hash TEXT,
				PRIMARY KEY (session_id, entry_id, ordinal),
				FOREIGN KEY (session_id, entry_id) REFERENCES context_loads(session_id, entry_id)
			)
		`)
		db.exec("CREATE INDEX IF NOT EXISTS idx_context_files_path ON context_files(session_id, path)")
	},
	// v9 → v10: cached session overview previews. The transcript/tree tables
	// remain canonical; these rows are rebuilt when the active leaf changes.
	(db) => {
		db.exec(`
			CREATE TABLE IF NOT EXISTS session_overviews (
				session_id TEXT PRIMARY KEY REFERENCES sessions(id),
				active_leaf_entry_id TEXT,
				first_entry_id TEXT,
				first_timestamp TEXT,
				first_role TEXT,
				first_text TEXT,
				last_user_entry_id TEXT,
				last_user_timestamp TEXT,
				last_user_text TEXT,
				computed_at TEXT NOT NULL
			)
		`)
	},
	// v10 → v11: rename frontend-specific branch-operation custom entry types.
	(db) => {
		db.prepare("UPDATE custom_entries SET custom_type = ? WHERE custom_type = ?")
			.run(SESSION_CUSTOM_TYPE_REWIND, LEGACY_SESSION_CUSTOM_TYPE_WEB_REWIND)
		db.prepare("UPDATE custom_entries SET custom_type = ? WHERE custom_type = ?")
			.run(SESSION_CUSTOM_TYPE_BRANCH_SWITCH, LEGACY_SESSION_CUSTOM_TYPE_WEB_TREE_SWITCH)
	},
	// v11 → v12: remove retired agent-view summary cache fields. Overview
	// maintenance now reads the current conversation context directly.
	(db) => {
		const columns = new Set(db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name))
		if (columns.has("agent_view_summary")) db.exec("ALTER TABLE sessions DROP COLUMN agent_view_summary")
		if (columns.has("agent_view_summary_entry_id")) db.exec("ALTER TABLE sessions DROP COLUMN agent_view_summary_entry_id")
	},
	// v12 → v13: rename service lifecycle storage from the old daemon name.
	(db) => {
		const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
		if (!tableExists("service_runs") && tableExists("daemon_runs")) {
			db.exec("ALTER TABLE daemon_runs RENAME TO service_runs")
		}
		db.exec("DROP INDEX IF EXISTS idx_daemon_runs_status_started")
		db.exec(`
			CREATE TABLE IF NOT EXISTS service_runs (
				id TEXT PRIMARY KEY,
				pid INTEGER,
				cwd TEXT NOT NULL,
				transport TEXT,
				port INTEGER,
				code_fingerprint TEXT,
				status TEXT NOT NULL,
				started_at TEXT NOT NULL,
				ended_at TEXT,
				exit_code INTEGER,
				signal TEXT,
				reason TEXT
			)
		`)
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_service_runs_status_started
			ON service_runs(status, started_at DESC)
		`)
	},
	// v13 → v14: split conversation entries from session membership. Entries and
	// payloads are now immutable global DAG nodes; sessions hold ordered refs to
	// the entries they can see. This lets a branched session share the inherited
	// prefix without duplicating message rows.
	(db) => {
		ensureServiceRunsTable(db)
		if (tableExists(db, "conversation_entries")) return
		const sessionColumns = tableColumns(db, "sessions")
		for (const [name, definition] of [
			["branched_from_session_id", "branched_from_session_id TEXT"],
			["branched_from_entry_id", "branched_from_entry_id TEXT"],
			["branched_from_entry_global_id", "branched_from_entry_global_id TEXT"],
			["branched_at", "branched_at TEXT"],
		]) {
			if (!sessionColumns.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${definition}`)
		}

		for (const table of [
			"session_entries",
			"messages",
			"message_blocks",
			"usage",
			"labels",
			"session_info_entries",
			"custom_entries",
			"context_loads",
			"context_files",
		]) db.exec(`ALTER TABLE ${table} RENAME TO legacy_${table}`)

		db.exec(`
			CREATE TABLE conversation_entries (
				global_id TEXT PRIMARY KEY,
				id TEXT NOT NULL,
				parent_global_id TEXT REFERENCES conversation_entries(global_id),
				created_by_session_id TEXT REFERENCES sessions(id),
				timestamp TEXT NOT NULL,
				kind TEXT NOT NULL
			)
		`)
		db.exec("CREATE INDEX idx_conversation_entries_parent ON conversation_entries(parent_global_id)")
		db.exec("CREATE INDEX idx_conversation_entries_created_by ON conversation_entries(created_by_session_id)")
		db.exec("CREATE INDEX idx_conversation_entries_display ON conversation_entries(id)")
		db.exec(`
			CREATE TABLE session_entry_refs (
				session_id TEXT NOT NULL REFERENCES sessions(id),
				global_id TEXT NOT NULL REFERENCES conversation_entries(global_id),
				seq INTEGER NOT NULL,
				PRIMARY KEY (session_id, global_id),
				UNIQUE (session_id, seq)
			)
		`)
		db.exec("CREATE INDEX idx_session_entry_refs_session_seq ON session_entry_refs(session_id, seq)")
		db.exec("CREATE INDEX idx_session_entry_refs_global ON session_entry_refs(global_id)")
		db.exec(`
			CREATE TABLE entry_messages (
				global_id TEXT PRIMARY KEY REFERENCES conversation_entries(global_id),
				role TEXT NOT NULL,
				content_format TEXT NOT NULL,
				timestamp INTEGER,
				provider TEXT,
				model TEXT,
				auth_json TEXT,
				response_model TEXT,
				response_id TEXT,
				model_request_id TEXT,
				stop_reason TEXT,
				error_message TEXT,
				tool_call_id TEXT,
				tool_name TEXT,
				is_error INTEGER,
				details_json TEXT,
				extra_json TEXT
			)
		`)
		db.exec("CREATE INDEX idx_entry_messages_role ON entry_messages(role)")
		db.exec("CREATE INDEX idx_entry_messages_tool_call ON entry_messages(tool_call_id)")
		db.exec(`
			CREATE TABLE entry_message_blocks (
				global_id TEXT NOT NULL REFERENCES conversation_entries(global_id),
				ordinal INTEGER NOT NULL,
				type TEXT NOT NULL,
				text TEXT,
				text_signature TEXT,
				thinking TEXT,
				thinking_signature TEXT,
				redacted INTEGER,
				image_data TEXT,
				image_mime_type TEXT,
				image_detail TEXT,
				image_width_px INTEGER,
				image_height_px INTEGER,
				tool_call_id TEXT,
				tool_name TEXT,
				tool_args_json TEXT,
				payload_json TEXT,
				PRIMARY KEY (global_id, ordinal)
			)
		`)
		db.exec("CREATE INDEX idx_entry_message_blocks_tool_call ON entry_message_blocks(tool_call_id)")
		db.exec(`
			CREATE TABLE entry_usage (
				global_id TEXT PRIMARY KEY REFERENCES conversation_entries(global_id),
				input_tokens INTEGER NOT NULL DEFAULT 0,
				output_tokens INTEGER NOT NULL DEFAULT 0,
				reasoning_output_tokens INTEGER,
				cache_read_tokens INTEGER NOT NULL DEFAULT 0,
				cache_write_tokens INTEGER NOT NULL DEFAULT 0,
				total_tokens INTEGER NOT NULL DEFAULT 0,
				provider_total_tokens INTEGER,
				cost_input REAL NOT NULL DEFAULT 0,
				cost_output REAL NOT NULL DEFAULT 0,
				cost_cache_read REAL NOT NULL DEFAULT 0,
				cost_cache_write REAL NOT NULL DEFAULT 0,
				cost_total REAL NOT NULL DEFAULT 0,
				cost_currency TEXT,
				pricing_version TEXT,
				raw_json TEXT
			)
		`)
		db.exec(`
			CREATE TABLE entry_labels (
				global_id TEXT PRIMARY KEY REFERENCES conversation_entries(global_id),
				target_global_id TEXT NOT NULL REFERENCES conversation_entries(global_id),
				label TEXT
			)
		`)
		db.exec("CREATE INDEX idx_entry_labels_target ON entry_labels(target_global_id)")
		db.exec(`
			CREATE TABLE entry_session_info (
				global_id TEXT PRIMARY KEY REFERENCES conversation_entries(global_id),
				name TEXT NOT NULL
			)
		`)
		db.exec(`
			CREATE TABLE entry_custom_entries (
				global_id TEXT PRIMARY KEY REFERENCES conversation_entries(global_id),
				custom_type TEXT NOT NULL,
				data_json TEXT
			)
		`)
		db.exec("CREATE INDEX idx_entry_custom_entries_type ON entry_custom_entries(custom_type)")
		db.exec(`
			CREATE TABLE entry_context_loads (
				global_id TEXT PRIMARY KEY REFERENCES conversation_entries(global_id),
				source TEXT NOT NULL,
				cwd TEXT,
				loaded_at TEXT NOT NULL,
				disabled INTEGER NOT NULL DEFAULT 0
			)
		`)
		db.exec("CREATE INDEX idx_entry_context_loads_source ON entry_context_loads(source)")
		db.exec(`
			CREATE TABLE entry_context_files (
				global_id TEXT NOT NULL REFERENCES conversation_entries(global_id),
				ordinal INTEGER NOT NULL,
				path TEXT NOT NULL,
				scope_dir TEXT,
				content TEXT NOT NULL,
				hash TEXT,
				PRIMARY KEY (global_id, ordinal)
			)
		`)
		db.exec("CREATE INDEX idx_entry_context_files_path ON entry_context_files(path)")

		db.exec(`
			INSERT INTO conversation_entries (global_id, id, parent_global_id, created_by_session_id, timestamp, kind)
			SELECT
				e.session_id || ':' || e.id,
				e.id,
				CASE WHEN parent.id IS NULL THEN NULL ELSE e.session_id || ':' || e.parent_id END,
				e.session_id,
				e.timestamp,
				e.kind
			FROM legacy_session_entries e
			LEFT JOIN legacy_session_entries parent ON parent.session_id = e.session_id AND parent.id = e.parent_id
		`)
		db.exec(`
			INSERT INTO session_entry_refs (session_id, global_id, seq)
			SELECT session_id, session_id || ':' || id, seq
			FROM legacy_session_entries
		`)
		db.exec(`
			INSERT INTO entry_messages
			SELECT m.session_id || ':' || m.entry_id, m.role, m.content_format, m.timestamp, m.provider, m.model, m.auth_json, m.response_model, m.response_id, m.model_request_id, m.stop_reason, m.error_message, m.tool_call_id, m.tool_name, m.is_error, m.details_json, m.extra_json
			FROM legacy_messages m
			JOIN legacy_session_entries e ON e.session_id = m.session_id AND e.id = m.entry_id
		`)
		db.exec(`
			INSERT INTO entry_message_blocks
			SELECT mb.session_id || ':' || mb.entry_id, mb.ordinal, mb.type, mb.text, mb.text_signature, mb.thinking, mb.thinking_signature, mb.redacted, mb.image_data, mb.image_mime_type, mb.image_detail, mb.image_width_px, mb.image_height_px, mb.tool_call_id, mb.tool_name, mb.tool_args_json, mb.payload_json
			FROM legacy_message_blocks mb
			JOIN legacy_session_entries e ON e.session_id = mb.session_id AND e.id = mb.entry_id
		`)
		db.exec(`
			INSERT INTO entry_usage
			SELECT u.session_id || ':' || u.entry_id, u.input_tokens, u.output_tokens, u.reasoning_output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.total_tokens, u.provider_total_tokens, u.cost_input, u.cost_output, u.cost_cache_read, u.cost_cache_write, u.cost_total, u.cost_currency, u.pricing_version, u.raw_json
			FROM legacy_usage u
			JOIN legacy_session_entries e ON e.session_id = u.session_id AND e.id = u.entry_id
		`)
		db.exec(`
			INSERT INTO entry_labels
			SELECT l.session_id || ':' || l.entry_id, l.session_id || ':' || l.target_entry_id, l.label
			FROM legacy_labels l
			JOIN legacy_session_entries e ON e.session_id = l.session_id AND e.id = l.entry_id
			JOIN legacy_session_entries target ON target.session_id = l.session_id AND target.id = l.target_entry_id
		`)
		db.exec(`
			INSERT INTO entry_session_info
			SELECT si.session_id || ':' || si.entry_id, si.name
			FROM legacy_session_info_entries si
			JOIN legacy_session_entries e ON e.session_id = si.session_id AND e.id = si.entry_id
		`)
		db.exec(`
			INSERT INTO entry_custom_entries
			SELECT c.session_id || ':' || c.entry_id, c.custom_type, c.data_json
			FROM legacy_custom_entries c
			JOIN legacy_session_entries e ON e.session_id = c.session_id AND e.id = c.entry_id
		`)
		db.exec(`
			INSERT INTO entry_context_loads
			SELECT cl.session_id || ':' || cl.entry_id, cl.source, cl.cwd, cl.loaded_at, cl.disabled
			FROM legacy_context_loads cl
			JOIN legacy_session_entries e ON e.session_id = cl.session_id AND e.id = cl.entry_id
		`)
		db.exec(`
			INSERT INTO entry_context_files
			SELECT cf.session_id || ':' || cf.entry_id, cf.ordinal, cf.path, cf.scope_dir, cf.content, cf.hash
			FROM legacy_context_files cf
			JOIN legacy_session_entries e ON e.session_id = cf.session_id AND e.id = cf.entry_id
		`)

		for (const table of [
			"legacy_message_blocks",
			"legacy_usage",
			"legacy_messages",
			"legacy_labels",
			"legacy_session_info_entries",
			"legacy_custom_entries",
			"legacy_context_files",
			"legacy_context_loads",
			"legacy_session_entries",
		]) db.exec(`DROP TABLE ${table}`)
	},
	// v14 → v15: store the active branch leaf as a first-class global DAG node
	// pointer. Keep the old display-id column populated for compatibility and
	// UI/cache rows, but runtime traversal should prefer the global id.
	(db) => {
		const sessionColumns = tableColumns(db, "sessions")
		if (!sessionColumns.has("active_leaf_global_id")) {
			db.exec("ALTER TABLE sessions ADD COLUMN active_leaf_global_id TEXT")
		}
		db.exec(`
			UPDATE sessions
			SET active_leaf_global_id = (
				SELECT ser.global_id
				FROM session_entry_refs ser
				JOIN conversation_entries ce ON ce.global_id = ser.global_id
				WHERE ser.session_id = sessions.id
					AND ce.id = sessions.active_leaf_entry_id
				LIMIT 1
			)
			WHERE active_leaf_global_id IS NULL
				AND active_leaf_entry_id IS NOT NULL
		`)
	},
	// v15 → v16: remove compatibility views for the pre-DAG table names. Runtime
	// code now reads the global DAG tables directly.
	(db) => {
		for (const view of [
			"session_entries",
			"messages",
			"message_blocks",
			"usage",
			"labels",
			"session_info_entries",
			"custom_entries",
			"context_loads",
			"context_files",
		]) db.exec(`DROP VIEW IF EXISTS ${view}`)
	},
	// v16 → v17: durable per-session prompt composer drafts. Drafts are mutable
	// UI state, intentionally kept outside the immutable conversation DAG and
	// outside sessions.updated_at so live typing does not reorder session lists.
	(db) => {
		db.exec(`
			CREATE TABLE IF NOT EXISTS session_prompt_drafts (
				session_id TEXT PRIMARY KEY REFERENCES sessions(id),
				text TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL,
				updated_by_client_id TEXT,
				updated_by_client_seq INTEGER
			)
		`)
		db.exec(`
			CREATE TABLE IF NOT EXISTS session_prompt_draft_clients (
				session_id TEXT NOT NULL REFERENCES sessions(id),
				client_id TEXT NOT NULL,
				last_seq INTEGER NOT NULL,
				PRIMARY KEY (session_id, client_id)
			)
		`)
	},
	// v17 → v18: raw input for custom/freeform tool calls. JSON/function tool
	// calls keep using tool_args_json; custom calls store their grammar input here.
	(db) => {
		if (tableExists(db, "entry_message_blocks") && !tableColumns(db, "entry_message_blocks").has("tool_input")) {
			db.exec("ALTER TABLE entry_message_blocks ADD COLUMN tool_input TEXT")
		}
	},
	// v18 → v19: retire session_info conversation entries. sessions.name stays as
	// an unused reserved column, but names are no longer part of runtime behavior.
	(db) => {
		removeSessionInfoEntries(db)
	},
	// v19 → v20: remove the retired Unix-socket service endpoint field.
	(db) => {
		if (tableExists(db, "service_runs") && tableColumns(db, "service_runs").has("socket_path")) {
			db.exec("ALTER TABLE service_runs DROP COLUMN socket_path")
		}
	},
	// v20 → v21: identify legacy generated AGENTS.md/CLAUDE.md context messages structurally.
	(db) => {
		db.exec(`
			UPDATE entry_messages AS em
			SET extra_json = json_set(
				CASE
					WHEN em.extra_json IS NOT NULL AND json_valid(em.extra_json) AND json_type(em.extra_json) = 'object' THEN em.extra_json
					ELSE '{}'
				END,
				'$.projectContext',
				json('true')
			)
			WHERE em.role = 'user'
				AND (
					CASE
						WHEN em.extra_json IS NOT NULL AND json_valid(em.extra_json) AND json_type(em.extra_json) = 'object'
							THEN COALESCE(json_extract(em.extra_json, '$.projectContext'), 0)
						ELSE 0
					END
				) != 1
				AND EXISTS (
					SELECT 1
					FROM entry_message_blocks mb
					WHERE mb.global_id = em.global_id
						AND mb.type = 'text'
						AND mb.ordinal = 0
						AND mb.text LIKE '# AGENTS.md / CLAUDE.md context for %'
						AND mb.text LIKE '%<INSTRUCTIONS>%'
						AND mb.text LIKE '%</INSTRUCTIONS>%'
						AND (
							mb.text LIKE '%' || char(10) || '## /%AGENTS.md%'
							OR mb.text LIKE '%' || char(10) || '## /%AGENTS.MD%'
							OR mb.text LIKE '%' || char(10) || '## /%CLAUDE.md%'
							OR mb.text LIKE '%' || char(10) || '## /%CLAUDE.MD%'
						)
				)
		`)
		if (tableExists(db, "session_overviews")) db.exec("DELETE FROM session_overviews")
	},
	// v21 → v22: DB-owned session mutation ownership. Services/runtimes may cache
	// sessions, but a durable append must prove it is based on the loaded session
	// version, and active agent turns must own the session through their run id.
	(db) => {
		const columns = tableColumns(db, "sessions")
		if (!columns.has("mutation_version")) db.exec("ALTER TABLE sessions ADD COLUMN mutation_version INTEGER NOT NULL DEFAULT 0")
		if (!columns.has("mutation_run_id")) db.exec("ALTER TABLE sessions ADD COLUMN mutation_run_id TEXT")
	},
	// v22 → v23: persist context-file identity captured at load time. Older
	// rows fall back to realpath(path) while they still exist.
	(db) => {
		if (tableExists(db, "entry_context_files") && !tableColumns(db, "entry_context_files").has("identity_path")) {
			db.exec("ALTER TABLE entry_context_files ADD COLUMN identity_path TEXT")
		}
		if (tableExists(db, "context_files") && !tableColumns(db, "context_files").has("identity_path")) {
			db.exec("ALTER TABLE context_files ADD COLUMN identity_path TEXT")
		}
	},
	// v23 → v24: retired before release; kept as an empty migration slot so existing v24 databases remain compatible.
	() => {},
	// v24 → v25: rename durable session config cwd/worktree fields to the
	// canonical initialWd/sandboxMounts shape. Runtime code reads only the new
	// names; this migration is the compatibility boundary for old databases.
	(db) => {
		migrateSessionConfigEntries(db)
	},
	// v25 → v26: durable UI state shared by TUI and web clients. This stays
	// outside settings and session rows because it is mutable presentation state,
	// not configuration or conversation/session data.
	(db) => {
		db.exec(`
			CREATE TABLE IF NOT EXISTS ui_state (
				state_key TEXT PRIMARY KEY,
				value_json TEXT NOT NULL CHECK (json_valid(value_json)),
				updated_at TEXT NOT NULL
			)
		`)
	},
	// v26 → v27: materialize the fixed session starting working directory on
	// the session row. Config entries remain part of durable history/runtime
	// replay, but session lists must not replay conversation branches for this.
	(db) => {
		if (!tableColumns(db, "sessions").has("initial_wd")) db.exec("ALTER TABLE sessions ADD COLUMN initial_wd TEXT")
		backfillSessionInitialWds(db)
	},
]

function tableExists(db, name) {
	return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

function tableColumns(db, table) {
	return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name))
}

function canonicalSessionConfig(data) {
	const config = { ...data }
	const initialWd = typeof data.initialWd === "string" && data.initialWd
		? data.initialWd
		: typeof data.cwd === "string" && data.cwd
			? data.cwd
			: undefined
	if (initialWd) config.initialWd = initialWd
	else if ("initialWd" in config) delete config.initialWd

	if (!Array.isArray(data.sandboxMounts)) {
		const mount = typeof data.worktree === "string" && data.worktree
			? data.worktree
			: typeof data.cwd === "string" && data.cwd
				? data.cwd
				: undefined
		if (mount) config.sandboxMounts = [mount]
		else if ("sandboxMounts" in config) delete config.sandboxMounts
	}

	delete config.cwd
	delete config.worktree
	delete config.version
	return config
}

function migrateSessionConfigEntries(db) {
	if (!tableExists(db, "entry_custom_entries")) return
	const rows = db.prepare(`
		SELECT global_id AS globalId, data_json AS dataJson
		FROM entry_custom_entries
		WHERE custom_type = 'config'
	`).all()
	const update = db.prepare("UPDATE entry_custom_entries SET data_json = ? WHERE global_id = ?")
	for (const row of rows) {
		const data = parseJson(row.dataJson)
		if (!data || typeof data !== "object" || Array.isArray(data)) continue
		const json = JSON.stringify(canonicalSessionConfig(data))
		if (json !== row.dataJson) update.run(json, row.globalId)
	}
}

function backfillSessionInitialWds(db) {
	if (!tableExists(db, "sessions") || !tableColumns(db, "sessions").has("initial_wd")) return
	if (tableExists(db, "entry_custom_entries") && tableExists(db, "session_entry_refs") && tableExists(db, "conversation_entries")) {
		db.exec(`
			WITH
				candidate(session_id, initial_wd, source_rank, seq) AS (
					SELECT
						ser.session_id,
						json_extract(ece.data_json, '$.initialWd'),
						CASE WHEN ce.created_by_session_id = ser.session_id THEN 0 ELSE 1 END,
						ser.seq
					FROM entry_custom_entries ece
					JOIN session_entry_refs ser ON ser.global_id = ece.global_id
					JOIN conversation_entries ce ON ce.global_id = ece.global_id
					WHERE ece.custom_type = 'config'
						AND json_valid(ece.data_json)
						AND json_type(ece.data_json, '$.initialWd') = 'text'
						AND json_extract(ece.data_json, '$.initialWd') != ''
				),
				picked AS (
					SELECT candidate.session_id, candidate.initial_wd
					FROM candidate
					WHERE NOT EXISTS (
						SELECT 1
						FROM candidate better
						WHERE better.session_id = candidate.session_id
							AND (
								better.source_rank < candidate.source_rank
								OR (
									better.source_rank = candidate.source_rank
									AND better.seq < candidate.seq
								)
							)
					)
				)
			UPDATE sessions
			SET initial_wd = (
				SELECT picked.initial_wd
				FROM picked
				WHERE picked.session_id = sessions.id
			)
			WHERE initial_wd IS NULL
				AND EXISTS (
					SELECT 1
					FROM picked
					WHERE picked.session_id = sessions.id
				)
		`)
	}
	db.exec("UPDATE sessions SET initial_wd = cwd WHERE initial_wd IS NULL AND cwd != ''")
}

function ensureServiceRunsTable(db) {
	if (!tableExists(db, "service_runs") && tableExists(db, "daemon_runs")) {
		db.exec("ALTER TABLE daemon_runs RENAME TO service_runs")
	}
	db.exec("DROP INDEX IF EXISTS idx_daemon_runs_status_started")
	db.exec(`
		CREATE TABLE IF NOT EXISTS service_runs (
			id TEXT PRIMARY KEY,
			pid INTEGER,
			cwd TEXT NOT NULL,
			transport TEXT,
			port INTEGER,
			code_fingerprint TEXT,
			status TEXT NOT NULL,
			started_at TEXT NOT NULL,
			ended_at TEXT,
			exit_code INTEGER,
			signal TEXT,
			reason TEXT
		)
	`)
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_service_runs_status_started
		ON service_runs(status, started_at DESC)
	`)
}

function removeSessionInfoEntries(db) {
	db.exec("DROP VIEW IF EXISTS session_info_entries")
	if (!tableExists(db, "conversation_entries")) {
		db.exec("DROP TABLE IF EXISTS entry_session_info")
		return
	}
	const infoRows = db.prepare(`
		SELECT global_id AS globalId, parent_global_id AS parentGlobalId
		FROM conversation_entries
		WHERE kind = 'session_info'
	`).all()
	const infoParents = new Map(infoRows.map((row) => [row.globalId, row.parentGlobalId ?? null]))
	const infoIds = new Set(infoParents.keys())
	const entryIds = new Map(db.prepare("SELECT global_id AS globalId, id FROM conversation_entries").all().map((row) => [row.globalId, row.id]))
	const nearestKeptParent = (globalId) => {
		let parent = infoParents.get(globalId) ?? null
		const seen = new Set([globalId])
		while (parent && infoIds.has(parent) && !seen.has(parent)) {
			seen.add(parent)
			parent = infoParents.get(parent) ?? null
		}
		return parent && !infoIds.has(parent) ? parent : null
	}

	if (infoRows.length > 0) {
		const updateParent = db.prepare("UPDATE conversation_entries SET parent_global_id = ? WHERE global_id = ?")
		for (const row of db.prepare("SELECT global_id AS globalId, parent_global_id AS parentGlobalId FROM conversation_entries WHERE parent_global_id IS NOT NULL").all()) {
			if (infoIds.has(row.parentGlobalId)) updateParent.run(nearestKeptParent(row.parentGlobalId), row.globalId)
		}

		const updateActiveLeaf = db.prepare("UPDATE sessions SET active_leaf_global_id = ?, active_leaf_entry_id = ? WHERE id = ?")
		for (const row of db.prepare(`
			SELECT
				s.id,
				COALESCE(
					s.active_leaf_global_id,
					(
						SELECT ser.global_id
						FROM session_entry_refs ser
						JOIN conversation_entries ce ON ce.global_id = ser.global_id
						WHERE ser.session_id = s.id AND ce.id = s.active_leaf_entry_id
						LIMIT 1
					)
				) AS activeLeafGlobalId
			FROM sessions s
		`).all()) {
			if (!infoIds.has(row.activeLeafGlobalId)) continue
			const parent = nearestKeptParent(row.activeLeafGlobalId)
			updateActiveLeaf.run(parent, parent ? entryIds.get(parent) ?? null : null, row.id)
		}

		if (tableColumns(db, "sessions").has("branched_from_entry_global_id")) {
			const updateBranchOrigin = db.prepare("UPDATE sessions SET branched_from_entry_global_id = ?, branched_from_entry_id = ? WHERE id = ?")
			for (const row of db.prepare("SELECT id, branched_from_entry_global_id AS branchGlobalId FROM sessions WHERE branched_from_entry_global_id IS NOT NULL").all()) {
				if (!infoIds.has(row.branchGlobalId)) continue
				const parent = nearestKeptParent(row.branchGlobalId)
				updateBranchOrigin.run(parent, parent ? entryIds.get(parent) ?? null : null, row.id)
			}
		}

		if (tableExists(db, "entry_session_info")) {
			const deleteInfo = db.prepare("DELETE FROM entry_session_info WHERE global_id = ?")
			for (const row of infoRows) deleteInfo.run(row.globalId)
		}
		const deleteRef = db.prepare("DELETE FROM session_entry_refs WHERE global_id = ?")
		const deleteEntry = db.prepare("DELETE FROM conversation_entries WHERE global_id = ?")
		for (const row of infoRows) {
			deleteRef.run(row.globalId)
			deleteEntry.run(row.globalId)
		}
		if (tableExists(db, "session_overviews")) db.exec("DELETE FROM session_overviews")
	}
	db.exec("DROP TABLE IF EXISTS entry_session_info")
}

let lastTimestampMs = 0

function nowIso() {
	const now = Date.now()
	lastTimestampMs = Math.max(now, lastTimestampMs + 1)
	return new Date(lastTimestampMs).toISOString()
}

function migrateDb(db) {
	db.exec("BEGIN EXCLUSIVE")
	try {
		let { user_version: version } = db.prepare("PRAGMA user_version").get()
		version = Number(version ?? 0)
		if (version > SCHEMA_VERSION) {
			throw new Error(
				`Database schema version ${version} is newer than supported version ${SCHEMA_VERSION}. ` +
				"Please upgrade pinano.",
			)
		}
		while (version < SCHEMA_VERSION) {
			migrations[version](db)
			version++
			db.exec(`PRAGMA user_version = ${version}`)
		}
		db.exec("COMMIT")
	} catch (err) {
		db.exec("ROLLBACK")
		throw err
	}
}

/**
 * @typedef {object} ServerDbSession
 * @property {string} id
 * @property {string} cwd
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | undefined} [latestRunStartedAt]
 * @property {string | undefined} [latestRunEndedAt]
 * @property {string | undefined} [latestRunError]
 * @property {string | undefined} [latestRunStopReason]
 * @property {"running" | "idle" | "failed" | "aborted" | "interrupted" | undefined} [runStatus]
 * @property {"running" | "idle" | "failed" | "aborted" | "interrupted" | "paused" | undefined} [runtimeState]
 * @property {"not_started" | "running" | "stopped" | string | undefined} [lifecycleState]
 * @property {{ state?: "working" | "needs_input" | "ready_for_review" | "deferred" | "completed" | "experiencing_problems" | string, descriptionInUi?: string, description?: string, projectTag?: string, needsInput?: string, result?: string, updatedAt?: string } | undefined} [agentView]
 * @property {string | undefined} [initialWd]
 */

/**
 * @typedef {object} ServerDb
 * @property {import("node:sqlite").DatabaseSync} raw
 * @property {(session: { id: string, cwd: string, initialWd?: string, createdAt?: string, updatedAt?: string }) => void} upsertSession
 * @property {(id: string, cwd?: string, updatedAt?: string) => void} touchSession
 * @property {(id: string) => void} markSessionDeleted
 * @property {(id: string, state: string) => void} setSessionRuntimeState
 * @property {(id: string, metadata: { state?: string, descriptionInUi?: string, description?: string, projectTag?: string, needsInput?: string, result?: string, updatedAt?: string }) => void} setAgentViewMetadata
 * @property {(id: string) => { state?: string, descriptionInUi?: string, description?: string, projectTag?: string, needsInput?: string, result?: string, updatedAt?: string } | undefined} getAgentViewMetadata
 * @property {(id: string) => { mutationVersion: number, mutationRunId?: string, runtimeState?: string, agentViewState?: string } | undefined} getSessionMutation
 * @property {(id: string) => PromptDraft} getPromptDraft
 * @property {(id: string, text: string, options?: { clientId?: string, clientSeq?: number }) => PromptDraft} setPromptDraft
 * @property {(key: string) => any | undefined} getUiState
 * @property {(key: string, value: any) => any} setUiState
 * @property {(key: string) => boolean} deleteUiState
 * @property {(cwd?: string) => ServerDbSession[]} listSessions
 * @property {(id: string) => Array<{ previewKind: "first" | "lastUser", entryId: string, timestamp: string, role: string, content: string | any[] }>} loadSessionPreviewMessages
 * @property {(ids: string[]) => Array<{ sessionId: string, previewKind: "first" | "lastUser", entryId: string, timestamp: string, role: string, content: string | any[] }>} loadSessionPreviewMessagesForSessions
 * @property {(ids: string[]) => Array<{ sessionId: string, previewKind: "first" | "lastUser", entryId: string, timestamp: string, role: string, content: string }>} loadSessionOverviewPreviewMessagesForSessions
 * @property {(cwd: string) => string | undefined} latestSessionForCwd
 * @property {(prefix: string) => string[]} findSessionIdsByPrefix
 * @property {(sessions: Array<{ id: string, cwd: string, initialWd?: string, createdAt?: string, updatedAt?: string }>) => void} replaceSessions
 * @property {() => number} sessionCount
 * @property {(run: { id: string, sessionId: string, startedAt?: string, expectedMutationVersion: number }) => void} startRun
 * @property {(id: string, update: { status: string, error?: string, stopReason?: string, endedAt?: string }) => void} finishRun
 * @property {(sessionId: string, update: { status: string, error?: string, stopReason?: string, endedAt?: string }) => boolean} finishLatestInterruptedRunForSession
 * @property {() => number} interruptRunningRuns
 * @property {(run: { id: string, pid?: number, cwd: string, transport?: string, port?: number, codeFingerprint?: string, startedAt?: string }) => void} startServiceRun
 * @property {(id: string, update: { status: string, endedAt?: string, exitCode?: number | null, signal?: string | null, reason?: string }) => void} finishServiceRun
 * @property {(reason?: string, exceptId?: string) => number} recoverServiceRuns
 * @property {(limit?: number) => any[]} listServiceRuns
 * @property {() => void} close
 */

/** @typedef {{ text: string, version: number, updatedAt?: string, updatedByClientId?: string, updatedByClientSeq?: number, applied?: boolean }} PromptDraft */

/** @param {string | undefined} tag */
function normalizeProjectTag(tag) {
	const words = String(tag || "").replace(/\s+/g, " ").trim().toLowerCase().split(" ").filter(Boolean).slice(0, 3)
	return words.join(" ").slice(0, 40) || null
}

/** @param {string} status */
function normalizeRunStatus(status) {
	if (status === "running") return "running"
	if (status === "failed") return "failed"
	if (status === "aborted") return "aborted"
	if (status === "interrupted") return "interrupted"
	return "idle"
}

function mutationError(message, code) {
	const err = new Error(message)
	err.code = code
	return err
}

function promptDraftFromRow(row, overrides = {}) {
	return {
		text: row?.text ?? "",
		version: Number(row?.version ?? 0),
		updatedAt: row?.updatedAt ?? undefined,
		updatedByClientId: row?.updatedByClientId ?? undefined,
		updatedByClientSeq: row?.updatedByClientSeq ?? undefined,
		...overrides,
	}
}

function parseJson(text, fallback = undefined) {
	if (text === null || text === undefined) return fallback
	try {
		return JSON.parse(String(text))
	} catch {
		return fallback
	}
}

function previewMessageFromRow(row) {
	let blocks = []
	try {
		blocks = JSON.parse(row.blocksJson || "[]")
	} catch {}
	const content = row.contentFormat === "string"
		? (blocks.find((block) => block?.type === "text")?.text ?? "")
		: blocks.map((block) => {
			if (block?.type === "text") return { type: "text", text: block.text ?? "" }
			if (block?.payloadJson) {
				try { return JSON.parse(block.payloadJson) } catch {}
			}
			return { type: block?.type ?? "unknown" }
		})
	return {
		sessionId: row.sessionId,
		previewKind: row.previewKind,
		entryId: row.entryId,
		timestamp: row.timestamp,
		role: row.role,
		content,
	}
}

function flattenPreviewContent(content) {
	if (typeof content === "string") return content.trim()
	if (!Array.isArray(content)) return ""
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text ?? "")
		.join(" ")
		.trim()
}

function cachedPreviewRowsFromOverview(row) {
	/** @type {Array<{ sessionId: string, previewKind: "first" | "lastUser", entryId: string, timestamp: string, role: string, content: string }>} */
	const rows = []
	if (row.firstEntryId) {
		rows.push({
			sessionId: row.sessionId,
			previewKind: "first",
			entryId: row.firstEntryId,
			timestamp: row.firstTimestamp,
			role: row.firstRole ?? "?",
			content: row.firstText ?? "",
		})
	}
	if (row.lastUserEntryId) {
		rows.push({
			sessionId: row.sessionId,
			previewKind: "lastUser",
			entryId: row.lastUserEntryId,
			timestamp: row.lastUserTimestamp,
			role: "user",
			content: row.lastUserText ?? "",
		})
	}
	return rows
}

// For active ancestors, session_entry_refs.seq is root-to-leaf order because parents are referenced before children. Use it to choose the two preview target entries before loading message blocks.
function previewMessagesForSelectedSql(selectedValuesSql) {
	return `
		WITH RECURSIVE
			selected(ord, session_id) AS (
				VALUES ${selectedValuesSql}
			),
			leaf(ord, session_id, global_id) AS (
				SELECT selected.ord, selected.session_id, COALESCE(
					s.active_leaf_global_id,
					(
						SELECT ser.global_id
						FROM session_entry_refs ser
						JOIN conversation_entries ce ON ce.global_id = ser.global_id
						WHERE ser.session_id = selected.session_id AND ce.id = s.active_leaf_entry_id
						LIMIT 1
					),
					(
						SELECT ser.global_id
						FROM session_entry_refs ser
						WHERE ser.session_id = selected.session_id
						ORDER BY ser.seq DESC
						LIMIT 1
					)
				)
				FROM selected
				JOIN sessions s ON s.id = selected.session_id AND s.deleted_at IS NULL
			),
			ancestors(ord, session_id, global_id, parent_global_id) AS (
				SELECT leaf.ord, leaf.session_id, ce.global_id, ce.parent_global_id
				FROM leaf
				JOIN conversation_entries ce ON ce.global_id = leaf.global_id
				UNION ALL
				SELECT ancestors.ord, ancestors.session_id, parent.global_id, parent.parent_global_id
				FROM ancestors
				JOIN conversation_entries parent ON parent.global_id = ancestors.parent_global_id
			),
			visible_entries AS (
				SELECT
					ancestors.ord AS ord,
					ancestors.session_id AS sessionId,
					ancestors.global_id AS globalId,
					ser.seq AS seq,
					em.role AS role
				FROM ancestors
				JOIN session_entry_refs ser ON ser.session_id = ancestors.session_id AND ser.global_id = ancestors.global_id
				JOIN entry_messages em ON em.global_id = ancestors.global_id
				WHERE NOT (${HIDDEN_MESSAGE_EXTRA_SQL})
					AND NOT (${PROJECT_CONTEXT_EXTRA_SQL})
			),
			preview_seqs AS (
				SELECT
					ord,
					sessionId,
					min(seq) AS firstSeq,
					max(CASE WHEN role = 'user' THEN seq END) AS lastUserSeq
				FROM visible_entries
				GROUP BY ord, sessionId
			),
			preview_targets AS (
				SELECT
					0 AS previewOrder,
					'first' AS previewKind,
					visible_entries.ord AS ord,
					visible_entries.sessionId AS sessionId,
					visible_entries.globalId AS globalId
				FROM preview_seqs
				JOIN visible_entries ON visible_entries.ord = preview_seqs.ord
					AND visible_entries.sessionId = preview_seqs.sessionId
					AND visible_entries.seq = preview_seqs.firstSeq
				WHERE preview_seqs.firstSeq IS NOT NULL
				UNION ALL
				SELECT
					1 AS previewOrder,
					'lastUser' AS previewKind,
					visible_entries.ord AS ord,
					visible_entries.sessionId AS sessionId,
					visible_entries.globalId AS globalId
				FROM preview_seqs
				JOIN visible_entries ON visible_entries.ord = preview_seqs.ord
					AND visible_entries.sessionId = preview_seqs.sessionId
					AND visible_entries.seq = preview_seqs.lastUserSeq
				WHERE preview_seqs.lastUserSeq IS NOT NULL
			)
		SELECT
			preview_targets.previewKind,
			preview_targets.sessionId,
			ce.id AS entryId,
			ce.timestamp AS timestamp,
			em.role AS role,
			em.content_format AS contentFormat,
			(
				SELECT json_group_array(json_object(
					'type', mb.type,
					'text', mb.text,
					'payloadJson', mb.payload_json
				))
				FROM (
					SELECT type, text, payload_json
					FROM entry_message_blocks
					WHERE global_id = preview_targets.globalId
					ORDER BY ordinal ASC
				) mb
			) AS blocksJson
		FROM preview_targets
		JOIN conversation_entries ce ON ce.global_id = preview_targets.globalId
		JOIN entry_messages em ON em.global_id = preview_targets.globalId
		ORDER BY preview_targets.ord ASC, preview_targets.previewOrder ASC
	`
}

/**
 * Open and migrate the Pinano server metadata db.
 * @param {{ path?: string, recoverRunningRuns?: boolean }} [options]
 * @returns {ServerDb}
 */
export function openServerDb(options = {}) {
	const path = options.path ?? serverDbPath()
	mkdirSync(dirname(path), { recursive: true })
	const db = new DatabaseSync(path)
	db.exec("PRAGMA journal_mode = WAL")
	db.exec("PRAGMA busy_timeout = 1000")
	db.exec("PRAGMA foreign_keys = ON")
	migrateDb(db)

	// sessions.name is intentionally retained as an unused reserved column. Runtime code should not read or write it.
	const upsertSessionStmt = db.prepare(`
		INSERT INTO sessions (id, cwd, initial_wd, created_at, updated_at, deleted_at)
		VALUES (?, ?, ?, ?, ?, NULL)
		ON CONFLICT(id) DO UPDATE SET
			cwd = excluded.cwd,
			initial_wd = COALESCE(sessions.initial_wd, excluded.initial_wd),
			updated_at = excluded.updated_at,
			deleted_at = NULL
	`)
	const touchSessionStmt = db.prepare(`
		UPDATE sessions
		SET updated_at = COALESCE(?, updated_at), cwd = COALESCE(?, cwd), deleted_at = NULL
		WHERE id = ?
	`)
	const markDeletedStmt = db.prepare("UPDATE sessions SET deleted_at = ? WHERE id = ?")
	const setRuntimeStateStmt = db.prepare("UPDATE sessions SET runtime_state = ?, runtime_state_updated_at = ? WHERE id = ? AND deleted_at IS NULL")
	const setAgentViewStmt = db.prepare(`
		UPDATE sessions
		SET agent_view_state = ?,
			agent_view_description = ?,
			agent_view_project_tag = ?,
			agent_view_needs_input = ?,
			agent_view_result = ?,
			agent_view_updated_at = ?
		WHERE id = ? AND deleted_at IS NULL
	`)
	const getAgentViewStmt = db.prepare(`
		SELECT
			agent_view_state AS state,
			agent_view_description AS description,
			agent_view_project_tag AS projectTag,
			agent_view_needs_input AS needsInput,
			agent_view_result AS result,
			agent_view_updated_at AS updatedAt
		FROM sessions
		WHERE id = ? AND deleted_at IS NULL
	`)
	const getPromptDraftStmt = db.prepare(`
		SELECT
			text,
			version,
			updated_at AS updatedAt,
			updated_by_client_id AS updatedByClientId,
			updated_by_client_seq AS updatedByClientSeq
		FROM session_prompt_drafts
		WHERE session_id = ?
	`)
	const currentPromptDraftVersionStmt = db.prepare("SELECT version FROM session_prompt_drafts WHERE session_id = ?")
	const getPromptDraftClientSeqStmt = db.prepare("SELECT last_seq AS lastSeq FROM session_prompt_draft_clients WHERE session_id = ? AND client_id = ?")
	const upsertPromptDraftClientSeqStmt = db.prepare(`
		INSERT INTO session_prompt_draft_clients (session_id, client_id, last_seq)
		VALUES (?, ?, ?)
		ON CONFLICT(session_id, client_id) DO UPDATE SET
			last_seq = MAX(session_prompt_draft_clients.last_seq, excluded.last_seq)
	`)
	const setPromptDraftStmt = db.prepare(`
		INSERT INTO session_prompt_drafts (session_id, text, version, updated_at, updated_by_client_id, updated_by_client_seq)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			text = excluded.text,
			version = excluded.version,
			updated_at = excluded.updated_at,
			updated_by_client_id = excluded.updated_by_client_id,
			updated_by_client_seq = excluded.updated_by_client_seq
	`)
	const getUiStateStmt = db.prepare("SELECT value_json AS valueJson FROM ui_state WHERE state_key = ?")
	const setUiStateStmt = db.prepare(`
		INSERT INTO ui_state (state_key, value_json, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(state_key) DO UPDATE SET
			value_json = excluded.value_json,
			updated_at = excluded.updated_at
	`)
	const deleteUiStateStmt = db.prepare("DELETE FROM ui_state WHERE state_key = ?")
	const listSessionsSelectSql = `
		SELECT
			s.id,
			s.cwd,
			s.initial_wd AS initialWd,
			s.created_at AS createdAt,
			s.updated_at AS updatedAt,
			s.runtime_state AS runtimeState,
			s.agent_view_state AS agentViewState,
			s.agent_view_description AS agentViewDescription,
			s.agent_view_project_tag AS agentViewProjectTag,
			s.agent_view_needs_input AS agentViewNeedsInput,
			s.agent_view_result AS agentViewResult,
			s.agent_view_updated_at AS agentViewUpdatedAt,
			(
				SELECT r.status
				FROM runs r
				WHERE r.session_id = s.id
				ORDER BY r.started_at DESC
				LIMIT 1
			) AS latestRunStatus,
			(
				SELECT r.started_at
				FROM runs r
				WHERE r.session_id = s.id
				ORDER BY r.started_at DESC
				LIMIT 1
			) AS latestRunStartedAt,
			(
				SELECT r.ended_at
				FROM runs r
				WHERE r.session_id = s.id
				ORDER BY r.started_at DESC
				LIMIT 1
			) AS latestRunEndedAt,
			(
				SELECT r.error
				FROM runs r
				WHERE r.session_id = s.id
				ORDER BY r.started_at DESC
				LIMIT 1
			) AS latestRunError,
			(
				SELECT r.stop_reason
				FROM runs r
				WHERE r.session_id = s.id
				ORDER BY r.started_at DESC
				LIMIT 1
			) AS latestRunStopReason
		FROM sessions s
	`
	const listSessionsStmt = db.prepare(`
		${listSessionsSelectSql}
		WHERE s.deleted_at IS NULL
		ORDER BY s.updated_at DESC
	`)
	const listSessionsForCwdStmt = db.prepare(`
		${listSessionsSelectSql}
		WHERE s.deleted_at IS NULL AND s.cwd = ?
		ORDER BY s.updated_at DESC
	`)
	const previewMessagesStmt = db.prepare(previewMessagesForSelectedSql("(0, ?)"))
	const loadSessionPreviewMessagesForSessionBatch = (ids) => {
		if (ids.length === 0) return []
		const values = ids.map((_, i) => `(${i}, ?)`).join(", ")
		const stmt = db.prepare(previewMessagesForSelectedSql(values))
		return stmt.all(...ids).map(previewMessageFromRow)
	}
	const loadSessionPreviewMessagesForSessions = (ids) => ids
		.flatMap((_, i) => i % SESSION_PREVIEW_BATCH_SIZE === 0
			? loadSessionPreviewMessagesForSessionBatch(ids.slice(i, i + SESSION_PREVIEW_BATCH_SIZE))
			: [])
	const overviewLeavesForSessionBatch = (ids) => {
		if (ids.length === 0) return []
		const values = ids.map(() => "(?)").join(", ")
		const stmt = db.prepare(`
			WITH selected(session_id) AS (
				VALUES ${values}
			)
			SELECT
				selected.session_id AS sessionId,
				COALESCE(
					(
						SELECT ce.id
						FROM conversation_entries ce
						WHERE ce.global_id = s.active_leaf_global_id
					),
					s.active_leaf_entry_id,
					(
						SELECT ce.id
						FROM session_entry_refs ser
						JOIN conversation_entries ce ON ce.global_id = ser.global_id
						WHERE ser.session_id = selected.session_id
						ORDER BY ser.seq DESC
						LIMIT 1
					)
				) AS activeLeafEntryId
			FROM selected
			JOIN sessions s ON s.id = selected.session_id AND s.deleted_at IS NULL
		`)
		return stmt.all(...ids)
	}
	const overviewLeavesForSessions = (ids) => ids
		.flatMap((_, i) => i % SESSION_PREVIEW_BATCH_SIZE === 0
			? overviewLeavesForSessionBatch(ids.slice(i, i + SESSION_PREVIEW_BATCH_SIZE))
			: [])
	const cachedOverviewsForSessionBatch = (ids) => {
		if (ids.length === 0) return []
		const values = ids.map(() => "(?)").join(", ")
		const stmt = db.prepare(`
			WITH
				selected(session_id) AS (
					VALUES ${values}
				),
				current_leaf AS (
						SELECT
							selected.session_id,
							COALESCE(
								(
									SELECT ce.id
									FROM conversation_entries ce
									WHERE ce.global_id = s.active_leaf_global_id
								),
								s.active_leaf_entry_id,
								(
								SELECT ce.id
								FROM session_entry_refs ser
								JOIN conversation_entries ce ON ce.global_id = ser.global_id
								WHERE ser.session_id = selected.session_id
								ORDER BY ser.seq DESC
								LIMIT 1
							)
						) AS active_leaf_entry_id
					FROM selected
					JOIN sessions s ON s.id = selected.session_id AND s.deleted_at IS NULL
				)
			SELECT
				so.session_id AS sessionId,
				so.active_leaf_entry_id AS activeLeafEntryId,
				so.first_entry_id AS firstEntryId,
				so.first_timestamp AS firstTimestamp,
				so.first_role AS firstRole,
				so.first_text AS firstText,
				so.last_user_entry_id AS lastUserEntryId,
				so.last_user_timestamp AS lastUserTimestamp,
				so.last_user_text AS lastUserText
			FROM session_overviews so
			JOIN current_leaf cl ON cl.session_id = so.session_id
			WHERE so.active_leaf_entry_id IS cl.active_leaf_entry_id
		`)
		return stmt.all(...ids)
	}
	const cachedOverviewsForSessions = (ids) => ids
		.flatMap((_, i) => i % SESSION_PREVIEW_BATCH_SIZE === 0
			? cachedOverviewsForSessionBatch(ids.slice(i, i + SESSION_PREVIEW_BATCH_SIZE))
			: [])
	const upsertSessionOverviewStmt = db.prepare(`
		INSERT INTO session_overviews (
			session_id,
			active_leaf_entry_id,
			first_entry_id,
			first_timestamp,
			first_role,
			first_text,
			last_user_entry_id,
			last_user_timestamp,
			last_user_text,
			computed_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			active_leaf_entry_id = excluded.active_leaf_entry_id,
			first_entry_id = excluded.first_entry_id,
			first_timestamp = excluded.first_timestamp,
			first_role = excluded.first_role,
			first_text = excluded.first_text,
			last_user_entry_id = excluded.last_user_entry_id,
			last_user_timestamp = excluded.last_user_timestamp,
			last_user_text = excluded.last_user_text,
			computed_at = excluded.computed_at
	`)
	const upsertSessionOverview = (sessionId, activeLeafEntryId, messages) => {
		const first = messages.find((row) => row.previewKind === "first")
		const lastUser = messages.find((row) => row.previewKind === "lastUser")
		upsertSessionOverviewStmt.run(
			sessionId,
			activeLeafEntryId ?? null,
			first?.entryId ?? null,
			first?.timestamp ?? null,
			first?.role ?? null,
			first ? flattenPreviewContent(first.content) : null,
			lastUser?.entryId ?? null,
			lastUser?.timestamp ?? null,
			lastUser ? flattenPreviewContent(lastUser.content) : null,
			nowIso(),
		)
		return {
			sessionId,
			activeLeafEntryId: activeLeafEntryId ?? null,
			firstEntryId: first?.entryId ?? null,
			firstTimestamp: first?.timestamp ?? null,
			firstRole: first?.role ?? null,
			firstText: first ? flattenPreviewContent(first.content) : null,
			lastUserEntryId: lastUser?.entryId ?? null,
			lastUserTimestamp: lastUser?.timestamp ?? null,
			lastUserText: lastUser ? flattenPreviewContent(lastUser.content) : null,
		}
	}
	const ensureSessionOverviewsForSessions = (ids) => {
		if (ids.length === 0) return new Map()
		const cachedBySessionId = new Map(cachedOverviewsForSessions(ids).map((row) => [row.sessionId, row]))
		const leaves = overviewLeavesForSessions(ids)
		const staleLeaves = leaves.filter((row) => !cachedBySessionId.has(row.sessionId))
		if (staleLeaves.length > 0) {
			const staleIds = staleLeaves.map((row) => row.sessionId)
			const messagesBySessionId = new Map()
			for (const row of loadSessionPreviewMessagesForSessions(staleIds)) {
				const messages = messagesBySessionId.get(row.sessionId) ?? []
				messages.push(row)
				messagesBySessionId.set(row.sessionId, messages)
			}
			for (const leaf of staleLeaves) {
				cachedBySessionId.set(
					leaf.sessionId,
					upsertSessionOverview(
						leaf.sessionId,
						leaf.activeLeafEntryId ?? null,
						messagesBySessionId.get(leaf.sessionId) ?? [],
					),
				)
			}
		}
		return cachedBySessionId
	}
	const latestForCwdStmt = db.prepare(`
		SELECT id FROM sessions
		WHERE deleted_at IS NULL AND cwd = ?
		ORDER BY updated_at DESC
		LIMIT 1
	`)
	const findByPrefixStmt = db.prepare(`
		SELECT id FROM sessions
		WHERE deleted_at IS NULL AND id LIKE ?
		ORDER BY updated_at DESC
	`)
	const sessionCountStmt = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL")
	const getSessionMutationStmt = db.prepare(`
		SELECT
			mutation_version AS mutationVersion,
			mutation_run_id AS mutationRunId,
			runtime_state AS runtimeState,
			agent_view_state AS agentViewState
		FROM sessions
		WHERE id = ? AND deleted_at IS NULL
	`)
	const startRunStmt = db.prepare(`
		INSERT INTO runs (id, session_id, status, started_at)
		VALUES (?, ?, 'running', ?)
	`)
	const startRunSessionStateStmt = db.prepare(`
		UPDATE sessions
		SET runtime_state = 'running',
			runtime_state_updated_at = ?,
			mutation_run_id = ?
		WHERE id = ? AND deleted_at IS NULL
			AND mutation_run_id IS NULL
			AND mutation_version = ?
	`)
	const finishRunStmt = db.prepare(`
		UPDATE runs
		SET status = ?, ended_at = ?, error = ?, stop_reason = ?
		WHERE id = ?
	`)
	const finishRunSessionStateStmt = db.prepare(`
		UPDATE sessions
		SET runtime_state = ?,
			runtime_state_updated_at = ?,
			mutation_run_id = CASE WHEN mutation_run_id = ? THEN NULL ELSE mutation_run_id END
		WHERE id = (SELECT session_id FROM runs WHERE id = ?) AND deleted_at IS NULL
			AND (mutation_run_id IS NULL OR mutation_run_id = ?)
	`)
	const latestInterruptedRunForSessionStmt = db.prepare(`
		SELECT id FROM runs
		WHERE session_id = ? AND status = 'interrupted'
		ORDER BY started_at DESC
		LIMIT 1
	`)
	const finishLatestInterruptedRunSessionStateStmt = db.prepare(`
		UPDATE sessions
		SET runtime_state = ?,
			runtime_state_updated_at = ?,
			mutation_run_id = CASE WHEN mutation_run_id = ? THEN NULL ELSE mutation_run_id END
		WHERE id = ? AND deleted_at IS NULL
			AND (mutation_run_id IS NULL OR mutation_run_id = ?)
	`)
	const interruptRunningStmt = db.prepare(`
		UPDATE runs
		SET status = 'interrupted', ended_at = ?, error = COALESCE(error, 'Pinano server stopped before this run finished.'), stop_reason = 'interrupted'
		WHERE status = 'running'
	`)
	const interruptRunningSessionsStmt = db.prepare(`
		UPDATE sessions
		SET runtime_state = 'interrupted',
			runtime_state_updated_at = ?,
			mutation_run_id = NULL
		WHERE id IN (
			SELECT DISTINCT session_id
			FROM runs
			WHERE status = 'interrupted' AND ended_at = ?
		)
			AND deleted_at IS NULL
	`)
	const startServiceRunStmt = db.prepare(`
		INSERT INTO service_runs (
			id,
			pid,
			cwd,
			transport,
			port,
			code_fingerprint,
			status,
			started_at
		)
		VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
		ON CONFLICT(id) DO UPDATE SET
			pid = excluded.pid,
			cwd = excluded.cwd,
			transport = excluded.transport,
			port = excluded.port,
			code_fingerprint = excluded.code_fingerprint,
			status = 'running',
			started_at = excluded.started_at,
			ended_at = NULL,
			exit_code = NULL,
			signal = NULL,
			reason = NULL
	`)
	const finishServiceRunStmt = db.prepare(`
		UPDATE service_runs
		SET status = ?,
			ended_at = ?,
			exit_code = ?,
			signal = ?,
			reason = ?
		WHERE id = ? AND status = 'running'
	`)
	const recoverServiceRunsStmt = db.prepare(`
		UPDATE service_runs
		SET status = 'unexpected_exit',
			ended_at = ?,
			reason = COALESCE(reason, ?)
		WHERE status = 'running'
			AND (? IS NULL OR id != ?)
	`)
	const listServiceRunsStmt = db.prepare(`
		SELECT
			id,
			pid,
			cwd,
			transport,
			port,
			code_fingerprint AS codeFingerprint,
			status,
			started_at AS startedAt,
			ended_at AS endedAt,
			exit_code AS exitCode,
			signal,
			reason
		FROM service_runs
		ORDER BY started_at DESC
		LIMIT ?
	`)

	/** @type {ServerDb} */
	const api = {
		raw: db,
		upsertSession(session) {
			const at = session.updatedAt ?? nowIso()
			const initialWd = typeof session.initialWd === "string" && session.initialWd ? session.initialWd : session.cwd
			upsertSessionStmt.run(
				session.id,
				session.cwd,
				initialWd,
				session.createdAt ?? at,
				at,
			)
		},
		touchSession(id, cwd, updatedAt) {
			touchSessionStmt.run(updatedAt ?? null, cwd ?? null, id)
		},
		markSessionDeleted(id) {
			markDeletedStmt.run(nowIso(), id)
		},
		setSessionRuntimeState(id, state) {
			const at = nowIso()
			setRuntimeStateStmt.run(state, at, id)
		},
		setAgentViewMetadata(id, metadata) {
			const at = metadata.updatedAt ?? nowIso()
			setAgentViewStmt.run(
				metadata.state ?? null,
				metadata.descriptionInUi ?? metadata.description ?? null,
				normalizeProjectTag(metadata.projectTag),
				metadata.needsInput ?? null,
				metadata.result ?? null,
				at,
				id,
			)
		},
		getAgentViewMetadata(id) {
			const row = getAgentViewStmt.get(id)
			if (!row?.description && !row?.projectTag && !row?.state && !row?.needsInput && !row?.result) return undefined
			return {
				state: row.state ?? undefined,
				descriptionInUi: row.description ?? undefined,
				description: row.description ?? undefined,
				projectTag: row.projectTag ?? undefined,
				needsInput: row.needsInput ?? undefined,
				result: row.result ?? undefined,
				updatedAt: row.updatedAt ?? undefined,
			}
		},
		getSessionMutation(id) {
			const row = getSessionMutationStmt.get(id)
			if (!row) return undefined
			return {
				mutationVersion: Number(row.mutationVersion ?? 0),
				mutationRunId: row.mutationRunId ?? undefined,
				runtimeState: row.runtimeState ?? undefined,
				agentViewState: row.agentViewState ?? undefined,
			}
		},
		getPromptDraft(id) {
			return promptDraftFromRow(getPromptDraftStmt.get(id))
		},
		setPromptDraft(id, text, options = {}) {
			const clientId = typeof options.clientId === "string" && options.clientId ? options.clientId : null
			const clientSeq = Number.isInteger(options.clientSeq) && options.clientSeq > 0 ? options.clientSeq : null
			db.exec("BEGIN IMMEDIATE")
			try {
				if (clientId && clientSeq !== null) {
					const previousClientSeq = Number(getPromptDraftClientSeqStmt.get(id, clientId)?.lastSeq ?? 0)
					if (clientSeq <= previousClientSeq) {
						db.exec("COMMIT")
						return promptDraftFromRow(getPromptDraftStmt.get(id), { applied: false })
					}
				}
				const version = Number(currentPromptDraftVersionStmt.get(id)?.version ?? 0) + 1
				const at = nowIso()
				setPromptDraftStmt.run(id, text, version, at, clientId, clientSeq)
				if (clientId && clientSeq !== null) upsertPromptDraftClientSeqStmt.run(id, clientId, clientSeq)
				db.exec("COMMIT")
				return promptDraftFromRow(getPromptDraftStmt.get(id), { applied: true })
			} catch (err) {
				db.exec("ROLLBACK")
				throw err
			}
		},
		getUiState(key) {
			const row = getUiStateStmt.get(key)
			return row ? parseJson(row.valueJson) : undefined
		},
		setUiState(key, value) {
			const valueJson = JSON.stringify(value)
			if (valueJson === undefined) throw new Error("ui state value must be JSON-serializable")
			setUiStateStmt.run(key, valueJson, nowIso())
			return parseJson(valueJson)
		},
		deleteUiState(key) {
			return Number(deleteUiStateStmt.run(key).changes ?? 0) > 0
		},
		listSessions(cwd) {
			const rows = cwd == null ? listSessionsStmt.all() : listSessionsForCwdStmt.all(cwd)
			return rows.map((row) => ({
				id: row.id,
				cwd: row.cwd,
				initialWd: row.initialWd ?? undefined,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
				latestRunStartedAt: row.latestRunStartedAt ?? undefined,
				latestRunEndedAt: row.latestRunEndedAt ?? undefined,
				latestRunError: row.latestRunError ?? undefined,
				latestRunStopReason: row.latestRunStopReason ?? undefined,
				runStatus: normalizeRunStatus(row.latestRunStatus),
				runtimeState: row.runtimeState ?? undefined,
				agentView: row.agentViewState || row.agentViewDescription || row.agentViewProjectTag || row.agentViewNeedsInput || row.agentViewResult ? {
					state: row.agentViewState ?? undefined,
					descriptionInUi: row.agentViewDescription ?? undefined,
					description: row.agentViewDescription ?? undefined,
					projectTag: row.agentViewProjectTag ?? undefined,
					needsInput: row.agentViewNeedsInput ?? undefined,
					result: row.agentViewResult ?? undefined,
					updatedAt: row.agentViewUpdatedAt ?? undefined,
				} : undefined,
			}))
		},
		loadSessionPreviewMessages(id) {
			return previewMessagesStmt.all(id).map(previewMessageFromRow)
		},
		loadSessionPreviewMessagesForSessions(ids) {
			return loadSessionPreviewMessagesForSessions(ids)
		},
		loadSessionOverviewPreviewMessagesForSessions(ids) {
			const cachedBySessionId = ensureSessionOverviewsForSessions(ids)
			return ids.flatMap((id) => {
				const row = cachedBySessionId.get(id)
				return row ? cachedPreviewRowsFromOverview(row) : []
			})
		},
		latestSessionForCwd(cwd) {
			return latestForCwdStmt.get(cwd)?.id
		},
		findSessionIdsByPrefix(prefix) {
			return findByPrefixStmt.all(`${prefix}%`).map((row) => row.id)
		},
		replaceSessions(sessions) {
			db.exec("BEGIN IMMEDIATE")
			try {
				db.prepare("UPDATE sessions SET deleted_at = ? WHERE deleted_at IS NULL").run(nowIso())
				for (const session of sessions) api.upsertSession(session)
				db.exec("COMMIT")
			} catch (err) {
				db.exec("ROLLBACK")
				throw err
			}
		},
		sessionCount() {
			return Number(sessionCountStmt.get().n ?? 0)
		},
		startRun(run) {
			const at = run.startedAt ?? nowIso()
			if (!Number.isInteger(run.expectedMutationVersion)) {
				throw mutationError("A session mutation version is required to start a run.", "PINANO_SESSION_MUTATION_VERSION_REQUIRED")
			}
			db.exec("BEGIN IMMEDIATE")
			try {
				startRunStmt.run(run.id, run.sessionId, at)
				const claimed = startRunSessionStateStmt.run(
					at,
					run.id,
					run.sessionId,
					run.expectedMutationVersion,
				)
				if (Number(claimed.changes ?? 0) !== 1) {
					const current = getSessionMutationStmt.get(run.sessionId)
					if (!current) throw mutationError(`Session not found: ${run.sessionId}`, "PINANO_SESSION_NOT_FOUND")
					if (current.mutationRunId) {
						throw mutationError(`Session ${run.sessionId} is already being mutated by run ${current.mutationRunId}.`, "PINANO_SESSION_MUTATION_BUSY")
					}
					throw mutationError(`Session ${run.sessionId} changed in the database; reopen it before starting a run.`, "PINANO_SESSION_STALE")
				}
				db.exec("COMMIT")
			} catch (err) {
				db.exec("ROLLBACK")
				throw err
			}
		},
		finishRun(id, update) {
			const at = update.endedAt ?? nowIso()
			db.exec("BEGIN IMMEDIATE")
			try {
				finishRunStmt.run(
					update.status,
					at,
					update.error ?? null,
					update.stopReason ?? null,
					id,
				)
				const state = update.status === "completed" ? "idle" : normalizeRunStatus(update.status)
				finishRunSessionStateStmt.run(state, at, id, id, id)
				db.exec("COMMIT")
			} catch (err) {
				db.exec("ROLLBACK")
				throw err
			}
		},
		finishLatestInterruptedRunForSession(sessionId, update) {
			const row = latestInterruptedRunForSessionStmt.get(sessionId)
			if (!row?.id) return false
			const at = update.endedAt ?? nowIso()
			db.exec("BEGIN IMMEDIATE")
			try {
				finishRunStmt.run(
					update.status,
					at,
					update.error ?? null,
					update.stopReason ?? null,
					row.id,
				)
				const state = update.status === "completed" ? "idle" : normalizeRunStatus(update.status)
				finishLatestInterruptedRunSessionStateStmt.run(state, at, row.id, sessionId, row.id)
				db.exec("COMMIT")
				return true
			} catch (err) {
				db.exec("ROLLBACK")
				throw err
			}
		},
		interruptRunningRuns() {
			const at = nowIso()
			db.exec("BEGIN IMMEDIATE")
			try {
				const changes = Number(interruptRunningStmt.run(at).changes ?? 0)
				if (changes > 0) interruptRunningSessionsStmt.run(at, at)
				db.exec("COMMIT")
				return changes
			} catch (err) {
				db.exec("ROLLBACK")
				throw err
			}
		},
		startServiceRun(run) {
			startServiceRunStmt.run(
				run.id,
				run.pid ?? null,
				run.cwd,
				run.transport ?? null,
				run.port ?? null,
				run.codeFingerprint ?? null,
				run.startedAt ?? nowIso(),
			)
		},
		finishServiceRun(id, update) {
			finishServiceRunStmt.run(
				update.status,
				update.endedAt ?? nowIso(),
				update.exitCode ?? null,
				update.signal ?? null,
				update.reason ?? null,
				id,
			)
		},
		recoverServiceRuns(reason = "Pinano service started while a previous service was still marked running.", exceptId) {
			return Number(recoverServiceRunsStmt.run(nowIso(), reason, exceptId ?? null, exceptId ?? null).changes ?? 0)
		},
		listServiceRuns(limit = 20) {
			return listServiceRunsStmt.all(Math.max(1, Math.min(100, Number(limit) || 20)))
		},
		close() {
			db.close()
		},
	}

	if (options.recoverRunningRuns) api.interruptRunningRuns()
	return api
}

export { SCHEMA_VERSION }
