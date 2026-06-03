function closePromise(stream) {
	let onClose
	const promise = new Promise((resolve) => {
		onClose = () => resolve(null)
		stream.once("close", onClose)
	})
	return {
		promise,
		dispose() {
			if (onClose) stream.removeListener("close", onClose)
		},
	}
}

export function waitForDrainOrClose(stream) {
	if (stream.destroyed) return false
	return new Promise((resolve) => {
		const cleanup = (value) => {
			stream.removeListener("drain", onDrain)
			stream.removeListener("close", onClose)
			resolve(value)
		}
		const onDrain = () => cleanup(true)
		const onClose = () => cleanup(false)
		stream.once("drain", onDrain)
		stream.once("close", onClose)
	})
}

async function cancelReader(reader) {
	await reader.cancel().catch(() => {})
}

export async function writeResponseBody(incoming, outgoing, response) {
	if (incoming.method === "HEAD" || !response.body) return

	const reader = response.body.getReader()
	const closed = closePromise(outgoing)
	try {
		for (;;) {
			if (outgoing.destroyed) {
				await cancelReader(reader)
				return
			}
			const chunk = await Promise.race([reader.read(), closed.promise])
			if (!chunk || outgoing.destroyed) {
				await cancelReader(reader)
				return
			}
			const { done, value } = chunk
			if (done) return
			if (!outgoing.write(value) && !await waitForDrainOrClose(outgoing)) {
				await cancelReader(reader)
				return
			}
		}
	} finally {
		closed.dispose()
		reader.releaseLock()
	}
}
