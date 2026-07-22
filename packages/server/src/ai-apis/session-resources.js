const cleanupHandlers = new Set()

export function registerModelSessionResourceCleanup(handler) {
	cleanupHandlers.add(handler)
	return () => cleanupHandlers.delete(handler)
}

export function closeModelSessionResources(sessionId = undefined) {
	for (const handler of cleanupHandlers) {
		try {
			handler(sessionId)
		} catch {}
	}
}
