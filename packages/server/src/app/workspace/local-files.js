import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

import { pathIsWithin } from "../sandbox/paths.js"

function outsideRootError(path) {
	return Object.assign(new Error(`Checkpoint file is outside its owned filesystem root: ${path}`), { status: 403 })
}

async function localFileOperationPath(filePath, root = undefined, options = {}) {
	const requestedPath = resolve(filePath)
	if (!root) return requestedPath
	if (options.followLeaf === false) {
		const parent = await localFileOperationPath(dirname(requestedPath), root)
		return resolve(parent, basename(requestedPath))
	}
	const requestedRoot = resolve(root)
	if (!pathIsWithin(requestedRoot, requestedPath)) throw outsideRootError(requestedPath)
	const realRoot = resolve(await realpath(requestedRoot))
	let existing = requestedPath
	const suffix = []
	for (;;) {
		try {
			const resolved = resolve(await realpath(existing), ...suffix)
			if (!pathIsWithin(realRoot, resolved)) throw outsideRootError(requestedPath)
			return resolved
		} catch (err) {
			if (err?.code !== "ENOENT") throw err
			let info
			try {
				info = await lstat(existing)
			} catch (lstatError) {
				if (lstatError?.code !== "ENOENT") throw lstatError
			}
			if (info?.isSymbolicLink()) throw outsideRootError(requestedPath)
			if (info) throw err
			const parent = dirname(existing)
			if (parent === existing) throw err
			suffix.unshift(basename(existing))
			existing = parent
		}
	}
}

/** @param {string} filePath @param {{ root?: string }} [options] */
export async function captureLocalWorkspaceFile(filePath, options = {}) {
	const path = resolve(filePath)
	const operationPath = await localFileOperationPath(path, options.root)
	try {
		const info = await stat(operationPath)
		if (!info.isFile()) throw new Error(`Cannot checkpoint non-file path before edit: ${path}`)
		const content = await readFile(operationPath)
		return { path, existed: true, content: content.toString("base64"), size: content.byteLength }
	} catch (err) {
		if (err?.code !== "ENOENT") throw err
		return { path, existed: false, content: null, size: 0 }
	}
}

/** @param {{ path: string, existed: boolean, content: string | null }} snapshot @param {{ root?: string }} [options] */
export async function restoreLocalWorkspaceFile(snapshot, options = {}) {
	const path = resolve(snapshot.path)
	const operationPath = await localFileOperationPath(path, options.root, { followLeaf: snapshot.existed })
	if (snapshot.existed) {
		const content = Buffer.from(snapshot.content ?? "", "base64")
		await mkdir(dirname(operationPath), { recursive: true })
		await writeFile(operationPath, content)
		return { path, existed: true, size: content.byteLength }
	}
	await rm(operationPath, { force: true })
	return { path, existed: false, size: 0 }
}
