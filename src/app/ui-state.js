import { resolve } from "node:path"

/** @param {string | undefined} cwd */
export function overviewDirectoryStateKey(cwd) {
	return resolve(cwd || process.cwd())
}

/** @param {string | undefined} cwd */
export function overviewDirectoryFilterUiStateKey(cwd) {
	return `overview.directoryFilter:${overviewDirectoryStateKey(cwd)}`
}

/**
 * @param {{ getUiState?: (key: string) => Promise<any> }} client
 * @param {string} cwd
 */
export async function overviewDirectoryFilterEnabled(client, cwd) {
	if (!client || typeof client.getUiState !== "function") return false
	return await client.getUiState(overviewDirectoryFilterUiStateKey(cwd)) === true
}

/**
 * @param {{ setUiState?: (key: string, value: any) => Promise<any>, deleteUiState?: (key: string) => Promise<any> }} client
 * @param {string} cwd
 * @param {boolean} enabled
 */
export async function setOverviewDirectoryFilterEnabled(client, cwd, enabled) {
	const key = overviewDirectoryFilterUiStateKey(cwd)
	if (enabled) {
		if (!client || typeof client.setUiState !== "function") throw new Error("ui state service is not available")
		await client.setUiState(key, true)
	} else {
		if (!client || typeof client.deleteUiState !== "function") throw new Error("ui state service is not available")
		await client.deleteUiState(key)
	}
	return enabled
}
