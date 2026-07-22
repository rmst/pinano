function abortError() {
	return new Error("Operation aborted")
}

/** Fair shared/exclusive gate for nested tool calls. Parallel-capable tools may overlap, while a sequential tool runs exclusively with respect to every other nested call. */
export class ToolDispatchGate {
	constructor() {
		this.activeReaders = 0
		this.activeWriter = false
		this.queue = []
	}

	acquire(exclusive, signal) {
		if (signal?.aborted) return Promise.reject(abortError())
		return new Promise((resolve, reject) => {
			const ticket = {
				exclusive,
				resolve,
				reject,
				signal,
				abort: undefined,
			}
			ticket.abort = () => {
				const index = this.queue.indexOf(ticket)
				if (index === -1) return
				this.queue.splice(index, 1)
				reject(abortError())
				this.drain()
			}
			signal?.addEventListener("abort", ticket.abort, { once: true })
			this.queue.push(ticket)
			this.drain()
		})
	}

	grant(ticket) {
		ticket.signal?.removeEventListener("abort", ticket.abort)
		if (ticket.exclusive) this.activeWriter = true
		else this.activeReaders++
		let released = false
		ticket.resolve(() => {
			if (released) return
			released = true
			if (ticket.exclusive) this.activeWriter = false
			else this.activeReaders--
			this.drain()
		})
	}

	drain() {
		if (this.activeWriter || this.queue.length === 0) return
		if (this.activeReaders > 0) {
			while (this.queue[0] && !this.queue[0].exclusive) this.grant(this.queue.shift())
			return
		}
		if (this.queue[0].exclusive) {
			this.grant(this.queue.shift())
			return
		}
		while (this.queue[0] && !this.queue[0].exclusive) this.grant(this.queue.shift())
	}
}
