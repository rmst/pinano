// Canonical server database schema and forward-only migrations.

import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"

import { promptImageLabel } from "../../../../protocol/src/prompt-images.js"
import {
	SESSION_ATTACHMENT_KIND_IMAGE,
	writePromptImageAttachmentFilesSync,
} from "../session/attachments.js"
import {
	insertSessionAttachmentRows,
	nextImageAttachmentNumber,
} from "./attachments.js"
import { nowIso, parseJson } from "./values.js"
import {
	LEGACY_SESSION_CUSTOM_TYPE_WEB_REWIND,
	LEGACY_SESSION_CUSTOM_TYPE_WEB_TREE_SWITCH,
	SESSION_CUSTOM_TYPE_BRANCH_SWITCH,
	SESSION_CUSTOM_TYPE_REWIND,
} from "../session/custom-types.js"
import { recomputeAllSessionOverviewProjections } from "../../session-manager/session-overviews.js"

export const SCHEMA_VERSION = 35
export const SESSION_KIND_NORMAL = "normal"
export const SESSION_KIND_PROJECT_MAINTENANCE = "project_maintenance"

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
	// v27 → v28: hidden sub-sessions. Hidden sessions remain ordinary sessions
	// that can be opened directly, but overview/session-list queries omit them
	// unless the caller explicitly asks for internal rows.
	(db) => {
		if (!tableColumns(db, "sessions").has("hidden")) db.exec("ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0")
		db.exec(`
			CREATE TABLE IF NOT EXISTS sub_sessions (
				child_session_id TEXT PRIMARY KEY REFERENCES sessions(id),
				parent_session_id TEXT NOT NULL REFERENCES sessions(id),
				root_session_id TEXT NOT NULL REFERENCES sessions(id),
				name TEXT NOT NULL,
				origin TEXT NOT NULL,
				fork_turns TEXT NOT NULL,
				depth INTEGER NOT NULL DEFAULT 1,
				task TEXT,
				branch_entry_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				closed_at TEXT,
				close_reason TEXT,
				UNIQUE(parent_session_id, name)
			)
		`)
		db.exec("CREATE INDEX IF NOT EXISTS idx_sub_sessions_parent ON sub_sessions(parent_session_id, updated_at DESC)")
		db.exec("CREATE INDEX IF NOT EXISTS idx_sub_sessions_root ON sub_sessions(root_session_id, updated_at DESC)")
		db.exec("CREATE INDEX IF NOT EXISTS idx_sub_sessions_child ON sub_sessions(child_session_id)")
	},
	// v28 → v29: session_overviews is now a maintained current-branch projection. Backfill once so session-list reads never need to prove cache freshness.
	(db) => {
		db.exec("DELETE FROM session_overviews")
		recomputeAllSessionOverviewProjections(db)
	},
	// v29 → v30: cache the projected effective projectDir for list-time
	// project lookup. Durable config plus session_properties remain authoritative;
	// fallback to initial_wd/cwd happens at read time.
	(db) => {
		if (!tableColumns(db, "sessions").has("project_dir")) db.exec("ALTER TABLE sessions ADD COLUMN project_dir TEXT")
	},
	// v30 → v31: retain original prompt images when a resized derivative is
	// sent to the model.
	(db) => {
		addImageOriginalColumns(db, "entry_message_blocks")
		if (tableExists(db, "message_blocks")) addImageOriginalColumns(db, "message_blocks")
	},
	// v31 → v32: classify hidden autonomous maintenance sessions on the
	// canonical session row. Project previews route through the project
	// maintenance session whose `project_dir` owns the preview files.
	(db) => {
		if (!tableColumns(db, "sessions").has("session_kind")) db.exec(`ALTER TABLE sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT '${SESSION_KIND_NORMAL}'`)
		db.exec(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_project_maintenance_project_dir
			ON sessions(project_dir)
			WHERE deleted_at IS NULL
				AND session_kind = '${SESSION_KIND_PROJECT_MAINTENANCE}'
				AND project_dir IS NOT NULL
		`)
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_sessions_project_maintenance_id
			ON sessions(id)
			WHERE deleted_at IS NULL
				AND session_kind = '${SESSION_KIND_PROJECT_MAINTENANCE}'
		`)
	},
	// v32 → v33: reconstructible preview-root cache. Preview hostnames carry a
	// root hash; this table resolves registered project/static roots from that
	// hash without using runner sessions as discovery records.
	(db) => {
		db.exec(`
			CREATE TABLE IF NOT EXISTS preview_root_cache (
				scope_id TEXT PRIMARY KEY,
				scope_kind TEXT NOT NULL,
				root_path TEXT NOT NULL,
				project_dir TEXT,
				session_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`)
		db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_preview_root_cache_kind_root_path ON preview_root_cache(scope_kind, root_path)")
		db.exec("CREATE INDEX IF NOT EXISTS idx_preview_root_cache_kind ON preview_root_cache(scope_kind, updated_at DESC)")
		db.exec("CREATE INDEX IF NOT EXISTS idx_preview_root_cache_project_dir ON preview_root_cache(project_dir) WHERE project_dir IS NOT NULL")
	},
	// v33 → v34: store user prompt images as durable session attachments instead
	// of embedding base64 payloads in transcript message blocks and snapshots.
	(db, options = {}) => {
		ensureSessionAttachmentSchema(db)
		migrateInlinePromptImagesToAttachments(db, options)
	},
	// v34 → v35: cover the worktree-presence projection used by session lists so SQLite does not need table lookups for every matching custom entry and session reference.
	(db) => {
		db.exec("DROP INDEX IF EXISTS idx_entry_custom_entries_type")
		db.exec("CREATE INDEX idx_entry_custom_entries_type ON entry_custom_entries(custom_type, global_id)")
		db.exec("DROP INDEX IF EXISTS idx_session_entry_refs_global")
		db.exec("CREATE INDEX idx_session_entry_refs_global ON session_entry_refs(global_id, session_id)")
	},
]

function tableExists(db, name) {
	return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

function tableColumns(db, table) {
	return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name))
}

function addImageOriginalColumns(db, table) {
	if (!tableExists(db, table)) return
	const columns = tableColumns(db, table)
	if (!columns.has("image_original_data")) db.exec(`ALTER TABLE ${table} ADD COLUMN image_original_data TEXT`)
	if (!columns.has("image_original_mime_type")) db.exec(`ALTER TABLE ${table} ADD COLUMN image_original_mime_type TEXT`)
	if (!columns.has("image_original_width_px")) db.exec(`ALTER TABLE ${table} ADD COLUMN image_original_width_px INTEGER`)
	if (!columns.has("image_original_height_px")) db.exec(`ALTER TABLE ${table} ADD COLUMN image_original_height_px INTEGER`)
}

function addImageAttachmentColumns(db, table) {
	if (!tableExists(db, table)) return
	const columns = tableColumns(db, table)
	if (!columns.has("image_attachment_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN image_attachment_id TEXT`)
	if (!columns.has("image_number")) db.exec(`ALTER TABLE ${table} ADD COLUMN image_number INTEGER`)
	if (!columns.has("image_attachment_session_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN image_attachment_session_id TEXT`)
}

function ensureSessionAttachmentSchema(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_attachments (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			kind TEXT NOT NULL,
			number INTEGER NOT NULL,
			label TEXT NOT NULL,
			detail TEXT,
			created_at TEXT NOT NULL,
			UNIQUE (session_id, number)
		)
	`)
	if (!tableColumns(db, "session_attachments").has("detail")) db.exec("ALTER TABLE session_attachments ADD COLUMN detail TEXT")
	db.exec("CREATE INDEX IF NOT EXISTS idx_session_attachments_session_kind ON session_attachments(session_id, kind, number)")
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_attachment_variants (
			attachment_id TEXT NOT NULL REFERENCES session_attachments(id) ON DELETE CASCADE,
			variant TEXT NOT NULL,
			storage_backend TEXT NOT NULL,
			storage_key TEXT NOT NULL,
			filename TEXT NOT NULL,
			file_path TEXT,
			mime_type TEXT NOT NULL,
			byte_size INTEGER NOT NULL,
			sha256 TEXT NOT NULL,
			width_px INTEGER,
			height_px INTEGER,
			PRIMARY KEY (attachment_id, variant)
		)
	`)
	db.exec("CREATE INDEX IF NOT EXISTS idx_session_attachment_variants_storage ON session_attachment_variants(storage_backend, storage_key)")
	addImageAttachmentColumns(db, "entry_message_blocks")
	if (tableExists(db, "message_blocks")) addImageAttachmentColumns(db, "message_blocks")
}

const PROMPT_IMAGE_LABEL_RE = /\[Image #(\d+)\]/g
const PROMPT_IMAGE_OPEN_TAG_RE = /^<image name=\[Image #(\d+)\]>$/

/** @param {number} number */
function promptImageOpenTagForNumber(number) {
	return `<image name=${promptImageLabel(number)}>`
}

/** @param {string | undefined | null} text */
function promptImageOpenTagNumber(text) {
	const match = String(text ?? "").match(PROMPT_IMAGE_OPEN_TAG_RE)
	return match ? Number(match[1]) : undefined
}

function updateMigratedPromptImageLabels(db, replacementsByGlobalId) {
	if (replacementsByGlobalId.size === 0) return
	const textRowsStmt = db.prepare("SELECT ordinal, text FROM entry_message_blocks WHERE global_id = ? AND type = 'text'")
	const updateStmt = db.prepare("UPDATE entry_message_blocks SET text = ? WHERE global_id = ? AND ordinal = ?")
	for (const [globalId, replacements] of replacementsByGlobalId) {
		for (const row of textRowsStmt.all(globalId)) {
			if (!row.text) continue
			const replaced = String(row.text).replace(PROMPT_IMAGE_LABEL_RE, (label) => replacements.get(label) ?? label)
			if (replaced !== row.text) updateStmt.run(replaced, globalId, row.ordinal)
		}
	}
}

function migrateInlinePromptImagesToAttachments(db, options = {}) {
	if (!tableExists(db, "entry_message_blocks")) return
	const rows = db.prepare(`
		SELECT
			mb.global_id AS globalId,
			mb.ordinal,
			COALESCE(ce.created_by_session_id, (
				SELECT ser.session_id
				FROM session_entry_refs ser
				WHERE ser.global_id = mb.global_id
				ORDER BY ser.session_id
				LIMIT 1
			)) AS sessionId,
			mb.image_data AS imageData,
			mb.image_mime_type AS imageMimeType,
			mb.image_detail AS imageDetail,
			mb.image_width_px AS imageWidthPx,
			mb.image_height_px AS imageHeightPx,
			mb.image_original_data AS imageOriginalData,
			mb.image_original_mime_type AS imageOriginalMimeType,
			mb.image_original_width_px AS imageOriginalWidthPx,
			mb.image_original_height_px AS imageOriginalHeightPx,
			(
				SELECT text
				FROM entry_message_blocks prev
				WHERE prev.global_id = mb.global_id
					AND prev.ordinal = mb.ordinal - 1
					AND prev.type = 'text'
				LIMIT 1
			) AS previousText
		FROM entry_message_blocks mb
		LEFT JOIN conversation_entries ce ON ce.global_id = mb.global_id
		WHERE mb.type = 'image'
			AND COALESCE(mb.image_data, '') != ''
		ORDER BY sessionId, ce.timestamp, mb.global_id, mb.ordinal
	`).all()
	if (rows.length === 0) return
	const replacementsByGlobalId = new Map()
	const nextBySession = new Map()
	const updateBlock = db.prepare(`
		UPDATE entry_message_blocks
		SET image_attachment_id = ?,
			image_number = ?,
			image_attachment_session_id = ?,
			image_data = NULL,
			image_original_data = NULL
		WHERE global_id = ? AND ordinal = ?
	`)
	const updateMarker = db.prepare("UPDATE entry_message_blocks SET text = ? WHERE global_id = ? AND ordinal = ? AND type = 'text'")
	const writtenFiles = []
	try {
		for (const row of rows) {
			if (!row.sessionId) continue
			const next = nextBySession.get(row.sessionId) ?? nextImageAttachmentNumber(db, row.sessionId)
			nextBySession.set(row.sessionId, next + 1)
			const attachmentId = randomUUID()
			const label = promptImageLabel(next)
			const createdAt = nowIso()
			const image = {
				data: row.imageData,
				mimeType: row.imageMimeType ?? "application/octet-stream",
				widthPx: row.imageWidthPx ?? undefined,
				heightPx: row.imageHeightPx ?? undefined,
				...(row.imageOriginalData ? {
					original: {
						data: row.imageOriginalData,
						mimeType: row.imageOriginalMimeType ?? "application/octet-stream",
						widthPx: row.imageOriginalWidthPx ?? undefined,
						heightPx: row.imageOriginalHeightPx ?? undefined,
					},
				} : {}),
			}
			const variants = writePromptImageAttachmentFilesSync(row.sessionId, next, image, { dbPath: options.dbPath })
			writtenFiles.push(...[variants.display?.filePath, variants.original?.filePath].filter(Boolean))
			insertSessionAttachmentRows(db, {
				id: attachmentId,
				sessionId: row.sessionId,
				kind: SESSION_ATTACHMENT_KIND_IMAGE,
				number: next,
				label,
				detail: row.imageDetail ?? null,
				createdAt,
			}, [variants.display, variants.original])
			updateBlock.run(attachmentId, next, row.sessionId, row.globalId, row.ordinal)
			const oldNumber = promptImageOpenTagNumber(row.previousText)
			if (oldNumber !== undefined) {
				const oldLabel = promptImageLabel(oldNumber)
				let replacements = replacementsByGlobalId.get(row.globalId)
				if (!replacements) {
					replacements = new Map()
					replacementsByGlobalId.set(row.globalId, replacements)
				}
				replacements.set(oldLabel, label)
				updateMarker.run(promptImageOpenTagForNumber(next), row.globalId, row.ordinal - 1)
			}
		}
	} catch (err) {
		for (const filePath of writtenFiles) rmSync(filePath, { force: true })
		throw err
	}
	updateMigratedPromptImageLabels(db, replacementsByGlobalId)
	if (tableExists(db, "session_overviews")) db.exec("DELETE FROM session_overviews")
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

export function migrateServerDb(db, options = {}) {
	db.exec("BEGIN EXCLUSIVE")
	try {
		let { user_version: version } = db.prepare("PRAGMA user_version").get()
		version = Number(version ?? 0)
		if (version > SCHEMA_VERSION) {
			throw new Error(
				`Database schema version ${version} is newer than supported version ${SCHEMA_VERSION}. ` +
				"Please upgrade Cerex.",
			)
		}
		while (version < SCHEMA_VERSION) {
			migrations[version](db, options)
			version++
			db.exec(`PRAGMA user_version = ${version}`)
		}
		db.exec("COMMIT")
	} catch (err) {
		db.exec("ROLLBACK")
		throw err
	}
}
