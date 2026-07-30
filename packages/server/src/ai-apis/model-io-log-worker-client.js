// Ordered, non-blocking client for the model I/O persistence worker.

import { fileURLToPath } from "node:url"

import { OrderedWorkerClient } from "../persistence/worker-client.js"

const worker = new OrderedWorkerClient({
	workerPath: fileURLToPath(new URL("./model-io-log-worker.js", import.meta.url)),
	label: "ModelIoLog",
	diagnosticTid: 2,
	replayAfterFailure: true,
	warn: (error) => console.error(`Cerex model I/O database unavailable after error: ${error?.message ?? error}`),
})

export function setModelIoLogWorkerDiagnostics(value) {
	worker.setDiagnostics(value)
}

export function enqueueModelIoLogWrite(path, operation, payload, meta = {}) {
	return worker.enqueue(path, operation, payload, meta)
}

export function requestModelIoLog(path, command, payload = {}, meta = {}) {
	return worker.request(path, command, payload, meta)
}

export async function flushModelIoLogWorker(path) {
	const status = worker.status()
	if (status.state === "idle" && status.queuedNotifications === 0 && status.pendingRequests === 0) return
	await worker.request(path, "flush")
}

export function closeModelIoLogWorker() {
	return worker.close()
}

export function modelIoLogWorkerStatus() {
	const status = worker.status()
	return {
		state: status.state,
		queuedWrites: status.queuedNotifications,
		pendingRequests: status.pendingRequests,
		maxQueuedWrites: status.maxQueuedNotifications,
		writeErrors: status.failedNotifications,
		workerRestarts: status.workerRestarts,
		...(status.activeOperation ? { activeOperation: status.activeOperation } : {}),
		...(status.lastError ? { lastError: status.lastError } : {}),
	}
}

export function resetModelIoLogWorkerStatus() {
	worker.resetStatus()
}
