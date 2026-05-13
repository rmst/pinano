// Generic event stream that lets a producer push events while a consumer
// iterates over them with `for await`. The stream resolves a single
// "final result" when an event matching `isComplete` is pushed.

/**
 * @template T, R
 */
export class EventStream {
	constructor(isComplete, extractResult) {
		this.queue = []
		this.waiting = []
		this.done = false
		this.isComplete = isComplete
		this.extractResult = extractResult
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve
		})
	}

	push(event) {
		if (this.done) return

		if (this.isComplete(event)) {
			this.done = true
			this.resolveFinalResult(this.extractResult(event))
		}

		const waiter = this.waiting.shift()
		if (waiter) {
			waiter({ value: event, done: false })
		} else {
			this.queue.push(event)
		}
	}

	end(result) {
		this.done = true
		if (result !== undefined) {
			this.resolveFinalResult(result)
		}
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()
			waiter({ value: undefined, done: true })
		}
	}

	async *[Symbol.asyncIterator]() {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()
			} else if (this.done) {
				return
			} else {
				const result = await new Promise((resolve) => this.waiting.push(resolve))
				if (result.done) return
				yield result.value
			}
		}
	}

	result() {
		return this.finalResultPromise
	}
}

export class AssistantMessageEventStream extends EventStream {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message
				if (event.type === "error") return event.error
				throw new Error("Unexpected event type for final result")
			},
		)
	}
}
