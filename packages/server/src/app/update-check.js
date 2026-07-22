// Daily public-release update check. This is intentionally notice-only: Pinano
// never runs npm or mutates its installation from inside the app.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import { isPinanoTestProcess, updateCheckStatePath } from "./paths.js"

export const UPDATE_CHECK_PACKAGE_URL = "https://raw.githubusercontent.com/rmst/pinano/public/package.json"
export const UPDATE_CHECK_NOTICE_MS = 10_000
export const UPDATE_CHECK_INSTALL_COMMAND = "npm install -g github:rmst/pinano"

const PINANO_DAY_START_HOUR = 4
const DEFAULT_TIMEOUT_MS = 2_000

/** @param {number} value */
const pad2 = (value) => String(value).padStart(2, "0")

/** @param {Date} now */
export function updateCheckDay(now = new Date()) {
	const shifted = new Date(now.getTime() - PINANO_DAY_START_HOUR * 60 * 60 * 1000)
	return `${shifted.getFullYear()}-${pad2(shifted.getMonth() + 1)}-${pad2(shifted.getDate())}`
}

/** @param {string | undefined} version */
function parseSemver(version) {
	const match = String(version ?? "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/)
	if (!match) return null
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4]?.split(".") ?? [],
	}
}

/** @param {string} a @param {string} b */
function comparePrereleaseIdentifier(a, b) {
	const aNumber = /^\d+$/.test(a) ? Number(a) : null
	const bNumber = /^\d+$/.test(b) ? Number(b) : null
	if (aNumber !== null && bNumber !== null) return Math.sign(aNumber - bNumber)
	if (aNumber !== null) return -1
	if (bNumber !== null) return 1
	return a === b ? 0 : a < b ? -1 : 1
}

/**
 * @param {string | undefined} a
 * @param {string | undefined} b
 * @returns {-1 | 0 | 1 | null}
 */
export function compareSemver(a, b) {
	const parsedA = parseSemver(a)
	const parsedB = parseSemver(b)
	if (!parsedA || !parsedB) return null
	for (const key of ["major", "minor", "patch"]) {
		if (parsedA[key] > parsedB[key]) return 1
		if (parsedA[key] < parsedB[key]) return -1
	}
	if (parsedA.prerelease.length === 0 && parsedB.prerelease.length === 0) return 0
	if (parsedA.prerelease.length === 0) return 1
	if (parsedB.prerelease.length === 0) return -1
	const length = Math.max(parsedA.prerelease.length, parsedB.prerelease.length)
	for (let i = 0; i < length; i++) {
		const left = parsedA.prerelease[i]
		const right = parsedB.prerelease[i]
		if (left === undefined) return -1
		if (right === undefined) return 1
		const compared = comparePrereleaseIdentifier(left, right)
		if (compared !== 0) return compared > 0 ? 1 : -1
	}
	return 0
}

async function currentPackageVersion() {
	const pkg = JSON.parse(await readFile(new URL("../../../../package.json", import.meta.url), "utf-8"))
	if (typeof pkg.version !== "string" || !pkg.version) throw new Error("Pinano package.json is missing a version")
	return pkg.version
}

/** @param {string} path */
async function readState(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf-8"))
		return parsed && typeof parsed === "object" ? parsed : {}
	} catch {
		return {}
	}
}

/** @param {string} path @param {Record<string, unknown>} state */
async function writeState(path, state) {
	try {
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, JSON.stringify(state, null, "\t"), { mode: 0o600 })
	} catch {}
}

function createTimeoutSignal(timeoutMs) {
	if (typeof AbortController === "undefined" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return { signal: undefined, cancel() {} }
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	timer.unref?.()
	return {
		signal: controller.signal,
		cancel: () => clearTimeout(timer),
	}
}

/**
 * @param {{ fetchFn?: typeof fetch, url?: string, timeoutMs?: number }} [options]
 */
async function fetchLatestPackageVersion(options = {}) {
	const fetchFn = options.fetchFn ?? globalThis.fetch
	if (typeof fetchFn !== "function") throw new Error("fetch is not available")
	const timeout = createTimeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
	try {
		const response = await fetchFn(options.url ?? UPDATE_CHECK_PACKAGE_URL, timeout.signal ? { signal: timeout.signal } : undefined)
		if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 0}`)
		const payload = await response.json()
		if (typeof payload?.version !== "string" || !payload.version) throw new Error("latest package.json is missing version")
		return payload.version
	} finally {
		timeout.cancel()
	}
}

/** @param {unknown} err */
function errorMessage(err) {
	return String(/** @type {any} */ (err)?.message ?? err).slice(0, 500)
}

/**
 * Checks GitHub's public package metadata at most once per Pinano day, where a
 * day starts at 04:00 local time. Returns a user-facing notice only when a newer
 * semver is available.
 *
 * @param {Pick<import("./settings.js").Settings, "updateCheck"> | undefined} settings
 * @param {{
 * 	now?: Date,
 * 	statePath?: string,
 * 	currentVersion?: string,
 * 	fetchFn?: typeof fetch,
 * 	url?: string,
 * 	timeoutMs?: number,
 * 	allowTestProcess?: boolean,
 * }} [options]
 * @returns {Promise<null | { currentVersion: string, latestVersion: string, message: string, installCommand: string }>}
 */
export async function checkForUpdateNotice(settings, options = {}) {
	if (settings?.updateCheck !== true) return null
	if (isPinanoTestProcess() && options.allowTestProcess !== true) return null

	const now = options.now ?? new Date()
	const day = updateCheckDay(now)
	const path = options.statePath ?? updateCheckStatePath()
	const state = await readState(path)
	if (state.lastAttemptDay === day) return null

	const baseState = {
		...state,
		version: 1,
		lastAttemptDay: day,
		lastAttemptAt: now.toISOString(),
	}

	try {
		const currentVersion = options.currentVersion ?? await currentPackageVersion()
		const latestVersion = await fetchLatestPackageVersion(options)
		const compared = compareSemver(latestVersion, currentVersion)
		const nextState = {
			...baseState,
			currentVersion,
			latestVersion,
			lastError: undefined,
		}
		if (compared === 1) {
			nextState.lastNoticeDay = day
			nextState.lastNoticeVersion = latestVersion
			await writeState(path, nextState)
			return {
				currentVersion,
				latestVersion,
				installCommand: UPDATE_CHECK_INSTALL_COMMAND,
				message: `Pinano update available: ${latestVersion}. Run ${UPDATE_CHECK_INSTALL_COMMAND}`,
			}
		}
		await writeState(path, nextState)
		return null
	} catch (err) {
		await writeState(path, { ...baseState, lastError: errorMessage(err) })
		return null
	}
}
