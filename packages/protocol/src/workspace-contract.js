import { defineContract } from "./contract.js"

export const WORKSPACE_CONTRACT_VERSION = 1
export const WORKSPACE_CONTRACT_ROUTE = "/workspace/contract"
export const WORKSPACE_FILES_ROUTE = "/workspace/files"
export const WORKSPACE_DIRECTORY_RESOURCE = "workspace-directory"
export const WORKSPACE_INTERNAL_HEADER_PREFIX = "x-cerex-workspace-"

const PROJECT_ADD_INPUT_FIELDS = new Set(["name", "remoteUrl", "relativePath", "authToken"])
const PROJECT_DISCOVERY_STATS_FIELDS = new Set(["visitedDirectories", "skippedDirectories", "maxDirectories", "maxProjects", "maxDepth"])

function assertRecord(value, label = "value") {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
}

function assertPreviewManifestResult(value) {
	assertRecord(value, "result")
	assertString(value.directory, "result.directory")
	if (typeof value.exists !== "boolean") throw new TypeError("result.exists must be a boolean")
	assertRecord(value.previews, "result.previews")
	for (const [name, definition] of Object.entries(value.previews)) {
		assertPreviewDefinition(definition, `result.previews.${name}`)
		if (definition.name !== name) throw new TypeError(`result.previews.${name}.name must match its key`)
	}
	if (value.documentPreview !== undefined && value.documentPreview !== null) assertPreviewDefinition(value.documentPreview, "result.documentPreview")
}

function assertPreviewDefinition(value, label) {
	assertRecord(value, label)
	assertString(value.name, `${label}.name`)
	assertOptionalString(value.command, `${label}.command`)
	assertOptionalString(value.description, `${label}.description`)
	assertOptionalString(value.entryPath, `${label}.entryPath`)
	assertOptionalString(value.healthPath, `${label}.healthPath`)
	assertRecord(value.source, `${label}.source`)
	assertString(value.source.kind, `${label}.source.kind`)
	assertString(value.source.path, `${label}.source.path`)
	assertOptionalString(value.source.configPath, `${label}.source.configPath`)
	assertOptionalString(value.source.documentPath, `${label}.source.documentPath`)
	if (value.source.kind === "preview-js") {
		assertString(value.command, `${label}.command`)
		assertString(value.healthPath, `${label}.healthPath`)
		assertNonNegativeInteger(value.source.size, `${label}.source.size`)
		assertNonNegativeInteger(value.source.mtimeMs, `${label}.source.mtimeMs`)
	} else if (value.source.kind !== "static-directory") {
		throw new TypeError(`${label}.source.kind is not supported`)
	}
}

function assertResolvedPreviewSourceResult(value) {
	assertRecord(value, "result")
	assertString(value.path, "result.path")
	assertPreviewDefinition(value.definition, "result.definition")
}

function assertResolvedStaticFileResult(value) {
	assertRecord(value, "result")
	assertString(value.path, "result.path")
	assertNonNegativeInteger(value.size, "result.size")
}

function assertPreviewSourceResult(value) {
	assertRecord(value, "result")
	assertString(value.path, "result.path")
	assertNonNegativeInteger(value.size, "result.size")
	if (value.tooLarge === true) {
		if (value.text !== undefined) throw new TypeError("result.text is not supported when result.tooLarge is true")
		return
	}
	if (value.tooLarge !== undefined) throw new TypeError("result.tooLarge must be true when present")
	if (typeof value.text !== "string") throw new TypeError("result.text must be a string")
}

function assertNonNegativeInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`)
}

function assertPositiveInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
}

function assertProjectRootParams(value) {
	assertRecord(value, "params")
	assertString(value.baseRoot, "params.baseRoot")
	assertOptionalString(value.requestedRoot, "params.requestedRoot")
}

function assertProjectDiscoverParams(value) {
	assertRecord(value, "params")
	assertString(value.root, "params.root")
}

function assertProjectAddParams(value) {
	assertRecord(value, "params")
	assertString(value.root, "params.root")
	assertRecord(value.input, "params.input")
	for (const field of PROJECT_ADD_INPUT_FIELDS) assertOptionalString(value.input[field], `params.input.${field}`)
}

function assertProjectEntry(value, label) {
	assertRecord(value, label)
	for (const field of ["path", "relativePath", "label", "title", "directoryName"]) assertString(value[field], `${label}.${field}`)
	for (const field of ["name", "remote", "lastCommitAt"]) assertOptionalString(value[field], `${label}.${field}`)
}

function assertProjectDiscoveryResult(value) {
	assertRecord(value, "result")
	assertString(value.root, "result.root")
	assertString(value.rootLabel, "result.rootLabel")
	if (!Array.isArray(value.projects)) throw new TypeError("result.projects must be an array")
	for (const [index, project] of value.projects.entries()) assertProjectEntry(project, `result.projects[${index}]`)
	if (typeof value.truncated !== "boolean") throw new TypeError("result.truncated must be a boolean")
	assertRecord(value.stats, "result.stats")
	for (const field of PROJECT_DISCOVERY_STATS_FIELDS) assertNonNegativeInteger(value.stats[field], `result.stats.${field}`)
}

function assertProjectAddResult(value) {
	assertRecord(value, "result")
	if (value.ok !== true) throw new TypeError("result.ok must be true")
	assertString(value.relativePath, "result.relativePath")
	assertProjectEntry(value.project, "result.project")
}

function assertProjectDirParams(value) {
	assertRecord(value, "params")
	assertString(value.projectDir, "params.projectDir")
}

function assertPreviewSourceParams(value) {
	assertRecord(value, "params")
	assertString(value.path, "params.path")
	assertOptionalString(value.projectDir, "params.projectDir")
}

function assertPreviewReadSourceParams(value) {
	assertRecord(value, "params")
	assertString(value.path, "params.path")
	assertPositiveInteger(value.maxBytes, "params.maxBytes")
}

function assertPreviewLogParams(value) {
	assertRecord(value, "params")
	assertString(value.projectDir, "params.projectDir")
	assertString(value.name, "params.name")
	assertPositiveInteger(value.maxBytes, "params.maxBytes")
}

function assertWorktreeRecords(value) {
	if (!Array.isArray(value)) throw new TypeError("params.records must be an array")
	for (const [index, record] of value.entries()) {
		assertRecord(record, `params.records[${index}]`)
		assertString(record.path, `params.records[${index}].path`)
	}
}

function assertWorktreePathParams(value) {
	assertRecord(value, "params")
	assertString(value.path, "params.path")
}

function assertWorktreeStatusesParams(value) {
	assertRecord(value, "params")
	assertWorktreeRecords(value.records)
	if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1)) throw new TypeError("params.limit must be a positive integer")
}

function assertWorktreeCleanupParams(value) {
	assertRecord(value, "params")
	assertWorktreeRecords(value.records)
}

function assertWorktreeCloseParams(value) {
	assertRecord(value, "params")
	assertWorktreeRecords(value.records)
	assertRecord(value.payload, "params.payload")
	if (value.workerContext !== undefined) assertRecord(value.workerContext, "params.workerContext")
}

function assertArrayResult(value) {
	if (!Array.isArray(value)) throw new TypeError("result must be an array")
}

function assertNullableRecord(value) {
	if (value !== null) assertRecord(value, "result")
}

function assertString(value, label) {
	if (typeof value !== "string" || !value) throw new TypeError(`${label} must be a non-empty string`)
}

function assertOptionalString(value, label) {
	if (value !== undefined && value !== null && typeof value !== "string") throw new TypeError(`${label} must be a string`)
}

function assertPathParams(value) {
	assertRecord(value, "params")
	assertString(value.path, "params.path")
}

function assertCwdParams(value) {
	assertRecord(value, "params")
	assertString(value.cwd, "params.cwd")
	assertOptionalString(value.label, "params.label")
}

function assertContextFiles(value) {
	if (!Array.isArray(value)) throw new TypeError("result must be an array")
	for (const [index, file] of value.entries()) {
		assertRecord(file, `result[${index}]`)
		assertString(file.path, `result[${index}].path`)
		assertString(file.identityPath, `result[${index}].identityPath`)
		if (typeof file.content !== "string") throw new TypeError(`result[${index}].content must be a string`)
	}
}

function assertContextPathParams(value) {
	assertCwdParams(value)
	assertString(value.path, "params.path")
	if (value.requireFile !== undefined && typeof value.requireFile !== "boolean") throw new TypeError("params.requireFile must be a boolean")
}

function assertProjectSkillPathParams(value) {
	assertCwdParams(value)
	assertString(value.path, "params.path")
}

function assertProjectSkills(value) {
	assertRecord(value, "result")
	if (!Array.isArray(value.skills)) throw new TypeError("result.skills must be an array")
	for (const [index, skill] of value.skills.entries()) {
		const label = `result.skills[${index}]`
		assertRecord(skill, label)
		for (const field of ["name", "path", "dir", "root"]) assertString(skill[field], `${label}.${field}`)
		if (typeof skill.description !== "string") throw new TypeError(`${label}.description must be a string`)
		if (skill.scope !== "repo") throw new TypeError(`${label}.scope must be repo`)
	}
	if (!Array.isArray(value.errors)) throw new TypeError("result.errors must be an array")
	for (const [index, error] of value.errors.entries()) {
		const label = `result.errors[${index}]`
		assertRecord(error, label)
		assertString(error.path, `${label}.path`)
		assertString(error.message, `${label}.message`)
	}
	if (!Array.isArray(value.roots)) throw new TypeError("result.roots must be an array")
	for (const [index, root] of value.roots.entries()) {
		const label = `result.roots[${index}]`
		assertRecord(root, label)
		assertString(root.path, `${label}.path`)
		if (root.scope !== "repo") throw new TypeError(`${label}.scope must be repo`)
	}
}

function assertProjectNameParams(value) {
	assertCwdParams(value)
	if (typeof value.name !== "string") throw new TypeError("params.name must be a string")
}

function assertSourceControlParams(value) {
	assertRecord(value, "params")
	assertOptionalString(value.path, "params.path")
	assertOptionalString(value.fallbackCwd, "params.fallbackCwd")
	assertOptionalString(value.file, "params.file")
	assertOptionalString(value.area, "params.area")
	assertOptionalString(value.comparison, "params.comparison")
	assertOptionalString(value.base, "params.base")
	assertOptionalString(value.hash, "params.hash")
	assertOptionalString(value.message, "params.message")
	assertOptionalString(value.action, "params.action")
	for (const field of ["offset", "limit"]) {
		if (value[field] !== undefined && typeof value[field] !== "number" && typeof value[field] !== "string") {
			throw new TypeError(`params.${field} must be a number or string`)
		}
	}
}

function assertHostDescription(value) {
	assertRecord(value, "result")
	if (value.root !== null) assertString(value.root, "result.root")
	if (value.configuredRoot !== null) assertString(value.configuredRoot, "result.configuredRoot")
}

function assertStringResult(value) {
	assertString(value, "result")
}

function assertTextResult(value) {
	if (typeof value !== "string") throw new TypeError("result must be a string")
}

function assertBooleanResult(value) {
	if (typeof value !== "boolean") throw new TypeError("result must be a boolean")
}

function assertFileCapture(value) {
	assertRecord(value, "result")
	assertString(value.path, "result.path")
	if (typeof value.existed !== "boolean") throw new TypeError("result.existed must be a boolean")
	if (!Number.isSafeInteger(value.size) || value.size < 0) throw new TypeError("result.size must be a non-negative integer")
	if (value.existed && typeof value.content !== "string") throw new TypeError("result.content must contain base64 file data")
	if (!value.existed && value.content !== null) throw new TypeError("result.content must be null for a missing file")
}

function assertFileRestoreParams(value) {
	assertRecord(value, "params")
	assertString(value.path, "params.path")
	if (typeof value.existed !== "boolean") throw new TypeError("params.existed must be a boolean")
	if (value.existed && typeof value.content !== "string") throw new TypeError("params.content must contain base64 file data")
	if (!value.existed && value.content !== null) throw new TypeError("params.content must be null when deleting a created file")
	if (value.size !== undefined && (!Number.isSafeInteger(value.size) || value.size < 0)) throw new TypeError("params.size must be a non-negative integer")
}

function assertFileRestoreResult(value) {
	assertRecord(value, "result")
	assertString(value.path, "result.path")
	if (typeof value.existed !== "boolean") throw new TypeError("result.existed must be a boolean")
	if (!Number.isSafeInteger(value.size) || value.size < 0) throw new TypeError("result.size must be a non-negative integer")
}

function assertEmptyParams(value) {
	assertRecord(value, "params")
}

export const workspaceContract = defineContract({
	name: "workspace",
	version: WORKSPACE_CONTRACT_VERSION,
	operations: {
		"host.describe": { params: assertEmptyParams, result: assertHostDescription },
		"path.resolveDirectory": { params: assertCwdParams, result: assertStringResult },
		"path.normalizeUserCwd": { params: assertCwdParams, result: assertStringResult },
		"path.normalizeStoredCwd": { params: assertCwdParams, result: assertStringResult },
		"path.allowsStoredCwd": { params: assertCwdParams, result: assertBooleanResult },
		"context.loadProject": { params: assertCwdParams, result: assertContextFiles },
		"context.loadForPath": { params: assertContextPathParams, result: assertContextFiles },
		"context.loadProjectSkills": { params: assertCwdParams, result: assertProjectSkills },
		"context.readProjectSkill": { params: assertProjectSkillPathParams, result: assertTextResult },
		"project.info": { params: assertCwdParams, result: assertRecord },
		"project.setName": { params: assertProjectNameParams, result: assertRecord },
		"project.resolveRoot": { params: assertProjectRootParams, result: assertStringResult },
		"project.discover": { params: assertProjectDiscoverParams, result: assertProjectDiscoveryResult },
		"project.add": { params: assertProjectAddParams, result: assertProjectAddResult },
		"preview.projectManifest": { params: assertProjectDirParams, result: assertPreviewManifestResult },
		"preview.ensureProject": { params: assertProjectDirParams, result: assertPreviewManifestResult },
		"preview.resolveSource": { params: assertPreviewSourceParams, result: assertResolvedPreviewSourceResult },
		"preview.resolveStaticFile": { params: assertPreviewSourceParams, result: assertResolvedStaticFileResult },
		"preview.readSource": { params: assertPreviewReadSourceParams, result: assertPreviewSourceResult },
		"preview.readProjectLog": { params: assertPreviewLogParams, result: assertTextResult },
		"checkpoint.captureFile": { params: assertPathParams, result: assertFileCapture },
		"checkpoint.restoreFile": { params: assertFileRestoreParams, result: assertFileRestoreResult },
		"sourceControl.repoInfo": { params: assertSourceControlParams, result: assertRecord },
		"sourceControl.snapshot": { params: assertSourceControlParams, result: assertRecord },
		"sourceControl.commits": { params: assertSourceControlParams, result: assertRecord },
		"sourceControl.commit": { params: assertSourceControlParams, result: assertRecord },
		"sourceControl.change": { params: assertSourceControlParams, result: assertRecord },
		"sourceControl.discard": { params: assertSourceControlParams, result: assertRecord },
		"sourceControl.stage": { params: assertSourceControlParams, result: assertRecord },
		"sourceControl.unstage": { params: assertSourceControlParams, result: assertRecord },
		"sourceControl.createCommit": { params: assertSourceControlParams, result: assertRecord },
		"sourceControl.sync": { params: assertSourceControlParams, result: assertRecord },
		"worktree.isLinked": { params: assertWorktreePathParams, result: assertBooleanResult },
		"worktree.statuses": { params: assertWorktreeStatusesParams, result: assertArrayResult },
		"worktree.cleanup": { params: assertWorktreeCleanupParams, result: assertArrayResult },
		"worktree.close": { params: assertWorktreeCloseParams, result: assertNullableRecord },
	},
})
