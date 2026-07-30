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
	if (incoming.method === "HEAD" || !response.body) return 0

	const reader = response.body.getReader()
	const closed = closePromise(outgoing)
	let bytesWritten = 0
	try {
		for (;;) {
			if (outgoing.destroyed) {
				await cancelReader(reader)
				return bytesWritten
			}
			const chunk = await Promise.race([reader.read(), closed.promise])
			if (!chunk || outgoing.destroyed) {
				await cancelReader(reader)
				return bytesWritten
			}
			const { done, value } = chunk
			if (done) return bytesWritten
			const byteLength = value?.byteLength ?? Buffer.byteLength(String(value ?? ""))
			const accepted = outgoing.write(value)
			bytesWritten += byteLength
			if (!accepted && !await waitForDrainOrClose(outgoing)) {
				await cancelReader(reader)
				return bytesWritten
			}
		}
	} finally {
		closed.dispose()
		reader.releaseLock()
	}
}
