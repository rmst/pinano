const runUntraced = (_stage, task) => task()

function safeErrorLabel(value, fallback = undefined) {
	return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value) ? value : fallback
}

function errorSpanArgs(error) {
	return {
		failed: true,
		errorName: error instanceof Error ? safeErrorLabel(error.name, "Error") : typeof error,
		errorCode: typeof error?.code === "number" && Number.isFinite(error.code)
			? error.code
			: safeErrorLabel(error?.code),
	}
}

/**
 * Create a low-overhead tracer for synchronous stages of an operation. Disabled diagnostics bypass span creation entirely.
 * @param {any} diagnostics
 * @param {string} operation
 * @param {Record<string, any>} [args]
 * @returns {(stage: string, task: () => any) => any}
 */
export function syncOperationTracer(diagnostics, operation, args) {
	if (diagnostics?.enabled === false || typeof diagnostics?.span !== "function") return runUntraced
	return (stage, task) => {
		const end = diagnostics.span(`${operation}.${stage}`, args)
		try {
			const result = task()
			end()
			return result
		} catch (error) {
			end(errorSpanArgs(error))
			throw error
		}
	}
}

/**
 * Start a diagnostics span without paying the diagnostics bookkeeping cost when tracing is disabled.
 * @param {any} diagnostics
 * @param {string} name
 * @param {Record<string, any>} [args]
 * @returns {(extraArgs?: Record<string, any>) => void}
 */
export function startOperationSpan(diagnostics, name, args) {
	if (diagnostics?.enabled === false || typeof diagnostics?.span !== "function") return () => {}
	return diagnostics.span(name, args)
}
