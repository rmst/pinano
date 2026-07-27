import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

import { overviewRouteForCwd, parseRouteArg, routeCwd, routeToArg } from "../navigation/routes.js"
import { pathIsWithin } from "../sandbox/paths.js"
import { workspaceRootFromSettings } from "../sandbox/workspace-root-policy.js"

export const FALLBACK_WEB_INITIAL_ROUTE = "/browse"

function cleanInitialRouteValue(value) {
	const route = typeof value === "string" ? value.trim() : ""
	if (!route) return undefined
	if (!route.startsWith("/") || route.startsWith("//")) {
		throw Object.assign(new Error("service.web.initialRoute must be an absolute Web route path"), { status: 400 })
	}
	return route
}

async function existingDirectoryPath(value, resolveDirectory = undefined) {
	const text = typeof value === "string" ? value.trim() : ""
	if (!text || !isAbsolute(text)) return undefined
	try {
		if (resolveDirectory) return await resolveDirectory(text)
		const real = resolve(await realpath(text))
		const info = await stat(real)
		return info.isDirectory() ? real : undefined
	} catch {
		return undefined
	}
}

function canonicalRoutePath(value, workspaceRoot = undefined) {
	const route = parseRouteArg(value)
	const cwd = routeCwd(route)
	if (workspaceRoot && cwd && !pathIsWithin(resolve(workspaceRoot), resolve(cwd))) {
		throw Object.assign(new Error(`service.web.initialRoute cwd must be inside configured service.workspaceRoot (${workspaceRoot}): ${cwd}`), { status: 400 })
	}
	return routeToArg(route)
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
export function webInitialRouteCwd(value) {
	if (!value) return undefined
	try {
		return routeCwd(parseRouteArg(value))
	} catch {
		return undefined
	}
}

/**
 * @param {Pick<import("../settings.js").Settings, "service"> | undefined} settings
 * @param {{ workspaceRoot?: string, home?: string, resolveDirectory?: (path: string) => Promise<string> }} [options]
 * @returns {Promise<string>}
 */
export async function webInitialRouteFromSettings(settings, options = {}) {
	const workspaceRoot = options.workspaceRoot || workspaceRootFromSettings(settings)
	const configured = cleanInitialRouteValue(settings?.service?.web?.initialRoute)
	if (configured) return canonicalRoutePath(configured, workspaceRoot)

	const root = await existingDirectoryPath(workspaceRoot, options.resolveDirectory)
	if (root) return routeToArg(overviewRouteForCwd(root))

	const homeCandidate = options.home !== undefined ? options.home : process.env.HOME || homedir()
	const home = await existingDirectoryPath(homeCandidate, options.resolveDirectory)
	if (home) return routeToArg(overviewRouteForCwd(home))

	return FALLBACK_WEB_INITIAL_ROUTE
}
