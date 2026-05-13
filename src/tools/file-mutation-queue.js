import { realpathSync } from "node:fs"
import { resolve } from "node:path"

const queues = new Map()

function getKey(filePath) {
	const resolved = resolve(filePath)
	try {
		return realpathSync.native(resolved)
	} catch {
		return resolved
	}
}

/**
 * Serialize file mutations on the same path. Operations targeting different
 * files run concurrently — only same-path writes wait in line.
 *
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withFileMutationQueue(filePath, fn) {
	const key = getKey(filePath)
	const current = queues.get(key) ?? Promise.resolve()
	let release = () => {}
	const next = new Promise((r) => {
		release = r
	})
	const chained = current.then(() => next)
	queues.set(key, chained)
	await current
	try {
		return await fn()
	} finally {
		release()
		if (queues.get(key) === chained) queues.delete(key)
	}
}
