export const WORKER_PROTOCOL_VERSION = 1

export function assertWorkerProtocolVersion(version) {
	if (version !== WORKER_PROTOCOL_VERSION) {
		throw new Error(`Unsupported Pinano worker protocol version: ${version ?? "missing"} (expected ${WORKER_PROTOCOL_VERSION})`)
	}
}
