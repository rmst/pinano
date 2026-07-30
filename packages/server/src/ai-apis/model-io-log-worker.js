// Dedicated persistence worker for the model I/O log.

import { runPersistenceWorker } from "../persistence/worker-runtime.js"
import { createModelIoLogStore } from "./model-io-log-store.js"

function closeModelIoResource(resource, trace) {
	const store = resource.store
	try {
		return trace.run("ModelIoLog.close.database", {}, () => store.close())
	} finally {
		// qn's SQLite compatibility layer uses sqlite3_close_v2(), so prepared-statement wrappers must be released before the worker acknowledges close.
		for (const key of Object.keys(store)) delete store[key]
		resource.store = undefined
	}
}

await runPersistenceWorker({
	label: "Model I/O",
	database: "modelIo",
	open(path, trace) {
		const traceRef = { current: trace }
		const store = createModelIoLogStore(path, (operation, stage, task) => traceRef.current.run(`ModelIoLog.${operation}.${stage}`, {}, task))
		return { store, traceRef }
	},
	close: closeModelIoResource,
	execute(resource, operation, payload, trace) {
		resource.traceRef.current = trace
		if (operation === "getRequestLog") return resource.store.getRequestLog(payload.id)
		if (operation === "flush") return null
		const metrics = resource.store.write(operation, payload)
		trace.annotate(metrics)
		return null
	},
})
