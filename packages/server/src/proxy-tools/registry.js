import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { delimiter, join, resolve } from "node:path"

import { DOCKER_PROXY_ROUTE, GITHUB_PROXY_ROUTE } from "../../../protocol/src/internal-proxy-routes.js"
import { legacyProductEnvName, productEnvName } from "../../../protocol/src/product.js"

export const PROXY_TOOLS_BIN_ENV = productEnvName("PROXY_TOOLS_BIN")
export const LEGACY_PROXY_TOOLS_BIN_ENV = legacyProductEnvName("PROXY_TOOLS_BIN")
export const AVAILABLE_PROXY_TOOLS_ENV = productEnvName("INTERNAL_PROXY_TOOLS")
export const LEGACY_AVAILABLE_PROXY_TOOLS_ENV = legacyProductEnvName("INTERNAL_PROXY_TOOLS")

export const proxyToolSpecs = Object.freeze([
	Object.freeze({ name: "docker", route: DOCKER_PROXY_ROUTE, hostCommand: "docker" }),
	Object.freeze({ name: "gh", route: GITHUB_PROXY_ROUTE }),
])

function commandSearchPath(env) {
	if (typeof env.PATH === "string") return env.PATH
	return process.platform === "win32" ? "" : "/usr/bin:/bin"
}

async function isExecutableFile(path) {
	try {
		const stats = await stat(path)
		if (!stats.isFile() || (stats.mode & 0o111) === 0) return false
		await access(path, constants.X_OK)
		return true
	} catch {
		return false
	}
}

/** Resolve an executable command available to the Cerex service. */
export async function resolveHostCommand(command, env = process.env) {
	if (typeof command !== "string" || !command) return undefined
	if (command.includes("/")) {
		const candidate = resolve(command)
		return await isExecutableFile(candidate) ? candidate : undefined
	}
	for (const entry of commandSearchPath(env).split(delimiter)) {
		const directory = resolve(entry || ".")
		const candidate = join(directory, command)
		if (await isExecutableFile(candidate)) return candidate
	}
	return undefined
}

/** Return proxy tool names whose backing commands the Cerex service can execute on its host. */
export async function availableHostProxyToolNames(env = process.env) {
	const availability = await Promise.all(proxyToolSpecs.map(async (tool) => [
		tool.name,
		tool.hostCommand ? Boolean(await resolveHostCommand(tool.hostCommand, env)) : true,
	]))
	return availability.filter(([, available]) => available).map(([name]) => name)
}

export function knownProxyToolNames(names) {
	const requested = new Set(Array.isArray(names) ? names : [])
	return proxyToolSpecs.map((tool) => tool.name).filter((name) => requested.has(name))
}
