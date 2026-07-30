import { isAbsolute, resolve } from "node:path"

import { pathIsWithin } from "../sandbox/paths.js"

function absolutePath(value) {
	return typeof value === "string" && value && isAbsolute(value) ? resolve(value) : undefined
}

/** A directory-filtered project overview includes sessions started below the filter and every session associated with the project containing the filter. Keep all service and UI projections on this predicate. */
export function sessionMatchesDirectoryFilter(session, cwd) {
	if (!cwd) return true
	const filter = absolutePath(cwd)
	if (!filter) return false
	const initialWd = absolutePath(session?.initialWd) ?? absolutePath(session?.cwd)
	if (initialWd && pathIsWithin(filter, initialWd)) return true
	const projectDir = absolutePath(session?.projectDir)
	return projectDir ? pathIsWithin(filter, projectDir) || pathIsWithin(projectDir, filter) : false
}
