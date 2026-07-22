import { theme } from "../theme.js"

const OVERVIEW_AGE_WIDTH = 3

export function relativeAge(iso) {
	const at = Date.parse(iso)
	if (!Number.isFinite(at)) return ""
	const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 48) return `${hours}h`
	const days = Math.floor(hours / 24)
	if (days < 100) return `${days}d`
	if (days >= 365) {
		const years = Math.floor(days / 365)
		return `${Math.min(99, Math.max(1, years))}y`
	}
	const weeks = Math.floor(days / 7)
	return `${weeks}w`
}

/** @param {string} iso */
export function overviewAgeText(iso) {
	const age = relativeAge(iso)
	return age ? theme.dim(age.padStart(OVERVIEW_AGE_WIDTH, " ")) : ""
}

/** @param {string | undefined} iso */
export function elapsedAge(iso) {
	const at = Date.parse(iso || "")
	if (!Number.isFinite(at)) return ""
	const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	const restSeconds = seconds % 60
	if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`
	const hours = Math.floor(minutes / 60)
	const restMinutes = minutes % 60
	return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`
}

export function elapsedDuration(ms) {
	const seconds = Math.max(0, Math.floor(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	const restSeconds = seconds % 60
	if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`
	const hours = Math.floor(minutes / 60)
	const restMinutes = minutes % 60
	return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`
}

export function formatCount(n) {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
	return String(n)
}

/** @param {any} message */
