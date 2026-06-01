import { mkdir, appendFile } from "node:fs/promises"
import { dirname } from "node:path"

const DEFAULT_SLOW_SPAN_MS = 25
const DEFAULT_EVENT_LOOP_LAG_MS = 50
const DEFAULT_EVENT_LOOP_INTERVAL_MS = 100
const DEFAULT_PROBE_INTERVAL_MS = 1000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const RECENT_SPAN_WINDOW_MS = 5000
const MAX_RECORDED_SPANS = 10
const NOOP_END = () => {}

function numberOption(value, fallback, min = 0) {
	const n = Number(value)
	return Number.isFinite(n) && n >= min ? n : fallback
}

function boolOption(value, fallback = false) {
	if (typeof value === "boolean") return value
	if (typeof value !== "string") return fallback
	return ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

function roundMs(value) {
	return Math.round(value * 1000) / 1000
}

function cleanArgs(args) {
	if (!args) return undefined
	const out = {}
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || typeof value === "function") continue
		out[key] = value
	}
	return Object.keys(out).length > 0 ? out : undefined
}

function makeEvent(base, args) {
	const cleaned = cleanArgs(args)
	return cleaned ? { ...base, args: cleaned } : base
}

function readCpuUsage() {
	return typeof process.cpuUsage === "function" ? process.cpuUsage() : { user: 0, system: 0 }
}

function readMemoryUsage() {
	return typeof process.memoryUsage === "function" ? process.memoryUsage() : { rss: 0, heapUsed: 0, heapTotal: 0 }
}

export const disabledServiceDiagnostics = {
	enabled: false,
	path: undefined,
	span: () => NOOP_END,
	instant: () => {},
	setContextProvider: () => {},
	addProbe: () => NOOP_END,
	status: () => ({ enabled: false }),
	close: async () => {},
}

/**
 * @param {object} options
 * @param {boolean} [options.enabled]
 * @param {string} [options.path]
 * @param {number} [options.slowSpanMs]
 * @param {number} [options.eventLoopLagMs]
 * @param {number} [options.eventLoopIntervalMs]
 * @param {number} [options.probeIntervalMs]
 * @param {number} [options.maxBytes]
 * @param {boolean} [options.recordAllSpans]
 * @param {number} [options.pid]
 * @param {number} [options.tid]
 * @param {string} [options.processName]
 */
export function createServiceDiagnostics(options = {}) {
	if (options.enabled !== true || !options.path) return disabledServiceDiagnostics

	const path = options.path
	const slowSpanMs = numberOption(options.slowSpanMs, DEFAULT_SLOW_SPAN_MS)
	const eventLoopLagMs = numberOption(options.eventLoopLagMs, DEFAULT_EVENT_LOOP_LAG_MS)
	const eventLoopIntervalMs = numberOption(options.eventLoopIntervalMs, DEFAULT_EVENT_LOOP_INTERVAL_MS, 1)
	const probeIntervalMs = numberOption(options.probeIntervalMs, DEFAULT_PROBE_INTERVAL_MS, 1)
	const maxBytes = numberOption(options.maxBytes, DEFAULT_MAX_BYTES)
	const recordAllSpans = boolOption(options.recordAllSpans, false)
	const pid = Number.isInteger(options.pid) ? options.pid : process.pid
	const tid = Number.isInteger(options.tid) ? options.tid : 1
	const processName = options.processName || "pinano service"

	let queue = Promise.resolve()
	let bytesWritten = 0
	let droppedEvents = 0
	let writeErrors = 0
	let closed = false
	let maxEventLoopLagMs = 0
	let slowSpanCount = 0
	let probeErrorCount = 0
	let nextSpanId = 1
	let contextProvider = undefined
	let probeTimer = undefined
	let runningProbes = false
	let probeExpected = performance.now() + probeIntervalMs
	let lastCpuUsage = readCpuUsage()
	let lastCpuSampleAt = performance.now()
	const activeSpans = new Map()
	const recentSpans = []

	const write = (event) => {
		if (closed) return
		const line = `${JSON.stringify(event)}\n`
		const lineBytes = Buffer.byteLength(line)
		if (bytesWritten + lineBytes > maxBytes) {
			droppedEvents += 1
			return
		}
		bytesWritten += lineBytes
		queue = queue
			.then(async () => {
				await mkdir(dirname(path), { recursive: true })
				await appendFile(path, line)
			})
			.catch(() => {
				writeErrors += 1
			})
	}

	write(makeEvent({ ph: "M", name: "process_name", pid, tid, ts: 0 }, { name: processName }))

	const spanSummary = (now) => {
		while (recentSpans.length > 0 && now - recentSpans[0].endedAt > RECENT_SPAN_WINDOW_MS) recentSpans.shift()
		const active = [...activeSpans.values()]
			.map((span) => ({
				name: span.name,
				elapsedMs: roundMs(now - span.start),
				...(span.args ? { args: span.args } : {}),
			}))
			.sort((a, b) => b.elapsedMs - a.elapsedMs)
			.slice(0, MAX_RECORDED_SPANS)
		const recent = recentSpans
			.slice(-MAX_RECORDED_SPANS)
			.map((span) => ({
				name: span.name,
				durationMs: roundMs(span.durationMs),
				...(span.args ? { args: span.args } : {}),
			}))
		return {
			activeSpanCount: activeSpans.size,
			...(active.length > 0 ? { activeSpans: active } : {}),
			...(recent.length > 0 ? { recentSpans: recent } : {}),
		}
	}

	const sampleProcess = (now) => {
		const usage = readCpuUsage()
		const elapsedMs = Math.max(1, now - lastCpuSampleAt)
		const userMs = (usage.user - lastCpuUsage.user) / 1000
		const systemMs = (usage.system - lastCpuUsage.system) / 1000
		lastCpuUsage = usage
		lastCpuSampleAt = now
		const memory = readMemoryUsage()
		return {
			cpuUserMs: roundMs(userMs),
			cpuSystemMs: roundMs(systemMs),
			cpuTotalMs: roundMs(userMs + systemMs),
			cpuPercentOneCore: roundMs(((userMs + systemMs) / elapsedMs) * 100),
			rssMb: roundMs(memory.rss / 1024 / 1024),
			heapUsedMb: roundMs(memory.heapUsed / 1024 / 1024),
			heapTotalMb: roundMs(memory.heapTotal / 1024 / 1024),
		}
	}

	let expected = performance.now() + eventLoopIntervalMs
	const lagTimer = setInterval(() => {
		const now = performance.now()
		const lagMs = now - expected
		expected = now + eventLoopIntervalMs
		if (lagMs <= eventLoopLagMs) return
		maxEventLoopLagMs = Math.max(maxEventLoopLagMs, lagMs)
		let context
		try { context = contextProvider?.() } catch {}
		write(makeEvent({
			ph: "i",
			name: "event_loop_lag",
			ts: now * 1000,
			pid,
			tid,
			s: "p",
		}, {
			lagMs: roundMs(lagMs),
			...sampleProcess(now),
			...spanSummary(now),
			...(context ? { context } : {}),
		}))
	}, eventLoopIntervalMs)
	lagTimer.unref?.()

	/** @type {Map<string, () => any | Promise<any>>} */
	const probes = new Map()

	const probeContext = () => {
		try { return contextProvider?.() } catch { return undefined }
	}

	const runProbes = async () => {
		if (runningProbes || closed || probes.size === 0) return
		runningProbes = true
		const timerFiredAt = performance.now()
		const scheduleLagMs = timerFiredAt - probeExpected
		probeExpected = timerFiredAt + probeIntervalMs
		let context
		try {
			for (const [probeName, probe] of probes) {
				const start = performance.now()
				let ok = true
				let result
				let error
				try {
					result = await probe()
				} catch (err) {
					ok = false
					probeErrorCount += 1
					error = /** @type {any} */ (err)?.message ?? String(err)
				}
				const durationMs = performance.now() - start
				context ??= probeContext()
				write(makeEvent({
					ph: "i",
					name: "service_probe",
					ts: start * 1000,
					pid,
					tid,
					s: "p",
				}, {
					probe: probeName,
					ok,
					durationMs: roundMs(durationMs),
					scheduleLagMs: roundMs(scheduleLagMs),
					...(result && typeof result === "object" ? result : {}),
					...(error ? { error } : {}),
					...(context ? { context } : {}),
				}))
			}
		} finally {
			runningProbes = false
		}
	}

	const startProbeTimer = () => {
		if (probeTimer || closed) return
		probeExpected = performance.now() + probeIntervalMs
		probeTimer = setInterval(() => {
			runProbes().catch(() => {
				probeErrorCount += 1
			})
		}, probeIntervalMs)
		probeTimer.unref?.()
	}

	return {
		enabled: true,
		path,

		/**
		 * @param {string} name
		 * @param {Record<string, any>} [args]
		 * @returns {(extraArgs?: Record<string, any>) => void}
		 */
		span(name, args) {
			const id = nextSpanId++
			const start = performance.now()
			const ts = start * 1000
			const spanArgs = cleanArgs(args)
			activeSpans.set(id, { name, args: spanArgs, start })
			let ended = false
			return (extraArgs = undefined) => {
				if (ended) return
				ended = true
				const durationMs = performance.now() - start
				activeSpans.delete(id)
				const mergedArgs = cleanArgs({ ...args, ...extraArgs })
				recentSpans.push({ name, args: mergedArgs, durationMs, endedAt: performance.now() })
				while (recentSpans.length > MAX_RECORDED_SPANS * 4) recentSpans.shift()
				if (!recordAllSpans && durationMs < slowSpanMs) return
				slowSpanCount += 1
				write(makeEvent({
					ph: "X",
					name,
					ts,
					dur: durationMs * 1000,
					pid,
					tid,
				}, {
					...args,
					...extraArgs,
					durationMs: roundMs(durationMs),
				}))
			}
		},

		/**
		 * @param {string} name
		 * @param {Record<string, any>} [args]
		 */
		instant(name, args) {
			write(makeEvent({
				ph: "i",
				name,
				ts: performance.now() * 1000,
				pid,
				tid,
				s: "p",
			}, args))
		},

		/** @param {(() => Record<string, any>) | undefined} provider */
		setContextProvider(provider) {
			contextProvider = typeof provider === "function" ? provider : undefined
		},

		/**
		 * @param {string} name
		 * @param {() => any | Promise<any>} probe
		 * @returns {() => void}
		 */
		addProbe(name, probe) {
			if (typeof probe !== "function") return NOOP_END
			probes.set(name, probe)
			startProbeTimer()
			return () => {
				probes.delete(name)
				if (probes.size === 0 && probeTimer) {
					clearInterval(probeTimer)
					probeTimer = undefined
				}
			}
		},

		status() {
			return {
				enabled: true,
				path,
				slowSpanMs,
				eventLoopLagMs,
				eventLoopIntervalMs,
				probeIntervalMs,
				maxBytes,
				bytesWritten,
				droppedEvents,
				writeErrors,
				maxEventLoopLagMs: roundMs(maxEventLoopLagMs),
				slowSpanCount,
				probeCount: probes.size,
				probeErrorCount,
				activeSpanCount: activeSpans.size,
			}
		},

		async close() {
			if (closed) return
			closed = true
			clearInterval(lagTimer)
			if (probeTimer) clearInterval(probeTimer)
			await queue.catch(() => {})
		},
	}
}
