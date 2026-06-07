import { isAbsolute, relative, resolve } from "node:path"

export function pathIsWithin(root, path) {
	const rel = relative(root, path)
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel))
}

export function minimizeCoveredPaths(paths) {
	const sorted = [...new Set(paths.map((path) => resolve(path)))]
		.sort((a, b) => a.length - b.length || a.localeCompare(b))
	return sorted.filter((path, index) => !sorted.slice(0, index).some((root) => pathIsWithin(root, path)))
}

function pathRelativeTo(root, path) {
	const rel = relative(root, path)
	if (rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel))) return rel
	return undefined
}

function mountKey(mount) {
	return `${mount.from}\0${mount.to}\0${mount.readOnly ? "ro" : "rw"}`
}

function mountIsCoveredBy(root, mount) {
	if (root.readOnly !== mount.readOnly) return false
	const fromRel = pathRelativeTo(root.from, mount.from)
	const toRel = pathRelativeTo(root.to, mount.to)
	return fromRel !== undefined && toRel !== undefined && fromRel === toRel
}

export function minimizeCoveredMounts(mounts) {
	const seen = new Set()
	const sorted = mounts
		.map((mount) => ({ from: resolve(mount.from), to: resolve(mount.to), readOnly: mount.readOnly === true }))
		.filter((mount) => {
			const key = mountKey(mount)
			if (seen.has(key)) return false
			seen.add(key)
			return true
		})
		.sort((a, b) =>
			a.from.length - b.from.length
			|| a.to.length - b.to.length
			|| a.from.localeCompare(b.from)
			|| a.to.localeCompare(b.to)
			|| Number(a.readOnly) - Number(b.readOnly)
		)
	return sorted.filter((mount, index) => !sorted.slice(0, index).some((root) => mountIsCoveredBy(root, mount)))
}

export function readOnlyMountsCoveredByWritable(mounts) {
	return mounts.filter((mount) =>
		mount.readOnly
		&& mounts.some((root) => !root.readOnly && mountIsCoveredBy(root, { ...mount, readOnly: false }))
	)
}

export function mountedPathForHostPath(mounts, hostPath, options = {}) {
	const resolved = resolve(hostPath)
	const matches = mounts
		.map((mount) => {
			const rel = pathRelativeTo(resolve(mount.from), resolved)
			const path = rel === undefined ? undefined : rel ? resolve(mount.to, rel) : resolve(mount.to)
			return { mount, rel, path }
		})
		.filter(({ rel, path }) => rel !== undefined && (!options.requireOneToOneMapping || path === resolved))
		.sort((a, b) => b.mount.from.length - a.mount.from.length || Number(b.mount.readOnly) - Number(a.mount.readOnly))
	const match = matches[0]
	if (!match) return undefined
	return {
		path: match.path,
		readOnly: match.mount.readOnly === true,
		mount: match.mount,
	}
}

export function addReadOnlyMountUnlessCovered(mounts, hostPath, options = {}) {
	if (!hostPath || mountedPathForHostPath(mounts, hostPath, options)) return mounts
	return minimizeCoveredMounts([...mounts, { from: resolve(hostPath), to: resolve(hostPath), readOnly: true }])
}

export function addWritableMountUnlessCovered(mounts, hostPath) {
	if (!hostPath) return mounts
	const mounted = mountedPathForHostPath(mounts, hostPath)
	if (mounted && !mounted.readOnly) return mounts
	return minimizeCoveredMounts([...mounts, { from: resolve(hostPath), to: resolve(hostPath), readOnly: false }])
}

export function assertReadOnlyMountsNotCoveredByWritable(mounts, context = "Sandbox") {
	const conflicts = readOnlyMountsCoveredByWritable(mounts)
	if (conflicts.length > 0) {
		const formatted = conflicts.map((mount) => `${mount.from}${mount.to !== mount.from ? ` -> ${mount.to}` : ""}`).join(", ")
		throw new Error(`${context} read-only mount is inside a writable mount: ${formatted}`)
	}
}

export function hostPathForMountedPath(mounts, mountedPath, options = {}) {
	const resolved = resolve(mountedPath)
	const matches = mounts
		.map((mount) => {
			const rel = pathRelativeTo(resolve(mount.to), resolved)
			const path = rel === undefined ? undefined : rel ? resolve(mount.from, rel) : resolve(mount.from)
			return { mount, rel, path }
		})
		.filter(({ mount, rel }) => rel !== undefined && (!options.writableOnly || mount.readOnly !== true))
		.sort((a, b) => b.mount.to.length - a.mount.to.length || Number(b.mount.readOnly) - Number(a.mount.readOnly))
	const match = matches[0]
	if (!match) return undefined
	return {
		path: match.path,
		readOnly: match.mount.readOnly === true,
		mount: match.mount,
	}
}

function resolveMountPath(sessionWd, path, context) {
	if (isAbsolute(path)) return resolve(path)
	if (!sessionWd || !isAbsolute(sessionWd)) {
		throw new Error(`${context} relative mountPaths require an absolute startup directory, got: ${sessionWd || "(empty)"}`)
	}
	return resolve(sessionWd, path)
}

function resolveMountEntry(sessionWd, entry, context) {
	if (typeof entry === "string") {
		const from = resolveMountPath(sessionWd, entry, context)
		return { from, to: from, readOnly: false }
	}
	const from = resolveMountPath(sessionWd, entry.from, context)
	const to = entry.to === undefined ? from : entry.to
	if (!isAbsolute(to)) throw new Error(`${context} mountPaths target must be absolute, got: ${to || "(empty)"}`)
	return { from, to: resolve(to), readOnly: entry.readOnly === true }
}

export function effectiveSandboxMounts({ sessionWd, useSessionWd = true, mountPaths = [] }, context = "Sandbox") {
	if (useSessionWd && (!sessionWd || !isAbsolute(sessionWd))) {
		throw new Error(`${context} useSessionWd requires an absolute startup directory, got: ${sessionWd || "(empty)"}`)
	}
	const sessionMount = useSessionWd
		? [{ from: resolve(sessionWd), to: resolve(sessionWd), readOnly: false }]
		: []
	return minimizeCoveredMounts([
		...sessionMount,
		...mountPaths.map((entry) => resolveMountEntry(sessionWd, entry, context)),
	])
}

export function effectiveSandboxMountPaths({ sessionWd, useSessionWd = true, mountPaths = [] }, context = "Sandbox") {
	return effectiveSandboxMounts({ sessionWd, useSessionWd, mountPaths }, context).map((mount) => mount.from)
}
