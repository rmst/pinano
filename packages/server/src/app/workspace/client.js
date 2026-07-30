import { createContractClient } from "../../../../protocol/src/contract.js"
import { workspaceContract } from "../../../../protocol/src/workspace-contract.js"

const freezeNamespace = (value) => Object.freeze(value)

/** @typedef {ReturnType<typeof createWorkspaceClient>} WorkspaceClient */

/**
 * Create the service-side semantic workspace capability. Operation names and envelopes stay behind this interface.
 * @param {any} peer
 * @param {{ root?: string, configuredRoot?: string, openToolExecutor?: (options: any) => any, projectWorkspace?: any, previewTransport?: any }} [config]
 */
export function createWorkspaceClient(peer, config = {}) {
	const contract = createContractClient(workspaceContract, peer)
	const call = (operation, params, callOptions = undefined) => contract.call(operation, params, callOptions)
	const description = Object.freeze({
		root: config.root ?? null,
		configuredRoot: config.configuredRoot ?? null,
	})
	const previews = freezeNamespace({
		projectManifest: (projectDir, callOptions = undefined) => call("preview.projectManifest", { projectDir }, callOptions),
		ensureProject: (projectDir, callOptions = undefined) => call("preview.ensureProject", { projectDir }, callOptions),
		resolveSource: (path, options = {}, callOptions = undefined) => call("preview.resolveSource", {
			path,
			...(options.projectDir ? { projectDir: options.projectDir } : {}),
		}, callOptions),
		resolveStaticFile: (path, callOptions = undefined) => call("preview.resolveStaticFile", { path }, callOptions),
		readSource: (path, maxBytes, callOptions = undefined) => call("preview.readSource", { path, maxBytes }, callOptions),
		readProjectLog: (projectDir, name, maxBytes, callOptions = undefined) => call("preview.readProjectLog", { projectDir, name, maxBytes }, callOptions),
		process: freezeNamespace({
			describe: (executionRoot, cwd = ".") => {
				if (!config.previewTransport?.describeProcess) throw new Error("Workspace host does not provide preview processes")
				return config.previewTransport.describeProcess(executionRoot, cwd)
			},
			start: (id, params) => {
				if (!config.previewTransport?.startProcess) throw new Error("Workspace host does not provide preview processes")
				return config.previewTransport.startProcess(id, params)
			},
			touch: (id) => {
				if (!config.previewTransport?.touchProcess) throw new Error("Workspace host does not provide preview processes")
				return config.previewTransport.touchProcess(id)
			},
			stop: (id) => {
				if (!config.previewTransport?.stopProcess) throw new Error("Workspace host does not provide preview processes")
				return config.previewTransport.stopProcess(id)
			},
			allocatePort: (host) => {
				if (!config.previewTransport?.allocatePort) throw new Error("Workspace host does not provide preview processes")
				return config.previewTransport.allocatePort(host)
			},
			health: (target, path, timeoutMs) => {
				if (!config.previewTransport?.health) throw new Error("Workspace host does not provide preview processes")
				return config.previewTransport.health(target, path, timeoutMs)
			},
			fetch: (request, target, options = {}) => {
				if (!config.previewTransport?.fetchProcess) throw new Error("Workspace host does not provide preview processes")
				return config.previewTransport.fetchProcess(request, target, options)
			},
			upgrade: (incoming, socket, head, target, headers) => {
				if (!config.previewTransport?.upgradeProcess) throw new Error("Workspace host does not provide preview processes")
				return config.previewTransport.upgradeProcess(incoming, socket, head, target, headers)
			},
		}),
		static: freezeNamespace({
			fetch: (request, target, options = {}) => {
				if (!config.previewTransport?.serveStatic) throw new Error("Workspace host does not provide static previews")
				return config.previewTransport.serveStatic(request, target, options)
			},
			openDocument: (request, target, options = {}) => {
				if (!config.previewTransport?.openStaticDocument) throw new Error("Workspace host does not provide static document navigation")
				return config.previewTransport.openStaticDocument(request, target, options)
			},
		}),
	})
	const paths = freezeNamespace({
		resolveDirectory: (cwd, label = "directory", callOptions = undefined) => call("path.resolveDirectory", { cwd, label }, callOptions),
		normalizeUserCwd: (cwd, label = "cwd", callOptions = undefined) => call("path.normalizeUserCwd", { cwd, label }, callOptions),
		normalizeStoredCwd: (cwd, label = "cwd", callOptions = undefined) => call("path.normalizeStoredCwd", { cwd, label }, callOptions),
		allowsStoredCwd: (cwd, callOptions = undefined) => call("path.allowsStoredCwd", { cwd }, callOptions),
	})
	const context = freezeNamespace({
		loadProject: (cwd, callOptions = undefined) => call("context.loadProject", { cwd }, callOptions),
		loadForPath: (cwd, path, options = {}, callOptions = undefined) => call("context.loadForPath", {
			cwd,
			path,
			...(options.requireFile === true ? { requireFile: true } : {}),
		}, callOptions),
		loadProjectSkills: (cwd, callOptions = undefined) => call("context.loadProjectSkills", { cwd }, callOptions),
		readProjectSkill: (cwd, path, callOptions = undefined) => call("context.readProjectSkill", { cwd, path }, callOptions),
	})
	const project = freezeNamespace({
		browseAvailable: config.projectWorkspace?.browseAvailable === true,
		info: (cwd, callOptions = undefined) => call("project.info", { cwd }, callOptions),
		setName: (cwd, name, callOptions = undefined) => call("project.setName", { cwd, name }, callOptions),
		readIdentity: (cwd, callOptions = undefined) => call("project.readIdentity", { cwd }, callOptions),
		ensureIdentity: (cwd, options = {}, callOptions = undefined) => call("project.ensureIdentity", { cwd, ...options }, callOptions),
		resolveRoot: (baseRoot, requestedRoot = "", callOptions = undefined) => call("project.resolveRoot", { baseRoot, requestedRoot }, callOptions),
		discover: (root, callOptions = undefined) => call("project.discover", { root }, callOptions),
		add: (root, input, callOptions = undefined) => call("project.add", { root, input }, callOptions),
		rename: (root, input, callOptions = undefined) => call("project.rename", { root, input }, callOptions),
		delete: (root, input, callOptions = undefined) => call("project.delete", { root, input }, callOptions),
	})
	const files = freezeNamespace({
		browseAvailable: typeof config.projectWorkspace?.fetch === "function",
		fetch: (request, options = {}) => {
			if (!config.projectWorkspace?.fetch) throw new Error("Workspace host does not provide file browsing")
			return config.projectWorkspace.fetch(request, options)
		},
		watchDirectory: (root, path, onChange, onError) => {
			if (!config.projectWorkspace?.watchDirectory) throw new Error("Workspace host does not provide directory watching")
			return config.projectWorkspace.watchDirectory(root, path, onChange, onError)
		},
	})
	const checkpoints = freezeNamespace({
		captureFile: (path, callOptions = undefined) => call("checkpoint.captureFile", { path }, callOptions),
		restoreFile: (snapshot, callOptions = undefined) => call("checkpoint.restoreFile", snapshot, callOptions),
	})
	const sourceControl = freezeNamespace({
		repoInfo: (params = {}, callOptions = undefined) => call("sourceControl.repoInfo", params, callOptions),
		snapshot: (params = {}, callOptions = undefined) => call("sourceControl.snapshot", params, callOptions),
		commits: (params = {}, callOptions = undefined) => call("sourceControl.commits", params, callOptions),
		commit: (params = {}, callOptions = undefined) => call("sourceControl.commit", params, callOptions),
		change: (params = {}, callOptions = undefined) => call("sourceControl.change", params, callOptions),
		discard: (params = {}, callOptions = undefined) => call("sourceControl.discard", params, callOptions),
		stage: (params = {}, callOptions = undefined) => call("sourceControl.stage", params, callOptions),
		unstage: (params = {}, callOptions = undefined) => call("sourceControl.unstage", params, callOptions),
		createCommit: (params = {}, callOptions = undefined) => call("sourceControl.createCommit", params, callOptions),
		sync: (params = {}, callOptions = undefined) => call("sourceControl.sync", params, callOptions),
	})
	const worktrees = freezeNamespace({
		isLinked: (path, callOptions = undefined) => call("worktree.isLinked", { path }, callOptions),
		location: (path, callOptions = undefined) => call("worktree.location", { path }, callOptions),
		statuses: (records, options = {}, callOptions = undefined) => call("worktree.statuses", { records, ...(options.limit !== undefined ? { limit: options.limit } : {}) }, callOptions),
		cleanup: (records, callOptions = undefined) => call("worktree.cleanup", { records }, callOptions),
		close: (records, payload, workerContext = {}, callOptions = undefined) => call("worktree.close", { records, payload, workerContext }, callOptions),
	})
	return Object.freeze({
		description,
		paths,
		context,
		project,
		previews,
		files,
		checkpoints,
		sourceControl,
		worktrees,
		describe: (callOptions = undefined) => call("host.describe", {}, callOptions),
		openToolExecutor(executorOptions) {
			if (!config.openToolExecutor) throw new Error("Workspace host does not provide tool execution")
			return config.openToolExecutor(executorOptions)
		},
	})
}
