import { resolve } from "node:path"

import { staticPreviewRootIsProjectDocuments } from "../project/documents.js"
import {
	PREVIEW_ROOT_KIND_SOURCE,
	PREVIEW_ROOT_KIND_STATIC,
	STATIC_PREVIEW_FILE_SUFFIX,
	STATIC_PREVIEW_NAME,
	staticPreviewDefinition,
} from "./manifest.js"

export function isStaticPreviewDefinition(definition) {
	return definition?.source?.kind === "static-directory"
}

export function processPreviewDefinitions(definitions) {
	return definitions.filter((definition) => !isStaticPreviewDefinition(definition))
}

export function staticPreviewDefinitions(definitions) {
	return definitions.filter(isStaticPreviewDefinition)
}

export function projectStaticPreviewDefinitions(manifest) {
	return staticPreviewDefinitions([
		...Object.values(manifest?.previews ?? {}),
		manifest?.documentPreview,
	].filter(Boolean))
}

export async function staticPreviewDefinitionForRecord(workspace, record, name = undefined, options = {}) {
	if (!record?.projectDir) return undefined
	if (record.scopeKind === PREVIEW_ROOT_KIND_SOURCE) {
		if (!record.rootPath?.endsWith(STATIC_PREVIEW_FILE_SUFFIX)) return undefined
		let definition
		try {
			definition = (await workspace.previews.resolveSource(record.rootPath, { projectDir: record.projectDir })).definition
		} catch (err) {
			if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return undefined
			if (options.ignoreInvalidSource === true) return undefined
			throw err
		}
		return !name || definition.name === name ? definition : undefined
	}
	if (record.scopeKind !== PREVIEW_ROOT_KIND_STATIC) return undefined
	if (staticPreviewRootIsProjectDocuments(record.rootPath, record.projectDir)) {
		return !name || name === STATIC_PREVIEW_NAME ? staticPreviewDefinition(record.rootPath) : undefined
	}
	const definitions = projectStaticPreviewDefinitions(await workspace.previews.projectManifest(record.projectDir))
	return definitions.find((definition) =>
		(!name || definition.name === name) && resolve(definition.source.path) === resolve(record.rootPath))
}
