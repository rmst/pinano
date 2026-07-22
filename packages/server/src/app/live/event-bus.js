import { randomUUID } from "node:crypto"

const DEFAULT_HISTORY_SIZE = 512

function normalizeCursor(cursor) {
	if (!cursor || typeof cursor !== "object") return undefined
	if (typeof cursor.epoch !== "string" || !cursor.epoch) return undefined
	if (!Number.isSafeInteger(cursor.revision) || cursor.revision < 0) return undefined
	return { epoch: cursor.epoch, revision: cursor.revision }
}

/**
 * In-memory revision log shared by live transports. Revisions identify an ordering within one process epoch; callers must replace stale state when reset is true.
 */
export function createLiveEventBus(options = {}) {
	const epoch = typeof options.epoch === "string" && options.epoch ? options.epoch : randomUUID()
	const historySize = Number.isSafeInteger(options.historySize) ? Math.max(0, options.historySize) : DEFAULT_HISTORY_SIZE
	const history = []
	const listeners = new Set()
	let revision = 0
	let closed = false

	const cursor = () => ({ epoch, revision })
	const publish = (value) => {
		if (closed) return undefined
		const record = { cursor: { epoch, revision: ++revision }, value }
		if (historySize > 0) {
			history.push(record)
			if (history.length > historySize) history.splice(0, history.length - historySize)
		}
		for (const listener of [...listeners]) {
			if (!listener.filter || listener.filter(value)) listener.notify(record)
		}
		return record.cursor
	}
	const replayFrom = (requestedCursor, filter = undefined) => {
		const requested = normalizeCursor(requestedCursor)
		const oldestRevision = history[0]?.cursor.revision ?? revision + 1
		const reset = !requested
			|| requested.epoch !== epoch
			|| requested.revision > revision
			|| requested.revision < oldestRevision - 1
		if (reset) return { reset: true, cursor: cursor(), records: [] }
		return {
			reset: false,
			cursor: cursor(),
			records: history.filter((record) => record.cursor.revision > requested.revision && (!filter || filter(record.value))),
		}
	}
	const subscribe = (notify, options = {}) => {
		if (closed) return { reset: true, cursor: cursor(), records: [], unsubscribe() {} }
		const listener = { notify, filter: options.filter }
		listeners.add(listener)
		const replay = options.cursor ? replayFrom(options.cursor, options.filter) : { reset: false, cursor: cursor(), records: [] }
		if (options.replay !== false && !replay.reset) {
			for (const record of replay.records) notify(record)
		}
		return {
			...replay,
			unsubscribe() {
				listeners.delete(listener)
			},
		}
	}
	return {
		epoch,
		cursor,
		publish,
		replayFrom,
		subscribe,
		close() {
			closed = true
			listeners.clear()
			history.length = 0
		},
		inspect() {
			return { epoch, revision, historySize, retainedEvents: history.length, listenerCount: listeners.size, closed }
		},
	}
}
