import { createContractDispatcher, createDirectContractPeer } from "../../../../protocol/src/contract.js"
import { workspaceContract } from "../../../../protocol/src/workspace-contract.js"
import { watch } from "node:fs"
import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { loadContextFilesForPath, loadProjectContextFiles } from "../context/files.js"
import { loadSkillsForCwd, projectSkillRoots } from "../context/skills.js"
import { dataRoot } from "../paths.js"
import { projectDocumentsDirectory, projectDocumentsIndexPath } from "../project/documents.js"
import { ensureProjectIdentityForCwd, projectIdentityForCwd, projectInfoForCwd, setProjectNameForCwd } from "../project/labels.js"
import { PREVIEW_FILE_SUFFIX, ensureProjectPreviewDirectory, previewFileDefinitionFromPath, projectPreviewDirectory, projectPreviewLogPath, readProjectPreviewDefinitions, staticPreviewDefinition } from "../preview/manifest.js"
import { previewDefinitionForSource, previewEntryPathForSource } from "../preview/source-mapping.js"
import { createWorkspaceRootPolicy } from "../sandbox/workspace-root-policy.js"
import { pathIsWithin } from "../sandbox/paths.js"
import {
	sourceControlChange,
	sourceControlCommit,
	sourceControlCommits,
	sourceControlCreateCommit,
	sourceControlDiscardChange,
	sourceControlRepoInfo,
	sourceControlSnapshot,
	sourceControlStage,
	sourceControlSync,
	sourceControlUnstage,
} from "../source-control/repository.js"
import { closeGitWorktreeRecords, cleanupGitWorktreeRecords, gitWorktreeLocation, gitWorktreeStatusesFromRecords, isLinkedGitWorktree } from "../source-control/worktree-events.js"
import { ToolExecutorRuntime } from "../workers/tool/executor-runtime.js"
import { createWorkspaceClient } from "./client.js"
import { captureLocalWorkspaceFile, restoreLocalWorkspaceFile } from "./local-files.js"
import { createLocalPreviewTransport } from "./local-preview-transport.js"

/**
 * Create the trusted in-process workspace host. Its dispatcher is transport-neutral; the default client uses direct calls and performs no serialization or IPC.
 * @param {{ workspaceRoot?: string, workspacePolicy?: any, createToolExecutor?: (options: any) => any, createPreviewExecutor?: (options: any) => any, createProjectWorkspace?: (options: any) => Promise<any>, environmentRegistry?: () => any, getSettings?: () => any, previewAccessToken?: string }} [options]
 */
export async function createLocalWorkspaceHost(options = {}) {
	const policy = options.workspacePolicy ?? await createWorkspaceRootPolicy(options.workspaceRoot)
	const description = Object.freeze({
		root: policy?.root ?? null,
		configuredRoot: policy?.configuredRoot ?? null,
	})
	const sourceControlOptions = ({ workspaceRoot: _workspaceRoot, ...params }) => ({
		...params,
		workspaceRoot: policy?.root ?? "/",
	})
	const localDirectoryPath = async (cwd, label) => {
		const path = resolve(cwd)
		let real
		try {
			real = resolve(await realpath(path))
		} catch (err) {
			if (err?.code === "ENOENT") throw Object.assign(new Error(`${label} does not exist: ${path}`), { status: 400, code: "ENOENT" })
			throw err
		}
		const info = await stat(real)
		if (!info.isDirectory()) throw Object.assign(new Error(`${label} must be a directory: ${path}`), { status: 400 })
		return real
	}
	const normalizeUserCwd = (cwd, label) => policy ? policy.normalizeUserCwd(cwd, label) : cwd
	const normalizeStoredCwd = (cwd, label) => policy ? policy.normalizeStoredCwd(cwd, label) : cwd
	const allowContextPath = (path) => !policy || pathIsWithin(policy.root, path)
	const allowedFilePath = async (filePath, label, options = {}) => {
		const requestedPath = resolve(filePath)
		if (options.followLeaf === false) {
			const parent = await allowedFilePath(dirname(requestedPath), label)
			return resolve(parent, basename(requestedPath))
		}
		let existing = requestedPath
		const suffix = []
		for (;;) {
			try {
				const real = await realpath(existing)
				const info = await stat(real)
				if (policy) await policy.normalizeStoredCwd(info.isDirectory() ? real : dirname(real), label)
				return resolve(real, ...suffix)
			} catch (err) {
				if (err?.code !== "ENOENT") throw err
				let existingInfo
				try {
					existingInfo = await lstat(existing)
				} catch (lstatError) {
					if (lstatError?.code !== "ENOENT") throw lstatError
				}
				if (existingInfo?.isSymbolicLink()) {
					throw Object.assign(new Error(`${label} resolves through a dangling symbolic link: ${requestedPath}`), { status: 400, code: "ENOENT" })
				}
				if (existingInfo) throw err
				const parent = dirname(existing)
				if (parent === existing) throw err
				suffix.unshift(basename(existing))
				existing = parent
			}
		}
	}
	const allowedWorktreeRecords = async (records) => {
		if (!policy) return records
		return Promise.all(records.map(async (record) => ({
			...record,
			path: await allowedFilePath(record.path, "worktree path"),
			...(record.repositoryRoot ? { repositoryRoot: await allowedFilePath(record.repositoryRoot, "worktree repository root") } : {}),
		})))
	}
	const projectManifest = async (projectDir) => {
		const root = await normalizeStoredCwd(projectDir, "preview project directory")
		const directory = projectPreviewDirectory(root)
		const manifest = await readProjectPreviewDefinitions(root)
		let exists = false
		try {
			exists = (await stat(directory)).isDirectory()
		} catch (err) {
			if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err
		}
		const documentPath = await projectDocumentsIndexPath(root)
		const documentPreview = documentPath
			? staticPreviewDefinition(projectDocumentsDirectory(root), { documentPath })
			: null
		return { directory, exists, previews: manifest.previews, documentPreview }
	}
	const resolvedPreviewSource = async (path, projectDir = undefined) => {
		const sourcePath = await allowedFilePath(path, "preview source file")
		const root = await normalizeStoredCwd(projectDir, "preview project directory")
		const manifest = await readProjectPreviewDefinitions(root)
		const definitions = Object.values(manifest.previews)
		let definition
		let configured = true
		if (sourcePath.endsWith(PREVIEW_FILE_SUFFIX)) {
			definition = definitions.find((candidate) => candidate.configPath && resolve(candidate.configPath) === sourcePath)
			if (!definition) {
				definition = await previewFileDefinitionFromPath(sourcePath, { projectDir: root })
				configured = false
			}
		} else {
			definition = previewDefinitionForSource(definitions, sourcePath)
		}
		if (!definition) throw Object.assign(new Error("No preview is associated with this source file"), { status: 404 })
		return {
			path: definition.configPath ?? definition.source.configPath ?? sourcePath,
			sourcePath,
			entryPath: previewEntryPathForSource(definition, sourcePath),
			configured,
			definition,
		}
	}
	const readTextTail = async (path, maxBytes) => {
		try {
			const value = await readFile(path)
			if (value.length <= maxBytes) return value.toString("utf-8")
			let start = value.length - maxBytes
			while (start < value.length && (value[start] & 0xc0) === 0x80) start++
			return value.subarray(start).toString("utf-8")
		} catch (err) {
			if (err?.code === "ENOENT") return ""
			throw err
		}
	}
	let projectWorkspacePromise
	const projectWorkspaceBackend = () => {
		if (!options.createProjectWorkspace) throw Object.assign(new Error("Workspace host does not provide Web project browsing"), { status: 501 })
		projectWorkspacePromise ??= Promise.resolve(options.createProjectWorkspace({
			root: policy?.root ?? "/",
			stateDir: join(dataRoot(), "web-file-explorer"),
			readOnly: false,
			home: policy?.root && policy.root !== "/" ? policy.root : process.env.HOME || "",
		}))
		return projectWorkspacePromise
	}
	const resolveDirectory = (cwd, label) => policy ? policy.normalizeStoredCwd(cwd, label) : localDirectoryPath(cwd, label)
	const loadProjectSkills = async (cwd) => {
		const skillsCwd = await normalizeStoredCwd(cwd, "skills cwd")
		return loadSkillsForCwd(skillsCwd, {
			roots: projectSkillRoots(skillsCwd, { root: policy?.root ?? "/" }),
			allowPath: (path) => !policy || pathIsWithin(policy.root, path),
		})
	}
	const implementation = {
		"host.describe": async () => description,
		"path.resolveDirectory": ({ cwd, label }) => resolveDirectory(cwd, label),
		"path.normalizeUserCwd": async ({ cwd, label }) => normalizeUserCwd(cwd, label),
		"path.normalizeStoredCwd": async ({ cwd, label }) => normalizeStoredCwd(cwd, label),
		"path.allowsStoredCwd": async ({ cwd }) => !policy || policy.allowsStoredCwd(cwd),
		"context.loadProject": async ({ cwd }) => loadProjectContextFiles({
			cwd: await normalizeStoredCwd(cwd, "project context cwd"),
			root: policy?.root ?? "/",
			allowPath: allowContextPath,
		}),
		"context.loadForPath": async ({ cwd, path, requireFile }) => {
			const contextCwd = await normalizeStoredCwd(cwd, "project context cwd")
			const contextPath = await allowedFilePath(resolve(contextCwd, path), "project context path")
			return loadContextFilesForPath({ cwd: contextCwd, path: contextPath, requireFile, allowPath: allowContextPath })
		},
		"context.loadProjectSkills": ({ cwd }) => loadProjectSkills(cwd),
		"context.readProjectSkill": async ({ cwd, path }) => {
			const outcome = await loadProjectSkills(cwd)
			const skill = outcome.skills.find((candidate) => candidate.path === resolve(path))
			if (!skill) throw Object.assign(new Error("Project skill not found"), { status: 404 })
			return readFile(await allowedFilePath(skill.path, "project skill"), "utf-8")
		},
		"project.info": async ({ cwd }) => projectInfoForCwd(await normalizeStoredCwd(cwd, "project cwd")),
		"project.setName": async ({ cwd, name }) => setProjectNameForCwd(await normalizeStoredCwd(cwd, "project cwd"), name),
		"project.readIdentity": async ({ cwd }) => projectIdentityForCwd(await normalizeStoredCwd(cwd, "project cwd")),
		"project.ensureIdentity": async ({ cwd, id, replace }) => ensureProjectIdentityForCwd(
			await normalizeStoredCwd(cwd, "project cwd"),
			{ ...(id ? { id } : {}), replace: replace === true },
		),
		"project.resolveRoot": async ({ baseRoot, requestedRoot }) => {
			const base = await resolveDirectory(baseRoot, "project discovery root")
			const root = await (await projectWorkspaceBackend()).resolveProjectRoot(base, requestedRoot)
			return resolveDirectory(root, "project discovery root")
		},
		"project.rename": async ({ root, input }) => {
			const allowedRoot = await resolveDirectory(root, "project discovery root")
			const result = await (await projectWorkspaceBackend()).renameProject(allowedRoot, input)
			return {
				...result,
				path: await resolveDirectory(result.path, "renamed project directory"),
				project: {
					...result.project,
					path: await resolveDirectory(result.project.path, "renamed project directory"),
				},
			}
		},
		"project.discover": async ({ root }) => (await projectWorkspaceBackend()).discoverProjects(await resolveDirectory(root, "project discovery root")),
		"project.add": async ({ root, input }) => {
			const allowedRoot = await resolveDirectory(root, "project discovery root")
			const result = await (await projectWorkspaceBackend()).addProject(allowedRoot, input)
			return {
				...result,
				project: {
					...result.project,
					path: await resolveDirectory(result.project.path, "created project directory"),
				},
			}
		},
		"project.delete": async ({ root, input }) => {
			const allowedRoot = await resolveDirectory(root, "project discovery root")
			return (await projectWorkspaceBackend()).deleteProject(allowedRoot, input)
		},
		"preview.projectManifest": ({ projectDir }) => projectManifest(projectDir),
		"preview.ensureProject": async ({ projectDir }) => {
			const root = await normalizeStoredCwd(projectDir, "preview project directory")
			await ensureProjectPreviewDirectory(root)
			return projectManifest(root)
		},
		"preview.resolveSource": ({ path, projectDir }) => resolvedPreviewSource(path, projectDir),
		"preview.resolveStaticFile": async ({ path }) => {
			const filePath = await allowedFilePath(path, "static preview file")
			const info = await stat(filePath)
			if (!info.isFile()) throw Object.assign(new Error("Not a file"), { status: 400 })
			return { path: filePath, size: info.size }
		},
		"preview.readSource": async ({ path, maxBytes }) => {
			const sourcePath = await allowedFilePath(path, "preview source file")
			const info = await stat(sourcePath)
			if (!info.isFile()) throw Object.assign(new Error("Preview source is not a file"), { status: 400 })
			if (info.size > maxBytes) return { path: sourcePath, size: info.size, tooLarge: true }
			return { path: sourcePath, text: await readFile(sourcePath, "utf-8"), size: info.size }
		},
		"preview.readProjectLog": async ({ projectDir, name, maxBytes }) => {
			const root = await normalizeStoredCwd(projectDir, "preview project directory")
			return readTextTail(await allowedFilePath(projectPreviewLogPath(root, name), "preview log"), maxBytes)
		},
		"checkpoint.captureFile": async ({ path }) => captureLocalWorkspaceFile(await allowedFilePath(path, "checkpoint file")),
		"checkpoint.restoreFile": async (snapshot) => restoreLocalWorkspaceFile({
			...snapshot,
			path: await allowedFilePath(snapshot.path, "checkpoint file", { followLeaf: snapshot.existed }),
		}),
		"sourceControl.repoInfo": (params) => sourceControlRepoInfo(sourceControlOptions(params)),
		"sourceControl.snapshot": (params) => sourceControlSnapshot(sourceControlOptions(params)),
		"sourceControl.commits": (params) => sourceControlCommits(sourceControlOptions(params)),
		"sourceControl.commit": (params) => sourceControlCommit(sourceControlOptions(params)),
		"sourceControl.change": (params) => sourceControlChange(sourceControlOptions(params)),
		"sourceControl.discard": (params) => sourceControlDiscardChange(sourceControlOptions(params)),
		"sourceControl.stage": (params) => sourceControlStage(sourceControlOptions(params)),
		"sourceControl.unstage": (params) => sourceControlUnstage(sourceControlOptions(params)),
		"sourceControl.createCommit": (params) => sourceControlCreateCommit(sourceControlOptions(params)),
		"sourceControl.sync": (params) => sourceControlSync(sourceControlOptions(params)),
		"worktree.isLinked": async ({ path }) => isLinkedGitWorktree(policy ? await normalizeStoredCwd(path, "worktree path") : await localDirectoryPath(path, "worktree path")),
		"worktree.location": async ({ path }) => (await gitWorktreeLocation(policy ? await normalizeStoredCwd(path, "worktree path") : await localDirectoryPath(path, "worktree path"))) ?? null,
		"worktree.statuses": async ({ records, limit }) => gitWorktreeStatusesFromRecords(await allowedWorktreeRecords(records), { limit }),
		"worktree.cleanup": async ({ records }) => cleanupGitWorktreeRecords(await allowedWorktreeRecords(records)),
		"worktree.close": async ({ records, payload, workerContext }) => (await closeGitWorktreeRecords(await allowedWorktreeRecords(records), payload, { workerContext })) ?? null,
	}
	const dispatcher = createContractDispatcher(workspaceContract, implementation)
	const peer = createDirectContractPeer([dispatcher])
	const localPreviewTransport = createLocalPreviewTransport()
	let client
	let previewExecutor
	const processExecutor = () => {
		previewExecutor ??= (options.createPreviewExecutor ?? ((executorOptions) => new ToolExecutorRuntime(executorOptions)))({
			cwd: policy?.root ?? process.cwd(),
			environmentRegistry: options.environmentRegistry,
			getSettings: options.getSettings,
			previewAccessToken: options.previewAccessToken,
			workspace: client,
		})
		return previewExecutor
	}
	const previewExecutionRoot = (path) => normalizeStoredCwd(path, "preview execution root")
	const previewTransport = Object.freeze({
		...localPreviewTransport,
		async describeProcess(executionRoot, cwd) {
			return processExecutor().describePreviewProcess(await previewExecutionRoot(executionRoot), cwd)
		},
		async startProcess(id, params) {
			const executionRoot = await previewExecutionRoot(params.executionRoot)
			const logPath = await allowedFilePath(params.logPath, "preview log", { followLeaf: false })
			return processExecutor().startPreviewProcess(id, { ...params, executionRoot, logPath })
		},
		touchProcess: (id) => processExecutor().touchPreviewProcess(id),
		stopProcess: (id) => processExecutor().stopPreviewProcess(id),
		async serveStatic(request, target, serveOptions = {}) {
			const rootPath = await normalizeStoredCwd(target.rootPath, "static preview root")
			return localPreviewTransport.serveStatic(request, { ...target, rootPath }, serveOptions)
		},
		async openStaticDocument(request, target, openOptions = {}) {
			const rootPath = await normalizeStoredCwd(target.rootPath, "static preview root")
			return localPreviewTransport.openStaticDocument(request, { ...target, rootPath }, openOptions)
		},
	})
	const projectWorkspace = {
		browseAvailable: typeof options.createProjectWorkspace === "function",
		...(options.createProjectWorkspace ? { async fetch(request, fetchOptions = {}) {
			return (await projectWorkspaceBackend()).fetch(request, fetchOptions)
		} } : {}),
		watchDirectory(root, path, onChange, onError) {
			let watcher
			let closed = false
			Promise.all([
				resolveDirectory(root, "watched project root"),
				allowedFilePath(path, "watched project directory"),
			]).then(async ([projectRoot, directory]) => {
				if (!pathIsWithin(projectRoot, directory)) {
					throw Object.assign(new Error("watched directory is outside the project root"), { status: 403 })
				}
				if (closed) return
				const reportChange = async () => {
					try {
						const info = await stat(directory)
						if (!info.isDirectory()) throw Object.assign(new Error("watched path is not a directory"), { status: 400 })
						onChange({ exists: true })
					} catch (err) {
						if (err?.code === "ENOENT" || err?.code === "ENOTDIR") onChange({ exists: false })
						else onError(err)
					}
				}
				const info = await stat(directory).catch((err) => {
					if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return undefined
					throw err
				})
				if (!info) {
					onChange({ exists: false })
					return
				}
				if (!info.isDirectory()) throw Object.assign(new Error("watched path is not a directory"), { status: 400 })
				try {
					watcher = watch(directory, { persistent: false }, () => void reportChange())
					watcher.on("error", (err) => {
						if (err?.code === "ENOENT" || err?.code === "ENOTDIR") onChange({ exists: false })
						else onError(err)
					})
				} catch (err) {
					if (err?.code === "ENOENT" || err?.code === "ENOTDIR") onChange({ exists: false })
					else throw err
				}
			}).catch(onError)
			return {
				close() {
					closed = true
					watcher?.close()
				},
			}
		},
	}
	const openToolExecutor = options.createToolExecutor ?? ((executorOptions) => new ToolExecutorRuntime({ ...executorOptions, workspace: client }))
	client = createWorkspaceClient(peer, { ...description, openToolExecutor, previewTransport, projectWorkspace })
	return Object.freeze({
		kind: "local",
		description,
		dispatcher,
		peer,
		client,
		async close() {
			await previewExecutor?.dispose?.()
			const backend = await projectWorkspacePromise
			await backend?.close?.()
		},
	})
}
