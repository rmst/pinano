#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const VERSION = "pinano-sqlite3 0.1 sqlite3-compatible query subset"

class SqliteCliError extends Error {
	constructor(message, exitCode = 1) {
		super(message)
		this.exitCode = exitCode
	}
}

function usage() {
	return `${VERSION}

Supported subset: sqlite3 [OPTIONS] DB [SQL], SQL from stdin, multiple SQL
statements, .tables, .schema [TABLE], .dump [TABLE], .import FILE TABLE,
.indexes [TABLE], .databases, .output, .once, .mode, .headers, .read, .quit.

Options: -readonly, -batch, -bail, -cmd SQL, -header/-noheader, -csv, -json,
-line, -list, -column, -tabs, -separator SEP, -version, -help. Unsupported
options and dot commands fail clearly.
`
}

function parseArgs(args) {
	const config = {
		mode: "list",
		headers: false,
		separator: "|",
		nullValue: "",
		insertTable: "table",
		outputPath: null,
		once: false,
		wroteOutput: false,
		readonly: false,
		dbPath: null,
		sql: null,
		preCommands: [],
	}
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]
		if (arg === "--") {
			if (!config.dbPath && args[i + 1]) config.dbPath = args[i + 1]
			if (args.length > i + 2) config.sql = args.slice(i + 2).join(" ")
			break
		}
		if (arg === "-version" || arg === "--version") return { ...config, version: true }
		if (arg === "-help" || arg === "--help" || arg === "-h") return { ...config, help: true }
		if (arg === "-readonly") config.readonly = true
		else if (arg === "-batch" || arg === "-bail") {}
		else if (arg === "-cmd") {
			if (i + 1 >= args.length) throw new SqliteCliError("option -cmd requires an argument", 1)
			config.preCommands.push(args[i + 1])
			i += 1
		} else if (arg === "-header" || arg === "-headers") config.headers = true
		else if (arg === "-noheader" || arg === "-noheaders") config.headers = false
		else if (arg === "-csv") config.mode = "csv"
		else if (arg === "-json") config.mode = "json"
		else if (arg === "-line") config.mode = "line"
		else if (arg === "-list") config.mode = "list"
		else if (arg === "-column") config.mode = "column"
		else if (arg === "-tabs") {
			config.mode = "list"
			config.separator = "\t"
		} else if (arg === "-separator") {
			if (i + 1 >= args.length) throw new SqliteCliError("option -separator requires an argument", 1)
			config.separator = args[i + 1]
			i += 1
		} else if (arg.startsWith("-")) {
			throw new SqliteCliError(`unsupported option ${arg}`, 1)
		} else if (!config.dbPath) {
			config.dbPath = arg
		} else {
			config.sql = args.slice(i).join(" ")
			break
		}
	}
	if (config.version || config.help) return config
	if (!config.dbPath) throw new SqliteCliError("missing database path", 1)
	return config
}

async function loadSql(config) {
	const sql = config.sql !== null ? config.sql : await readStdinText()
	return [...config.preCommands, sql].filter((part) => part.length > 0).join("\n")
}

async function readStdinText() {
	const chunks = []
	return new Promise((resolvePromise, reject) => {
		process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
		process.stdin.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf-8")))
		process.stdin.on("error", reject)
		process.stdin.resume?.()
	})
}

async function sqliteModule() {
	const emitWarning = process.emitWarning
	try {
		process.emitWarning = () => {}
		return await import("node:sqlite")
	} finally {
		process.emitWarning = emitWarning
	}
}

async function openDatabase(config) {
	const { DatabaseSync } = await sqliteModule()
	try {
		return config.readonly ? new DatabaseSync(config.dbPath, { readOnly: true }) : new DatabaseSync(config.dbPath)
	} catch (err) {
		throw new SqliteCliError(`cannot open database: ${err.message}`)
	}
}

async function run(config) {
	const db = await openDatabase(config)
	const state = { ...config }
	try {
		const input = await loadSql(config)
		for (const statement of splitStatements(input)) {
			await executeStatement(db, statement, state)
			if (state.stop) break
		}
		return 0
	} finally {
		db.close?.()
	}
}

async function executeStatement(db, statement, state) {
	const trimmed = statement.trim()
	if (!trimmed) return
	state.wroteOutput = false
	if (trimmed.startsWith(".")) {
		await executeDotCommand(db, trimmed, state)
		resetOnceAfterOutput(state)
		return
	}
	if (isQuery(trimmed)) {
		const rows = db.prepare(trimmed).all()
		const columns = columnsFor(db, trimmed, rows)
		writeRows(rows, columns, state)
	} else {
		db.exec(trimmed)
	}
	resetOnceAfterOutput(state)
}

async function executeDotCommand(db, command, state) {
	const [name, ...args] = command.split(/\s+/)
	if (name === ".headers" || name === ".header") {
		if (args.length !== 1 || !["on", "off"].includes(args[0])) throw new SqliteCliError("usage: .headers on|off")
		state.headers = args[0] === "on"
		return
	}
	if (name === ".mode") {
		applyMode(args, state)
		return
	}
	if (name === ".separator") {
		if (args.length !== 1) throw new SqliteCliError("usage: .separator SEP")
		state.separator = args[0]
		return
	}
	if (name === ".nullvalue") {
		if (args.length !== 1) throw new SqliteCliError("usage: .nullvalue STRING")
		state.nullValue = args[0]
		return
	}
	if (name === ".output" || name === ".once") {
		if (args.length > 1) throw new SqliteCliError(`usage: ${name} [FILE]`)
		if (args.length === 0 || args[0] === "stdout") {
			state.outputPath = null
			state.once = false
			return
		}
		if (args[0].startsWith("|")) throw new SqliteCliError(`${name} pipe output is not supported`)
		state.outputPath = args[0]
		state.once = name === ".once"
		writeFileSync(state.outputPath, "")
		return
	}
	if (name === ".tables") {
		const pattern = args[0]
		const rows = db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
		const names = rows.map((row) => row.name).filter((item) => !pattern || item.includes(pattern))
		if (names.length > 0) writeOutputText(state, `${names.join(" ")}\n`)
		return
	}
	if (name === ".indexes") {
		if (args.length > 1) throw new SqliteCliError("usage: .indexes [TABLE]")
		const rows = args[0]
			? db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(args[0])
			: db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
		if (rows.length > 0) writeOutputText(state, `${rows.map((row) => row.name).join(" ")}\n`)
		return
	}
	if (name === ".databases") {
		const rows = db.prepare("PRAGMA database_list").all()
		for (const row of rows) writeOutputText(state, `${row.seq}: ${row.name}: ${row.file || ""}\n`)
		return
	}
	if (name === ".schema") {
		const table = args[0]
		const sql = table
			? "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name = ? ORDER BY type, name"
			: "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
		const rows = table ? db.prepare(sql).all(table) : db.prepare(sql).all()
		for (const row of rows) writeOutputText(state, `${row.sql};\n`)
		return
	}
	if (name === ".dump") {
		if (args.length > 1) throw new SqliteCliError("usage: .dump [TABLE]")
		writeDump(db, state, args[0])
		return
	}
	if (name === ".import") {
		if (args.length !== 2) throw new SqliteCliError("usage: .import FILE TABLE")
		await importFile(db, state, args[0], args[1])
		return
	}
	if (name === ".read") {
		if (args.length !== 1) throw new SqliteCliError("usage: .read FILE")
		for (const statement of splitStatements(await readFile(args[0], "utf-8"))) {
			await executeStatement(db, statement, state)
			if (state.stop) break
		}
		return
	}
	if (name === ".quit" || name === ".exit") {
		state.stop = true
		return
	}
	throw new SqliteCliError(`unsupported dot command ${name}`)
}

function applyMode(args, state) {
	if (args.length < 1 || args.length > 2 || !["list", "csv", "json", "line", "column", "tabs", "quote", "insert", "table", "box"].includes(args[0])) {
		throw new SqliteCliError("usage: .mode list|csv|json|line|column|tabs|quote|insert|table|box [TABLE]")
	}
	if (args[0] === "tabs") {
		state.mode = "list"
		state.separator = "\t"
	} else {
		state.mode = args[0]
	}
	if (args[0] === "insert") state.insertTable = args[1] || "table"
}

function writeOutputText(state, text) {
	state.wroteOutput = true
	if (state.outputPath) appendFileSync(state.outputPath, text)
	else process.stdout.write(text)
}

function resetOnceAfterOutput(state) {
	if (state.once && state.wroteOutput) {
		state.outputPath = null
		state.once = false
	}
}

function writeDump(db, state, table) {
	writeOutputText(state, "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n")
	const schemaRows = table
		? db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND (name = ? OR tbl_name = ?) ORDER BY type = 'table' DESC, type, name").all(table, table)
		: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table' DESC, type, name").all()
	for (const row of schemaRows) if (row.sql) writeOutputText(state, `${row.sql};\n`)
	const tables = schemaRows
		.filter((row) => row.type === "table" && (!table || row.name === table))
		.map((row) => row.name)
	for (const name of tables) {
		const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(name)}`).all()
		for (const row of rows) writeOutputText(state, `INSERT INTO ${quoteIdentifier(name)} VALUES(${Object.values(row).map(sqlLiteral).join(",")});\n`)
	}
	writeOutputText(state, "COMMIT;\n")
}

async function importFile(db, state, path, table) {
	const text = await readFile(path, "utf-8")
	const rows = state.mode === "csv" ? parseCsv(text) : text.split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split(state.separator))
	if (rows.length === 0) return
	const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
	if (columns.length === 0) throw new SqliteCliError(`table not found: ${table}`)
	const placeholders = columns.map(() => "?").join(",")
	const insert = db.prepare(`INSERT INTO ${quoteIdentifier(table)} VALUES (${placeholders})`)
	for (const row of rows) insert.run(...columns.map((_, index) => row[index] ?? null))
}

function parseCsv(text) {
	const rows = []
	let row = []
	let field = ""
	let quote = false
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i]
		const next = text[i + 1]
		if (quote) {
			if (char === '"' && next === '"') {
				field += '"'
				i += 1
			} else if (char === '"') quote = false
			else field += char
		} else if (char === '"') quote = true
		else if (char === ",") {
			row.push(field)
			field = ""
		} else if (char === "\n") {
			row.push(field)
			rows.push(row)
			row = []
			field = ""
		} else if (char !== "\r") field += char
	}
	if (quote) throw new SqliteCliError("unterminated quoted CSV field")
	if (field.length > 0 || row.length > 0) {
		row.push(field)
		rows.push(row)
	}
	return rows
}

function quoteIdentifier(value) {
	return `"${String(value).replaceAll('"', '""')}"`
}

function sqlLiteral(value) {
	if (value == null) return "NULL"
	if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL"
	return `'${String(value).replaceAll("'", "''")}'`
}

function isQuery(sql) {
	return /^(select|with|pragma|values|explain)\b/i.test(sql.trim())
}

function columnsFor(db, sql, rows) {
	if (rows.length > 0) return Object.keys(rows[0])
	try {
		return db.prepare(sql).columns?.().map((column) => column.name).filter(Boolean) ?? []
	} catch {
		return []
	}
}

function splitStatements(input) {
	const statements = []
	let current = ""
	let quote = null
	let lineStart = true
	for (let i = 0; i < input.length; i += 1) {
		const char = input[i]
		const next = input[i + 1]
		if (!quote && lineStart && char === ".") {
			const end = input.indexOf("\n", i)
			const line = end === -1 ? input.slice(i) : input.slice(i, end)
			if (current.trim()) statements.push(current)
			statements.push(line)
			current = ""
			i = end === -1 ? input.length : end
			lineStart = true
			continue
		}
		current += char
		if (quote) {
			if (char === quote && next === quote) {
				current += next
				i += 1
			} else if (char === quote) {
				quote = null
			}
		} else if (char === "'" || char === '"' || char === "`") {
			quote = char
		} else if (char === ";") {
			statements.push(current)
			current = ""
		}
		lineStart = char === "\n" || (lineStart && /\s/.test(char))
		if (char !== "\n" && !/\s/.test(char)) lineStart = false
	}
	if (current.trim()) statements.push(current)
	return statements
}

function writeRows(rows, columns, state) {
	if (state.mode === "json") {
		writeOutputText(state, `${JSON.stringify(rows)}\n`)
		return
	}
	if (state.mode === "line") {
		for (const row of rows) {
			for (const column of columns) writeOutputText(state, `${column} = ${formatValue(row[column], state)}\n`)
			writeOutputText(state, "\n")
		}
		return
	}
	if (state.mode === "csv") {
		if (state.headers && columns.length > 0) writeOutputText(state, `${columns.map(csvValue).join(",")}\n`)
		for (const row of rows) writeOutputText(state, `${columns.map((column) => csvValue(row[column], state)).join(",")}\n`)
		return
	}
	if (state.mode === "quote") {
		for (const row of rows) writeOutputText(state, `${columns.map((column) => sqlLiteral(row[column])).join(",")}\n`)
		return
	}
	if (state.mode === "insert") {
		for (const row of rows) writeOutputText(state, `INSERT INTO ${quoteIdentifier(state.insertTable)} VALUES(${columns.map((column) => sqlLiteral(row[column])).join(",")});\n`)
		return
	}
	if (state.mode === "column") {
		writeColumnRows(rows, columns, state)
		return
	}
	if (state.mode === "table" || state.mode === "box") {
		writeTableRows(rows, columns, state)
		return
	}
	if (state.headers && columns.length > 0) writeOutputText(state, `${columns.join(state.separator)}\n`)
	for (const row of rows) writeOutputText(state, `${columns.map((column) => formatValue(row[column], state)).join(state.separator)}\n`)
}

function writeColumnRows(rows, columns, state) {
	const widths = columnWidths(rows, columns, state)
	const line = (values) => values.map((value, index) => String(value).padEnd(widths[columns[index]])).join("  ").trimEnd()
	if (state.headers && columns.length > 0) {
		writeOutputText(state, `${line(columns)}\n`)
		writeOutputText(state, `${line(columns.map((column) => "-".repeat(widths[column])))}\n`)
	}
	for (const row of rows) writeOutputText(state, `${line(columns.map((column) => formatValue(row[column], state)))}\n`)
}

function writeTableRows(rows, columns, state) {
	if (columns.length === 0) return
	const widths = columnWidths(rows, columns, state)
	const border = state.mode === "box" ? boxBorder(columns, widths, "┌", "┬", "┐") : tableBorder(columns, widths)
	const middle = state.mode === "box" ? boxBorder(columns, widths, "├", "┼", "┤") : tableBorder(columns, widths)
	const bottom = state.mode === "box" ? boxBorder(columns, widths, "└", "┴", "┘") : border
	const rowLine = (values) => `${state.mode === "box" ? "│" : "|"} ${columns.map((column, index) => String(values[index]).padEnd(widths[column])).join(state.mode === "box" ? " │ " : " | ")} ${state.mode === "box" ? "│" : "|"}\n`
	writeOutputText(state, `${border}\n`)
	writeOutputText(state, rowLine(columns))
	writeOutputText(state, `${middle}\n`)
	for (const row of rows) writeOutputText(state, rowLine(columns.map((column) => formatValue(row[column], state))))
	writeOutputText(state, `${bottom}\n`)
}

function tableBorder(columns, widths) {
	return `+${columns.map((column) => "-".repeat(widths[column] + 2)).join("+")}+`
}

function boxBorder(columns, widths, left, middle, right) {
	return `${left}${columns.map((column) => "─".repeat(widths[column] + 2)).join(middle)}${right}`
}

function columnWidths(rows, columns, state) {
	const widths = Object.fromEntries(columns.map((column) => [column, String(column).length]))
	for (const row of rows) for (const column of columns) widths[column] = Math.max(widths[column], formatValue(row[column], state).length)
	return widths
}

function csvValue(value, state = { nullValue: "" }) {
	const text = formatValue(value, state)
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function formatValue(value, state = { nullValue: "" }) {
	if (value == null) return state.nullValue
	if (value instanceof Uint8Array) return Buffer.from(value).toString("hex")
	return String(value)
}

async function main() {
	try {
		const config = parseArgs(process.argv.slice(2))
		if (config.version) {
			process.stdout.write(`${VERSION}\n`)
			return 0
		}
		if (config.help) {
			process.stdout.write(usage())
			return 0
		}
		return await run(config)
	} catch (err) {
		process.stderr.write(`pinano sqlite3 fallback: ${err?.message || err}\n`)
		return err?.exitCode ?? 1
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	process.exitCode = await main()
}
