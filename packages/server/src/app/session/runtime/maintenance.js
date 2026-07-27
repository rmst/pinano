import { stat } from "node:fs/promises"
import { join } from "node:path"

import { PREVIEW_LOG_DIRNAME } from "../../preview/manifest.js"
import { SESSION_CUSTOM_TYPE_PROPERTIES, isAutomatedMaintenanceMessage } from "../properties.js"

export const PRE_TURN_MAINTENANCE_PLACEMENT = "pre_turn"
export const PRE_TURN_SESSION_PROPERTIES_MAX_TOOL_CALLS = 3
export const PROJECT_SETUP_MAINTENANCE_KIND = "project_setup"

export function projectMaintenanceNoticeMessage({ projectDir }) {
	return {
		role: "developer",
		content: [{ type: "text", text: [
			`This is a hidden Cerex project maintenance session for ${projectDir}.`,
			"Keep work focused on durable project metadata and preview proxy setup. Do not modify product source unless the user explicitly asked for that project change.",
		].join("\n") }],
		timestamp: Date.now(),
		hidden: true,
		projectMaintenanceNotice: true,
	}
}

export async function projectPreviewsDirectoryExists(projectDir, workspace) {
	return (await workspace.previews.projectManifest(projectDir)).exists
}

export async function projectMaintenanceSetupStatus(projectDir, workspace) {
	const project = await workspace.project.info(projectDir).catch(() => undefined)
	const previewsDirExists = await projectPreviewsDirectoryExists(projectDir, workspace)
	const linkedGitWorktree = await workspace.worktrees.isLinked(projectDir).catch(() => false)
	const missingProjectName = !project?.name
	const missingPreviewsDir = !previewsDirExists
	return {
		needed: !linkedGitWorktree && (missingProjectName || missingPreviewsDir),
		missingProjectName,
		missingPreviewsDir,
		linkedGitWorktree,
		...(linkedGitWorktree ? { skipReason: "linked_git_worktree" } : {}),
		project,
	}
}

export function projectMaintenanceEligible(setup) {
	return !setup?.skipReason
}

export async function ensureProjectPreviewsDirectory(projectDir, workspace) {
	return workspace.previews.ensureProject(projectDir)
}

export function projectMaintenancePrompt({ projectDir, project, setup = {} }) {
	const label = project?.name || project?.label || projectDir
	const reasons = [
		...(setup.missingProjectName ? ["project metadata has no name"] : []),
		...(setup.missingPreviewsDir ? [".cerex/previews does not exist"] : []),
	]
	return [
		`Set up Cerex project metadata and preview modules for ${label}.`,
		"",
		`Project directory: ${projectDir}`,
		...(reasons.length ? ["", `Setup reason: ${reasons.join("; ")}.`] : []),
		"",
		"Tasks:",
		"1. Choose a concise stable project name and set it with `cerex project set <name>` unless the existing project metadata is already correct.",
		"2. Ensure `.cerex/previews/` exists. It is fine for the directory to stay empty when this repository does not have a relevant web/docs preview.",
		"3. Inspect the project just enough to identify likely local preview commands for this repo. Many repositories, such as mobile apps, libraries, CLIs, or backend-only services, may not need a Cerex preview.",
		"4. Create `.cerex/previews/<name>.preview.js` modules only for useful web apps or docs servers you can justify from local files. Preview names must be lowercase DNS labels. The module must export `default { exec, description?, healthPath? }`.",
		"5. Use `exec` as either a shell command string or a JS function `exec({ host, port, publicUrl, logPath, signal, env })`. The preview must listen on `host:port` or `$CEREX_HOST:$CEREX_PORT`; shell commands also receive `$CEREX_PUBLIC_URL` and `$CEREX_PREVIEW_LOG`.",
		"",
		"Keep this maintenance pass conservative: keep scripts small, leave unrelated source alone, and do not install dependencies or use the network.",
	].join("\n")
}

function shouldAutoRegisterProject(project) {
	return Boolean(project?.name || project?.missingProjectMetadata === true)
}

export async function sessionPreviewsDirectoryExists(sessionDir) {
	try {
		return (await stat(join(sessionDir, PREVIEW_LOG_DIRNAME))).isDirectory()
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return false
		throw err
	}
}

export async function shouldAutoRegisterProjectRoot(projectDir, project, workspace) {
	return shouldAutoRegisterProject(project) || (await workspace.previews.projectManifest(projectDir)).exists
}

export function activeAutomatedMaintenanceUser(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message?.role === "user") return isAutomatedMaintenanceMessage(message) && Boolean(message.maintenance) ? message : undefined
	}
	return undefined
}

/** @param {any[]} messages */
export function automatedMaintenanceExchangeActive(messages) {
	return Boolean(activeAutomatedMaintenanceUser(messages))
}

/** @param {any[]} messages */
export function preTurnSessionPropertiesMaintenanceActive(messages) {
	const message = activeAutomatedMaintenanceUser(messages)
	return message?.maintenance === SESSION_CUSTOM_TYPE_PROPERTIES
		&& message.maintenancePlacement === PRE_TURN_MAINTENANCE_PLACEMENT
}

/** @param {any[]} messages */
export function projectSetupMaintenanceActive(messages) {
	return activeAutomatedMaintenanceUser(messages)?.maintenance === PROJECT_SETUP_MAINTENANCE_KIND
}

/** @param {any} message */
export function asPreTurnMaintenanceMessage(message) {
	return {
		...message,
		maintenancePlacement: PRE_TURN_MAINTENANCE_PLACEMENT,
	}
}
