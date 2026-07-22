import { createLiveEventBus } from "./event-bus.js"

/**
 * Process-wide live event source. The hub owns revision history and reports listener changes so service idle accounting stays transport-independent.
 */
export function createLiveEventHub(onActivity = () => {}, options = {}) {
	const bus = createLiveEventBus(options.liveBus)
	return {
		cursor: bus.cursor,
		inspect() {
			const { listenerCount, ...state } = bus.inspect()
			return { ...state, subscriptionCount: listenerCount }
		},
		send(event) {
			const cursor = bus.publish(event)
			onActivity()
			return cursor
		},
		subscribe(notify, subscribeOptions = {}) {
			const subscription = bus.subscribe(notify, subscribeOptions)
			let active = true
			onActivity()
			return {
				...subscription,
				unsubscribe() {
					if (!active) return
					active = false
					subscription.unsubscribe()
					onActivity()
				},
			}
		},
		subscriptionCount() {
			return bus.inspect().listenerCount
		},
		closeAll() {
			bus.close()
			onActivity()
		},
	}
}
