import { lstat, realpath, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

import { PROJECT_DOCUMENTS_RELATIVE_PATH } from "../../../../protocol/src/product.js"

export const PROJECT_DOCUMENT_INDEX_FILENAMES = ["index.html", "index.htm", "index.md"]

export function projectDocumentsDirectory(projectDir) {
	return resolve(projectDir, PROJECT_DOCUMENTS_RELATIVE_PATH)
}

export function staticPreviewRootIsProjectDocuments(rootPath, projectDir) {
	return typeof rootPath === "string"
		&& typeof projectDir === "string"
		&& resolve(rootPath) === projectDocumentsDirectory(projectDir)
}

export function staticPreviewRecordIsProjectDocuments(record) {
	return record?.scopeKind === "static"
		&& staticPreviewRootIsProjectDocuments(record.rootPath, record.projectDir)
}

export async function projectDocumentsIndexPath(projectDir) {
	let projectPath
	try {
		projectPath = await realpath(projectDir)
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return undefined
		throw err
	}
	const rootPath = projectDocumentsDirectory(projectPath)
	try {
		const rootInfo = await lstat(rootPath)
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return undefined
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return undefined
		throw err
	}
	for (const name of PROJECT_DOCUMENT_INDEX_FILENAMES) {
		const path = join(rootPath, name)
		try {
			const info = await stat(path)
			if (info.isFile() && resolve(await realpath(path)) === path) return path
		} catch (err) {
			if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err
		}
	}
	return undefined
}
