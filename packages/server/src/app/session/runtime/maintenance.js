import { stat } from "node:fs/promises"
import { join } from "node:path"

import { PREVIEW_DIRECTORY_NAME } from "../../preview/manifest.js"
import { SESSION_CUSTOM_TYPE_PROPERTIES, isAutomatedMaintenanceMessage } from "../properties.js"

export const PRE_TURN_MAINTENANCE_PLACEMENT = "pre_turn"
export const PRE_TURN_SESSION_PROPERTIES_MAX_TOOL_CALLS = 3
export const PROJECT_SETUP_MAINTENANCE_KIND = "project_setup"

export function projectMaintenanceNoticeMessage({ projectDir }) {
	return {
		role: "developer",
		content: [{ type: "text", text: [
			`This is an automated Cerex project setup session for ${projectDir}.`,
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
	const linkedGitWorktree = await workspace.worktrees.isLinked(projectDir)
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
		`Set up Cerex project metadata and previews for ${label}.`,
		"",
		`Project directory: ${projectDir}`,
		...(reasons.length ? ["", `Setup reason: ${reasons.join("; ")}.`] : []),
		"",
		"Tasks:",
		"1. Choose a concise stable project name and set it with `cerex project set <name>` unless the existing project metadata is already correct.",
		"2. Ensure `.cerex/previews/` exists. Inspect the project for a useful web or documentation preview; when one exists, read `cerex preview --help` and create an appropriate definition.",
		"",
		"Keep this setup pass conservative: keep scripts small, leave unrelated source alone, and do not install dependencies or use the network.",
	].join("\n")
}

function shouldAutoRegisterProject(project) {
	return Boolean(project?.name || project?.missingProjectMetadata === true)
}

export async function sessionPreviewsDirectoryExists(sessionDir) {
	try {
		return (await stat(join(sessionDir, PREVIEW_DIRECTORY_NAME))).isDirectory()
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
