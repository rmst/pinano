// Periodic, aggregate-only model API performance metrics.
//
// Completed requests are combined in memory into five-minute buckets. SQLite is touched only by the periodic flush/maintenance path and shutdown, never once per request. The database deliberately contains no session ids, request ids, URLs, errors, prompts, or model output.

import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { setModelPerformanceRecorder } from "../../ai-apis/model-performance.js"

export const MODEL_API_METRICS_SCHEMA_VERSION = 1
export const MODEL_API_METRICS_BUCKET_MS = 5 * 60 * 1000
export const MODEL_API_METRICS_RETENTION_MS = 120 * 24 * 60 * 60 * 1000

const DEFAULT_FLUSH_INTERVAL_MS = MODEL_API_METRICS_BUCKET_MS
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_PENDING_BUCKETS = 10_000
const LATENCY_HISTOGRAM_UPPER_BOUNDS = Object.freeze([100, 250, 500, 1_000, 2_000, 3_000, 5_000, 8_000, 12_000, 20_000, 30_000, 45_000, 60_000, 90_000, 120_000, 180_000, 300_000, 600_000])

export const MODEL_API_HISTOGRAMS = Object.freeze({
	request_latency_ms: Object.freeze({
		column: "request_latency_histogram_json",
		unit: "milliseconds",
		upperBounds: LATENCY_HISTOGRAM_UPPER_BOUNDS,
	}),
	response_headers_latency_ms: Object.freeze({
		column: "response_headers_latency_histogram_json",
		unit: "milliseconds",
		upperBounds: LATENCY_HISTOGRAM_UPPER_BOUNDS,
	}),
	first_stream_event_latency_ms: Object.freeze({
		column: "first_stream_event_latency_histogram_json",
		unit: "milliseconds",
		upperBounds: LATENCY_HISTOGRAM_UPPER_BOUNDS,
	}),
	first_content_latency_ms: Object.freeze({
		column: "first_content_latency_histogram_json",
		unit: "milliseconds",
		upperBounds: LATENCY_HISTOGRAM_UPPER_BOUNDS,
	}),
	output_tokens_per_second: Object.freeze({
		column: "output_tokens_per_second_histogram_json",
		unit: "tokens_per_second",
		upperBounds: Object.freeze([1, 2, 4, 6, 8, 10, 15, 20, 30, 40, 60, 80, 120, 200, 400]),
	}),
	input_tokens: Object.freeze({
		column: "input_tokens_histogram_json",
		unit: "tokens",
		upperBounds: Object.freeze([0, 32, 64, 128, 256, 512, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000, 1_000_000]),
	}),
	output_tokens: Object.freeze({
		column: "output_tokens_histogram_json",
		unit: "tokens",
		upperBounds: Object.freeze([0, 8, 16, 32, 64, 128, 256, 512, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000]),
	}),
})

const HISTOGRAMS = Object.entries(MODEL_API_HISTOGRAMS).map(([name, definition]) => ({ name, ...definition }))
const SCALAR_COLUMNS = [
	["requestCount", "request_count"],
	["completedCount", "completed_count"],
	["failedCount", "failed_count"],
	["abortedCount", "aborted_count"],
	["usageReportCount", "usage_report_count"],
	["httpAttemptCount", "http_attempt_count"],
	["retryCount", "retry_count"],
	["inputTokensSum", "input_tokens_sum"],
	["cacheReadTokensSum", "cache_read_tokens_sum"],
	["cacheWriteTokensSum", "cache_write_tokens_sum"],
	["outputTokensSum", "output_tokens_sum"],
	["reasoningOutputTokensSum", "reasoning_output_tokens_sum"],
	["requestLatencyMsSum", "request_latency_ms_sum"],
	["responseHeadersLatencyCount", "response_headers_latency_count"],
	["responseHeadersLatencyMsSum", "response_headers_latency_ms_sum"],
	["firstStreamEventLatencyCount", "first_stream_event_latency_count"],
	["firstStreamEventLatencyMsSum", "first_stream_event_latency_ms_sum"],
	["firstContentLatencyCount", "first_content_latency_count"],
	["firstContentLatencyMsSum", "first_content_latency_ms_sum"],
	["generationDurationCount", "generation_duration_count"],
	["generationDurationMsSum", "generation_duration_ms_sum"],
	["outputTokensPerSecondCount", "output_tokens_per_second_count"],
	["outputTokensPerSecondSum", "output_tokens_per_second_sum"],
]
const SCALAR_FIELDS = SCALAR_COLUMNS.map(([field]) => field)

const DB_COLUMNS = [
	"bucket_start_ms",
	"provider",
	"model",
	"transport",
	"reasoning_effort",
	"service_tier",
	...SCALAR_COLUMNS.map(([, column]) => column),
	...HISTOGRAMS.map((definition) => definition.column),
]

/** @param {unknown} value */
function finiteNonNegative(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** @param {unknown} value */
function metricDimension(value, fallback = "unspecified") {
	if (typeof value !== "string" || value.length === 0) return fallback
	return value.length <= 512 ? value : value.slice(0, 512)
}

function emptyHistogram(definition) {
	return Array(definition.upperBounds.length + 1).fill(0)
}

function observe(histogram, definition, value) {
	if (finiteNonNegative(value) === undefined) return
	const index = definition.upperBounds.findIndex((bound) => value <= bound)
	histogram[index === -1 ? histogram.length - 1 : index] += 1
}

function bucketStart(timestamp) {
	return Math.floor(timestamp / MODEL_API_METRICS_BUCKET_MS) * MODEL_API_METRICS_BUCKET_MS
}

function aggregateKey(aggregate) {
	return JSON.stringify([
		aggregate.bucketStartMs,
		aggregate.provider,
		aggregate.model,
		aggregate.transport,
		aggregate.reasoningEffort,
		aggregate.serviceTier,
	])
}

function emptyAggregate({ bucketStartMs, provider, model, transport, reasoningEffort, serviceTier }) {
	const aggregate = {
		bucketStartMs,
		provider,
		model,
		transport,
		reasoningEffort,
		serviceTier,
		histograms: {},
	}
	for (const field of SCALAR_FIELDS) aggregate[field] = 0
	for (const definition of HISTOGRAMS) aggregate.histograms[definition.name] = emptyHistogram(definition)
	return aggregate
}

/** @param {any} target @param {any} source */
function mergeAggregate(target, source) {
	for (const field of SCALAR_FIELDS) target[field] += Number(source[field]) || 0
	for (const definition of HISTOGRAMS) {
		const targetHistogram = target.histograms[definition.name]
		const sourceHistogram = source.histograms[definition.name]
		for (let index = 0; index < targetHistogram.length; index++) {
			targetHistogram[index] += Number(sourceHistogram?.[index]) || 0
		}
	}
	return target
}

function aggregateSample(sample) {
	const dimensions = {
		bucketStartMs: bucketStart(Number(sample.finishedAtMs) || Date.now()),
		provider: metricDimension(sample.provider),
		model: metricDimension(sample.model),
		transport: metricDimension(sample.transport),
		reasoningEffort: metricDimension(sample.reasoningEffort),
		serviceTier: metricDimension(sample.serviceTier, "default"),
	}
	const aggregate = emptyAggregate(dimensions)
	aggregate.requestCount = 1
	if (sample.status === "completed") aggregate.completedCount = 1
	else if (sample.status === "aborted") aggregate.abortedCount = 1
	else aggregate.failedCount = 1
	const attemptCount = Math.max(0, Math.trunc(finiteNonNegative(sample.attemptCount) ?? 0))
	aggregate.httpAttemptCount = attemptCount
	aggregate.retryCount = Math.max(0, attemptCount - 1)

	const requestLatencyMs = finiteNonNegative(sample.requestLatencyMs) ?? 0
	aggregate.requestLatencyMsSum = requestLatencyMs
	observe(aggregate.histograms.request_latency_ms, MODEL_API_HISTOGRAMS.request_latency_ms, requestLatencyMs)

	for (const [sampleField, countField, sumField, histogramName] of [
		["responseHeadersLatencyMs", "responseHeadersLatencyCount", "responseHeadersLatencyMsSum", "response_headers_latency_ms"],
		["firstStreamEventLatencyMs", "firstStreamEventLatencyCount", "firstStreamEventLatencyMsSum", "first_stream_event_latency_ms"],
		["firstContentLatencyMs", "firstContentLatencyCount", "firstContentLatencyMsSum", "first_content_latency_ms"],
	]) {
		const value = finiteNonNegative(sample[sampleField])
		if (value === undefined) continue
		aggregate[countField] = 1
		aggregate[sumField] = value
		observe(aggregate.histograms[histogramName], MODEL_API_HISTOGRAMS[histogramName], value)
	}

	const generationDurationMs = finiteNonNegative(sample.generationDurationMs)
	if (generationDurationMs !== undefined) {
		aggregate.generationDurationCount = 1
		aggregate.generationDurationMsSum = generationDurationMs
	}
	const outputTokensPerSecond = finiteNonNegative(sample.outputTokensPerSecond)
	if (outputTokensPerSecond !== undefined) {
		aggregate.outputTokensPerSecondCount = 1
		aggregate.outputTokensPerSecondSum = outputTokensPerSecond
		observe(aggregate.histograms.output_tokens_per_second, MODEL_API_HISTOGRAMS.output_tokens_per_second, outputTokensPerSecond)
	}

	if (sample.usageReported === true) {
		aggregate.usageReportCount = 1
		for (const [sampleField, sumField] of [
			["inputTokens", "inputTokensSum"],
			["cacheReadTokens", "cacheReadTokensSum"],
			["cacheWriteTokens", "cacheWriteTokensSum"],
			["outputTokens", "outputTokensSum"],
			["reasoningOutputTokens", "reasoningOutputTokensSum"],
		]) aggregate[sumField] = finiteNonNegative(sample[sampleField]) ?? 0
		observe(aggregate.histograms.input_tokens, MODEL_API_HISTOGRAMS.input_tokens, sample.inputTokens)
		observe(aggregate.histograms.output_tokens, MODEL_API_HISTOGRAMS.output_tokens, sample.outputTokens)
	}
	return aggregate
}

function createSchema(raw) {
	raw.exec(`
		CREATE TABLE IF NOT EXISTS model_api_metric_buckets (
			bucket_start_ms INTEGER NOT NULL,
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			transport TEXT NOT NULL,
			reasoning_effort TEXT NOT NULL,
			service_tier TEXT NOT NULL,
			request_count INTEGER NOT NULL,
			completed_count INTEGER NOT NULL,
			failed_count INTEGER NOT NULL,
			aborted_count INTEGER NOT NULL,
			usage_report_count INTEGER NOT NULL,
			http_attempt_count INTEGER NOT NULL,
			retry_count INTEGER NOT NULL,
			input_tokens_sum INTEGER NOT NULL,
			cache_read_tokens_sum INTEGER NOT NULL,
			cache_write_tokens_sum INTEGER NOT NULL,
			output_tokens_sum INTEGER NOT NULL,
			reasoning_output_tokens_sum INTEGER NOT NULL,
			request_latency_ms_sum REAL NOT NULL,
			response_headers_latency_count INTEGER NOT NULL,
			response_headers_latency_ms_sum REAL NOT NULL,
			first_stream_event_latency_count INTEGER NOT NULL,
			first_stream_event_latency_ms_sum REAL NOT NULL,
			first_content_latency_count INTEGER NOT NULL,
			first_content_latency_ms_sum REAL NOT NULL,
			generation_duration_count INTEGER NOT NULL,
			generation_duration_ms_sum REAL NOT NULL,
			output_tokens_per_second_count INTEGER NOT NULL,
			output_tokens_per_second_sum REAL NOT NULL,
			request_latency_histogram_json TEXT NOT NULL,
			response_headers_latency_histogram_json TEXT NOT NULL,
			first_stream_event_latency_histogram_json TEXT NOT NULL,
			first_content_latency_histogram_json TEXT NOT NULL,
			output_tokens_per_second_histogram_json TEXT NOT NULL,
			input_tokens_histogram_json TEXT NOT NULL,
			output_tokens_histogram_json TEXT NOT NULL,
			PRIMARY KEY (bucket_start_ms, provider, model, transport, reasoning_effort, service_tier)
		) WITHOUT ROWID;
		CREATE TABLE IF NOT EXISTS metric_histogram_definitions (
			name TEXT PRIMARY KEY,
			unit TEXT NOT NULL,
			upper_bounds_json TEXT NOT NULL
		) WITHOUT ROWID;
	`)
}

/** @param {string} path */
export function initializeModelApiMetricsDb(path) {
	mkdirSync(dirname(path), { recursive: true })
	const raw = new DatabaseSync(path)
	try {
		raw.exec("PRAGMA busy_timeout = 1000")
		raw.exec("PRAGMA journal_mode = WAL")
		raw.exec("PRAGMA synchronous = NORMAL")
		const version = Number(raw.prepare("PRAGMA user_version").get().user_version ?? 0)
		if (version > MODEL_API_METRICS_SCHEMA_VERSION) {
			throw new Error(`Metrics database schema version ${version} is newer than supported version ${MODEL_API_METRICS_SCHEMA_VERSION}`)
		}
		if (version === 0) {
			raw.exec("BEGIN IMMEDIATE")
			try {
				createSchema(raw)
				raw.exec(`PRAGMA user_version = ${MODEL_API_METRICS_SCHEMA_VERSION}`)
				raw.exec("COMMIT")
			} catch (error) {
				try { raw.exec("ROLLBACK") } catch {}
				throw error
			}
		}
		const insertDefinition = raw.prepare("INSERT OR IGNORE INTO metric_histogram_definitions(name, unit, upper_bounds_json) VALUES (?, ?, ?)")
		raw.exec("BEGIN IMMEDIATE")
		try {
			for (const definition of HISTOGRAMS) {
				insertDefinition.run(definition.name, definition.unit, JSON.stringify(definition.upperBounds))
			}
			raw.exec("COMMIT")
		} catch (error) {
			try { raw.exec("ROLLBACK") } catch {}
			throw error
		}
		return raw
	} catch (error) {
		try { raw.close() } catch {}
		throw error
	}
}

function parsedHistogram(value, definition) {
	try {
		const parsed = JSON.parse(value)
		if (Array.isArray(parsed) && parsed.length === definition.upperBounds.length + 1) {
			return parsed.map((count) => Number(count) || 0)
		}
	} catch {}
	return emptyHistogram(definition)
}

function rowToAggregate(row) {
	const aggregate = emptyAggregate({
		bucketStartMs: Number(row.bucket_start_ms),
		provider: row.provider,
		model: row.model,
		transport: row.transport,
		reasoningEffort: row.reasoning_effort,
		serviceTier: row.service_tier,
	})
	for (const [field, column] of SCALAR_COLUMNS) aggregate[field] = Number(row[column]) || 0
	for (const definition of HISTOGRAMS) {
		aggregate.histograms[definition.name] = parsedHistogram(row[definition.column], definition)
	}
	return aggregate
}

function aggregateValues(aggregate) {
	return [
		aggregate.bucketStartMs,
		aggregate.provider,
		aggregate.model,
		aggregate.transport,
		aggregate.reasoningEffort,
		aggregate.serviceTier,
		...SCALAR_FIELDS.map((field) => aggregate[field]),
		...HISTOGRAMS.map((definition) => JSON.stringify(aggregate.histograms[definition.name])),
	]
}

/** @param {object} options @param {string} options.path */
export function openModelApiMetricsStore({ path }) {
	const raw = initializeModelApiMetricsDb(path)
	const keyWhere = "bucket_start_ms = ? AND provider = ? AND model = ? AND transport = ? AND reasoning_effort = ? AND service_tier = ?"
	const select = raw.prepare(`SELECT * FROM model_api_metric_buckets WHERE ${keyWhere}`)
	const insert = raw.prepare(`INSERT OR REPLACE INTO model_api_metric_buckets(${DB_COLUMNS.join(", ")}) VALUES (${DB_COLUMNS.map(() => "?").join(", ")})`)
	const removeBefore = raw.prepare("DELETE FROM model_api_metric_buckets WHERE bucket_start_ms < ?")

	const keyValues = (aggregate) => [
		aggregate.bucketStartMs,
		aggregate.provider,
		aggregate.model,
		aggregate.transport,
		aggregate.reasoningEffort,
		aggregate.serviceTier,
	]
	const writeOne = (aggregate) => {
		const existing = select.get(...keyValues(aggregate))
		const merged = existing ? mergeAggregate(rowToAggregate(existing), aggregate) : aggregate
		insert.run(...aggregateValues(merged))
	}
	const transaction = (task) => {
		raw.exec("BEGIN IMMEDIATE")
		try {
			const result = task()
			raw.exec("COMMIT")
			return result
		} catch (error) {
			try { raw.exec("ROLLBACK") } catch {}
			throw error
		}
	}

	return {
		raw,
		write(aggregates) {
			if (!aggregates || aggregates.length === 0) return
			transaction(() => {
				for (const aggregate of aggregates) writeOne(aggregate)
			})
		},
		prune(nowMs = Date.now()) {
			const cutoff = bucketStart(nowMs - MODEL_API_METRICS_RETENTION_MS)
			removeBefore.run(cutoff)
		},
		close() {
			try { raw.exec("PRAGMA optimize") } catch {}
			raw.close()
		},
	}
}

/**
 * @param {object} options
 * @param {string} options.path
 * @param {number} [options.flushIntervalMs]
 * @param {any} [options.diagnostics]
 * @param {(options: {path: string}) => any} [options.openStore]
 */
export function createModelApiMetrics(options) {
	const flushIntervalMs = Number.isFinite(options.flushIntervalMs) && options.flushIntervalMs > 0
		? options.flushIntervalMs
		: DEFAULT_FLUSH_INTERVAL_MS
	const openStore = options.openStore ?? openModelApiMetricsStore
	let pending = new Map()
	let store
	let closed = false
	let warned = false
	let droppedSamples = 0
	let writeErrors = 0
	let lastFlushAt
	let lastMaintenanceAt = 0

	const reportError = (operation, error) => {
		writeErrors += 1
		try {
			options.diagnostics?.instant?.("ModelApiMetrics.error", {
				operation,
				error: error instanceof Error ? error.message : String(error),
			})
		} catch {}
		if (warned || process.env.CEREX_TEST === "1") return
		warned = true
		try { console.error(`Cerex model API metrics unavailable after error: ${error?.message ?? error}`) } catch {}
	}
	const ensureStore = () => {
		if (!store) store = openStore({ path: options.path })
		return store
	}
	const restore = (snapshot) => {
		for (const [key, aggregate] of snapshot) {
			const existing = pending.get(key)
			if (existing) mergeAggregate(existing, aggregate)
			else pending.set(key, aggregate)
		}
	}
	const flush = () => {
		if (pending.size > 0) {
			const snapshot = pending
			pending = new Map()
			try {
				ensureStore().write([...snapshot.values()])
				lastFlushAt = Date.now()
			} catch (error) {
				restore(snapshot)
				reportError("flush", error)
				return false
			}
		}
		const now = Date.now()
		if (now - lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS && (store || existsSync(options.path))) {
			try {
				ensureStore().prune(now)
				lastMaintenanceAt = now
			} catch (error) {
				reportError("prune", error)
			}
		}
		return true
	}
	const timer = setInterval(flush, flushIntervalMs)
	timer.unref?.()

	return {
		record(sample) {
			if (closed || !sample) return
			const aggregate = aggregateSample(sample)
			const key = aggregateKey(aggregate)
			const existing = pending.get(key)
			if (existing) {
				mergeAggregate(existing, aggregate)
				return
			}
			if (pending.size >= MAX_PENDING_BUCKETS) {
				droppedSamples += 1
				return
			}
			pending.set(key, aggregate)
		},
		flush,
		status() {
			return {
				path: options.path,
				pendingBucketCount: pending.size,
				droppedSamples,
				writeErrors,
				lastFlushAt,
			}
		},
		close() {
			if (closed) return
			closed = true
			clearInterval(timer)
			flush()
			try { store?.close() } catch (error) { reportError("close", error) }
			store = undefined
		},
	}
}

let defaultMetrics

export function startDefaultModelApiMetrics(options) {
	closeDefaultModelApiMetrics()
	defaultMetrics = createModelApiMetrics(options)
	setModelPerformanceRecorder((sample) => defaultMetrics?.record(sample))
	return defaultMetrics
}

export function closeDefaultModelApiMetrics() {
	setModelPerformanceRecorder(undefined)
	try { defaultMetrics?.close() } catch {}
	defaultMetrics = undefined
}

export function defaultModelApiMetricsStatus() {
	return defaultMetrics?.status()
}
