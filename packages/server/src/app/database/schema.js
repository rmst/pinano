// Canonical server database schema and fresh-database initialization.

export const SCHEMA_VERSION = 40
export const SESSION_KIND_NORMAL = "normal"
export const SESSION_KIND_PROJECT_MAINTENANCE = "project_maintenance"

function createSchema(db) {
	db.exec(`
		CREATE TABLE projects (
			id TEXT PRIMARY KEY,
			root TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			retired_at TEXT
		);
		CREATE UNIQUE INDEX idx_projects_active_root
			ON projects(root)
			WHERE retired_at IS NULL;

		CREATE TABLE sessions (
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
			agent_view_project_tag TEXT,
			branched_from_session_id TEXT,
			branched_from_entry_id TEXT,
			branched_at TEXT,
			mutation_version INTEGER NOT NULL DEFAULT 0,
			mutation_run_id TEXT,
			initial_wd TEXT,
			hidden INTEGER NOT NULL DEFAULT 0,
			project_dir TEXT,
			project_id TEXT REFERENCES projects(id),
			session_kind TEXT NOT NULL DEFAULT 'normal'
		);
		CREATE INDEX idx_sessions_cwd_updated
			ON sessions(cwd, updated_at DESC);
		CREATE INDEX idx_sessions_project_maintenance_id
			ON sessions(id)
			WHERE deleted_at IS NULL
				AND session_kind = 'project_maintenance';
		CREATE INDEX idx_sessions_project_id
			ON sessions(project_id)
			WHERE project_id IS NOT NULL;
		CREATE UNIQUE INDEX idx_sessions_project_maintenance_project_id
			ON sessions(project_id)
			WHERE deleted_at IS NULL
				AND session_kind = 'project_maintenance'
				AND project_id IS NOT NULL;
		CREATE UNIQUE INDEX idx_sessions_project_maintenance_legacy_project_dir
			ON sessions(project_dir)
			WHERE deleted_at IS NULL
				AND session_kind = 'project_maintenance'
				AND project_id IS NULL
				AND project_dir IS NOT NULL;

		CREATE TABLE entries (
			global_id TEXT PRIMARY KEY
		);

		CREATE TABLE session_entries (
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			seq INTEGER NOT NULL,
			global_id TEXT NOT NULL REFERENCES entries(global_id),
			entry_id TEXT NOT NULL,
			parent_entry_id TEXT,
			timestamp TEXT NOT NULL,
			kind TEXT NOT NULL,
			manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
			PRIMARY KEY (session_id, seq),
			UNIQUE (session_id, entry_id),
			FOREIGN KEY (session_id, parent_entry_id) REFERENCES session_entries(session_id, entry_id)
		) WITHOUT ROWID;
		CREATE UNIQUE INDEX idx_session_entries_global ON session_entries(global_id, session_id);

		CREATE TABLE entry_messages (
			global_id TEXT PRIMARY KEY REFERENCES entries(global_id),
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
		);
		CREATE INDEX idx_entry_messages_role ON entry_messages(role);
		CREATE INDEX idx_entry_messages_tool_call ON entry_messages(tool_call_id);

		CREATE TABLE entry_message_blocks (
			global_id TEXT NOT NULL REFERENCES entries(global_id),
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
			tool_input TEXT,
			image_original_data TEXT,
			image_original_mime_type TEXT,
			image_original_width_px INTEGER,
			image_original_height_px INTEGER,
			image_attachment_id TEXT,
			image_number INTEGER,
			image_attachment_session_id TEXT,
			PRIMARY KEY (global_id, ordinal)
		);
		CREATE INDEX idx_entry_message_blocks_tool_call ON entry_message_blocks(tool_call_id);

		CREATE TABLE entry_usage (
			global_id TEXT PRIMARY KEY REFERENCES entries(global_id),
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
		);

		CREATE TABLE entry_labels (
			global_id TEXT PRIMARY KEY REFERENCES entries(global_id),
			target_global_id TEXT NOT NULL REFERENCES entries(global_id),
			label TEXT
		);
		CREATE INDEX idx_entry_labels_target ON entry_labels(target_global_id);

		CREATE TABLE entry_custom_entries (
			global_id TEXT PRIMARY KEY REFERENCES entries(global_id),
			custom_type TEXT NOT NULL,
			data_json TEXT
		);
		CREATE INDEX idx_entry_custom_entries_type ON entry_custom_entries(custom_type, global_id);

		CREATE TABLE entry_context_loads (
			global_id TEXT PRIMARY KEY REFERENCES entries(global_id),
			source TEXT NOT NULL,
			cwd TEXT,
			loaded_at TEXT NOT NULL,
			disabled INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX idx_entry_context_loads_source ON entry_context_loads(source);

		CREATE TABLE entry_context_files (
			global_id TEXT NOT NULL REFERENCES entries(global_id),
			ordinal INTEGER NOT NULL,
			path TEXT NOT NULL,
			scope_dir TEXT,
			content TEXT NOT NULL,
			hash TEXT,
			identity_path TEXT,
			PRIMARY KEY (global_id, ordinal)
		);
		CREATE INDEX idx_entry_context_files_path ON entry_context_files(path);

		CREATE TABLE runs (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			status TEXT NOT NULL,
			started_at TEXT NOT NULL,
			ended_at TEXT,
			error TEXT,
			stop_reason TEXT
		);
		CREATE INDEX idx_runs_session_started ON runs(session_id, started_at DESC);
		CREATE INDEX idx_runs_status ON runs(status);

		CREATE TABLE service_runs (
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
		);
		CREATE INDEX idx_service_runs_status_started ON service_runs(status, started_at DESC);

		CREATE TABLE session_overviews (
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
		);

		CREATE TABLE session_prompt_drafts (
			session_id TEXT PRIMARY KEY REFERENCES sessions(id),
			text TEXT NOT NULL,
			version INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			updated_by_client_id TEXT,
			updated_by_client_seq INTEGER
		);
		CREATE TABLE session_prompt_draft_clients (
			session_id TEXT NOT NULL REFERENCES sessions(id),
			client_id TEXT NOT NULL,
			last_seq INTEGER NOT NULL,
			PRIMARY KEY (session_id, client_id)
		);

		CREATE TABLE session_attachments (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			kind TEXT NOT NULL,
			number INTEGER NOT NULL,
			label TEXT NOT NULL,
			detail TEXT,
			created_at TEXT NOT NULL,
			UNIQUE (session_id, number)
		);
		CREATE INDEX idx_session_attachments_session_kind ON session_attachments(session_id, kind, number);
		CREATE TABLE session_attachment_variants (
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
		);
		CREATE INDEX idx_session_attachment_variants_storage ON session_attachment_variants(storage_backend, storage_key);

		CREATE TABLE sub_sessions (
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
		);
		CREATE INDEX idx_sub_sessions_child ON sub_sessions(child_session_id);
		CREATE INDEX idx_sub_sessions_parent ON sub_sessions(parent_session_id, updated_at DESC);
		CREATE INDEX idx_sub_sessions_root ON sub_sessions(root_session_id, updated_at DESC);

		CREATE TABLE preview_root_cache (
			scope_id TEXT PRIMARY KEY,
			scope_kind TEXT NOT NULL,
			root_path TEXT NOT NULL,
			project_dir TEXT,
			session_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX idx_preview_root_cache_kind ON preview_root_cache(scope_kind, updated_at DESC);
		CREATE UNIQUE INDEX idx_preview_root_cache_kind_root_path ON preview_root_cache(scope_kind, root_path);
		CREATE INDEX idx_preview_root_cache_project_dir ON preview_root_cache(project_dir) WHERE project_dir IS NOT NULL;

		CREATE TABLE ui_state (
			state_key TEXT PRIMARY KEY,
			value_json TEXT NOT NULL CHECK (json_valid(value_json)),
			updated_at TEXT NOT NULL
		);
	`)
}

function hasApplicationSchema(db) {
	return Boolean(db.prepare(`
		SELECT 1
		FROM sqlite_master
		WHERE name NOT LIKE 'sqlite_%'
			AND type IN ('table', 'view', 'index', 'trigger')
		LIMIT 1
	`).get())
}

function foreignKeyError(violation) {
	return new Error(`Database schema initialization produced an invalid foreign key from ${violation.table} row ${violation.rowid} to ${violation.parent}`)
}

function schemaSource(db) {
	let { user_version: version } = db.prepare("PRAGMA user_version").get()
	version = Number(version ?? 0)
	if (version === SCHEMA_VERSION) return "current"
	if (version === 0 && !hasApplicationSchema(db)) return "empty"
	if (version > SCHEMA_VERSION) {
		throw new Error(
			`Cerex database schema version ${version} is newer than supported version ${SCHEMA_VERSION}. ` +
				"Upgrade Cerex before opening this database. No schema or application data was changed; " +
				"do not change PRAGMA user_version manually.",
		)
	}
	throw new Error(
		`Cerex database schema version ${version} is older than required version ${SCHEMA_VERSION}. ` +
			"This release cannot upgrade it. No schema or application data was changed. " +
			`Restore a schema version ${SCHEMA_VERSION} database or use a Cerex release that supports this schema; ` +
			"do not change PRAGMA user_version manually.",
	)
}

export function ensureServerDbSchema(db) {
	if (schemaSource(db) === "current") return
	const foreignKeys = Number(db.prepare("PRAGMA foreign_keys").get().foreign_keys) !== 0
	if (foreignKeys) {
		db.exec("PRAGMA foreign_keys = OFF")
		if (Number(db.prepare("PRAGMA foreign_keys").get().foreign_keys) !== 0) {
			throw new Error("Cannot initialize the database schema while a transaction is active")
		}
	}
	let transactionOpen = false
	try {
		db.exec("BEGIN EXCLUSIVE")
		transactionOpen = true
		if (schemaSource(db) === "empty") createSchema(db)
		const violation = db.prepare("PRAGMA foreign_key_check").get()
		if (violation) throw foreignKeyError(violation)
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
		db.exec("COMMIT")
		transactionOpen = false
	} catch (err) {
		if (transactionOpen) db.exec("ROLLBACK")
		throw err
	} finally {
		if (foreignKeys) db.exec("PRAGMA foreign_keys = ON")
	}
}
