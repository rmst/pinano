import { LIVE_RESOURCE_PROTOCOL_VERSION } from "../../../../protocol/src/live-resource-protocol.js"

const DEFAULT_MAX_SUBSCRIPTIONS = 512
const DEFAULT_MAX_OPENING_UPDATES = 512
const VALID_ID = /^[A-Za-z0-9_.:-]{1,120}$/
const VALID_RESOURCE = /^[a-z][a-z0-9-]{0,63}$/

function cursorAtOrBefore(cursor, boundary) {
	return cursor?.epoch === boundary?.epoch && cursor.revision <= boundary.revision
}

function positiveLimit(value, fallback) {
	return Number.isSafeInteger(value) ? Math.max(1, value) : fallback
}

/**
 * Connection-level live resource protocol. Resource providers are transport-independent and must subscribe to their change source before awaiting a snapshot.
 */
export function createLiveResourceSession(options) {
	const resources = options.resources ?? {}
	const maxSubscriptions = positiveLimit(options.maxSubscriptions, DEFAULT_MAX_SUBSCRIPTIONS)
	const maxOpeningUpdates = positiveLimit(options.maxOpeningUpdates, DEFAULT_MAX_OPENING_UPDATES)
	const subscriptions = new Map()
	let closed = false

	const send = (message) => {
		if (!closed) options.send(message)
	}
	const error = (id, resource, err) => send({
		type: "error",
		...(id ? { id } : {}),
		...(resource ? { resource } : {}),
		error: err?.message ?? String(err),
		...(Number.isSafeInteger(err?.status) ? { status: err.status } : {}),
	})
	const unsubscribe = (id) => {
		const state = subscriptions.get(id)
		if (!state) return
		subscriptions.delete(id)
		state.generation++
		state.controller.abort()
		state.queued = []
		try { state.opened?.unsubscribe?.() } catch {}
	}
	const subscribe = async (message) => {
		const { id, resource } = message
		if (!VALID_ID.test(id || "")) return error(id, resource, new Error("Invalid subscription id"))
		if (!VALID_RESOURCE.test(resource || "") || !resources[resource]) return error(id, resource, Object.assign(new Error("Unknown live resource"), { status: 404 }))
		if (!subscriptions.has(id) && subscriptions.size >= maxSubscriptions) return error(id, resource, Object.assign(new Error("Too many live subscriptions"), { status: 429 }))
		unsubscribe(id)
		const state = { id, resource, generation: 1, opening: true, queued: [], opened: undefined, controller: new AbortController() }
		const generation = state.generation
		subscriptions.set(id, state)
		const emit = (update) => {
			if (closed || subscriptions.get(id) !== state || generation !== state.generation) return
			const envelope = { type: "update", id, resource, cursor: update.cursor, data: update.data }
			if (state.opening && state.queued.length >= maxOpeningUpdates) {
				unsubscribe(id)
				error(id, resource, Object.assign(new Error("Live resource changed too quickly while its snapshot was loading"), { status: 409 }))
			} else if (state.opening) state.queued.push(envelope)
			else send(envelope)
		}
		try {
			const opened = await resources[resource].open(message.params ?? {}, {
				cursor: message.cursor,
				emit,
				signal: state.controller.signal,
			})
			if (closed || subscriptions.get(id) !== state || generation !== state.generation) {
				opened?.unsubscribe?.()
				return
			}
			state.opened = opened
			const boundary = opened.cursor
			if (opened.resumed) send({ type: "ready", id, resource, cursor: message.cursor ?? boundary, resumed: true })
			else send({ type: "snapshot", id, resource, cursor: boundary, data: opened.snapshot })
			state.opening = false
			const queued = state.queued
			state.queued = []
			for (const update of queued) {
				if (!opened.resumed && cursorAtOrBefore(update.cursor, boundary)) continue
				send(update)
			}
		} catch (err) {
			if (subscriptions.get(id) !== state || generation !== state.generation) return
			unsubscribe(id)
			error(id, resource, err)
		}
	}
	const receive = (value) => {
		if (closed) return
		let message
		try {
			message = typeof value === "string" ? JSON.parse(value) : value
		} catch {
			return error(undefined, undefined, new Error("Invalid JSON message"))
		}
		if (!message || typeof message !== "object" || Array.isArray(message)) return error(undefined, undefined, new Error("Invalid live protocol message"))
		if (message.type === "subscribe") return void subscribe(message)
		if (message.type === "unsubscribe") return unsubscribe(message.id)
		if (message.type === "refresh") {
			const state = subscriptions.get(message.id)
			if (!state?.opened?.refresh) return
			Promise.resolve(state.opened.refresh()).catch((err) => error(state.id, state.resource, err))
			return
		}
		error(message.id, message.resource, new Error("Unsupported live protocol message"))
	}
	const close = () => {
		if (closed) return
		for (const id of [...subscriptions.keys()]) unsubscribe(id)
		closed = true
	}

	send({ type: "hello", protocol: LIVE_RESOURCE_PROTOCOL_VERSION })
	return { receive, close, subscriptionCount: () => subscriptions.size }
}
