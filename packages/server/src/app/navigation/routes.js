/**
 * Application frontend routes.
 *
 * Routes use the same canonical path shape in every frontend so terminal
 * reexec, `cerex open <route>`, and browser URLs describe the same page.
 */

/**
 * @typedef {"files" | "search" | "workbench" | "source-control" | "agent" | "terminal"} ProjectPane
 * @typedef {"diff" | "preview" | "logs"} ProjectFileView
 * @typedef {{ root: string, pane?: ProjectPane, file?: string, view?: ProjectFileView, line?: number, column?: number }} ProjectBrowserState
 * @typedef {{ type: "overview", cwd?: string, selectedSessionId?: string, projectRoot?: string, project?: ProjectBrowserState }} OverviewRoute
 * @typedef {{ type: "session", id: string, cwd?: string, projectRoot?: string, project?: ProjectBrowserState }} SessionRoute
 * @typedef {{ type: "settings-credentials" }} SettingsCredentialsRoute
 * @typedef {OverviewRoute | SessionRoute | SettingsCredentialsRoute} AppRoute
 */

/** @type {OverviewRoute} */
export const overviewRoute = { type: "overview" }

export const ACTIVE_SESSION_HASH_KEY = "session"
export const OVERVIEW_SELECTED_SESSION_HASH_KEY = "selected-session"
export const PROJECT_ROUTE_PREFIX = "/projects"
export const PROJECT_PANE_PARAM_KEY = "pane"
export const PROJECT_FILE_PARAM_KEY = "file"
export const PROJECT_FILE_VIEW_PARAM_KEY = "view"
export const PROJECT_LINE_PARAM_KEY = "line"
export const PROJECT_COLUMN_PARAM_KEY = "column"
export const PROJECT_SESSION_PARAM_KEY = "session"

const PROJECT_PANES = new Set(["files", "search", "workbench", "source-control", "agent", "terminal"])
const PROJECT_FILE_VIEWS = new Set(["diff", "preview", "logs"])

/** @type {SettingsCredentialsRoute} */
export const settingsCredentialsRoute = { type: "settings-credentials" }

/**
 * @param {string | undefined} cwd
 * @returns {string | undefined}
 */
function cleanRouteCwd(cwd) {
	return typeof cwd === "string" && cwd ? cwd : undefined
}

/**
 * @param {string | undefined | null} id
 * @returns {string | undefined}
 */
function cleanSelectedSessionId(id) {
	return typeof id === "string" && id ? id : undefined
}

function cleanProjectRoot(path) {
	if (typeof path !== "string" || !path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(path)) return undefined
	const stack = []
	for (const part of path.split("/")) {
		if (!part || part === ".") continue
		if (part === "..") stack.pop()
		else stack.push(part)
	}
	return `/${stack.join("/")}`
}

function cleanProjectPane(value) {
	if (value === "pinano") return "agent"
	return typeof value === "string" && PROJECT_PANES.has(value) ? value : undefined
}

function cleanProjectFileView(value) {
	return typeof value === "string" && PROJECT_FILE_VIEWS.has(value) ? value : undefined
}

function cleanPositiveInteger(value) {
	const number = typeof value === "number" ? value : Number(value)
	return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function cleanProjectFile(value) {
	if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) return undefined
	const absolute = value.startsWith("/")
	const parts = value.split("/").filter(Boolean)
	if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) return undefined
	return `${absolute ? "/" : ""}${parts.join("/")}`
}

function pathWithin(root, path) {
	return root === "/" ? path.startsWith("/") : path === root || path.startsWith(`${root}/`)
}

export function projectFileForRoot(root, path) {
	const cleanedRoot = cleanProjectRoot(root)
	const cleanedPath = cleanProjectRoot(path)
	if (!cleanedRoot || !cleanedPath || cleanedPath === cleanedRoot) return undefined
	if (!pathWithin(cleanedRoot, cleanedPath)) return cleanedPath
	return cleanedRoot === "/" ? cleanedPath.slice(1) : cleanedPath.slice(cleanedRoot.length + 1)
}

/**
 * Resolve a project URL's root-relative (or explicitly absolute) file value.
 *
 * @param {string} root
 * @param {string | undefined | null} file
 * @returns {string | undefined}
 */
export function projectFilePath(root, file) {
	const cleanedRoot = cleanProjectRoot(root)
	const cleanedFile = cleanProjectFile(file)
	if (!cleanedRoot || !cleanedFile) return undefined
	if (cleanedFile.startsWith("/")) return cleanProjectRoot(cleanedFile)
	return cleanProjectRoot(`${cleanedRoot === "/" ? "" : cleanedRoot}/${cleanedFile}`)
}

function cleanProjectBrowserState(root, state = {}) {
	const cleanedRoot = cleanProjectRoot(root)
	if (!cleanedRoot) return undefined
	const pane = cleanProjectPane(state.pane)
	const file = cleanProjectFile(state.file)
	const view = file ? cleanProjectFileView(state.view) : undefined
	const line = file ? cleanPositiveInteger(state.line) : undefined
	const column = file ? cleanPositiveInteger(state.column) : undefined
	return {
		root: cleanedRoot,
		...(pane ? { pane } : {}),
		...(file ? { file } : {}),
		...(view ? { view } : {}),
		...(line && line > 1 ? { line } : {}),
		...(column && column > 1 ? { column } : {}),
	}
}

/**
 * @param {AppRoute | undefined | null} route
 * @returns {ProjectBrowserState | undefined}
 */
export function routeProjectState(route) {
	const root = cleanProjectRoot(route?.project?.root ?? route?.projectRoot)
	return root ? cleanProjectBrowserState(root, route?.project) : undefined
}

/**
 * @param {string} root
 * @param {{ pane?: ProjectPane, file?: string, view?: ProjectFileView, line?: number, column?: number, sessionId?: string }} [options]
 * @returns {OverviewRoute | SessionRoute}
 */
export function projectRoute(root, options = {}) {
	const project = cleanProjectBrowserState(root, options)
	if (!project) throw new Error("project route requires an absolute root path")
	const sessionId = cleanSelectedSessionId(options.sessionId)
	return sessionId
		? sessionRoute(sessionId, project.root, project.root, project)
		: overviewRouteForCwd(project.root, undefined, project.root, project)
}

/**
 * @param {string | undefined} selectedSessionId
 * @returns {string}
 */
function overviewSelectionHash(selectedSessionId) {
	const cleaned = cleanSelectedSessionId(selectedSessionId)
	if (!cleaned) return ""
	return new URLSearchParams({ [OVERVIEW_SELECTED_SESSION_HASH_KEY]: cleaned }).toString()
}

/**
 * @param {string} hash
 * @returns {string | undefined}
 */
export function overviewSelectedSessionIdFromHash(hash) {
	const text = hash.startsWith("#") ? hash.slice(1) : hash
	if (!text) return undefined
	return cleanSelectedSessionId(new URLSearchParams(text).get(OVERVIEW_SELECTED_SESSION_HASH_KEY))
}

/**
 * @param {string} hash
 * @returns {string | undefined}
 */
export function activeSessionIdFromHash(hash) {
	const text = hash.startsWith("#") ? hash.slice(1) : hash
	if (!text) return undefined
	const params = new URLSearchParams(text)
	return cleanSelectedSessionId(params.get(ACTIVE_SESSION_HASH_KEY))
}

/**
 * @param {string | undefined} cwd
 * @param {string | undefined} [selectedSessionId]
 * @param {string | undefined} [projectRoot]
 * @param {ProjectBrowserState | undefined} [project]
 * @returns {OverviewRoute}
 */
export function overviewRouteForCwd(cwd, selectedSessionId = undefined, projectRoot = undefined, project = undefined) {
	const cleaned = cleanRouteCwd(cwd)
	const selected = cleanSelectedSessionId(selectedSessionId)
	const projectPath = cleanProjectRoot(projectRoot)
	const projectState = cleanProjectBrowserState(project?.root ?? projectPath, project)
	if (!cleaned && !selected && !projectState) return overviewRoute
	return {
		type: "overview",
		...(cleaned ? { cwd: cleaned } : {}),
		...(selected ? { selectedSessionId: selected } : {}),
		...(projectState ? { projectRoot: projectState.root, project: projectState } : {}),
	}
}

/**
 * @param {string} id
 * @param {string | undefined} [cwd]
 * @param {string | undefined} [projectRoot]
 * @param {ProjectBrowserState | undefined} [project]
 * @returns {SessionRoute}
 */
export function sessionRoute(id, cwd = undefined, projectRoot = undefined, project = undefined) {
	const cleaned = cleanRouteCwd(cwd)
	const projectState = cleanProjectBrowserState(project?.root ?? projectRoot, project)
	return {
		type: "session",
		id,
		...(cleaned ? { cwd: cleaned } : {}),
		...(projectState ? { projectRoot: projectState.root, project: projectState } : {}),
	}
}

/**
 * @param {AppRoute} route
 * @returns {string | undefined}
 */
export function routeCwd(route) {
	return cleanRouteCwd(route?.cwd)
}

/**
 * @param {AppRoute | undefined} route
 * @returns {string | undefined}
 */
export function routeSelectedSessionId(route) {
	return route?.type === "overview" ? cleanSelectedSessionId(route.selectedSessionId) : undefined
}

/**
 * @param {string} path
 * @param {string | undefined} cwd
 * @returns {string}
 */
function pathWithCwd(path, cwd) {
	const cleaned = cleanRouteCwd(cwd)
	if (!cleaned) return path
	const params = new URLSearchParams({ cwd: cleaned })
	return `${path}?${params}`
}

function encodePathForUrl(path) {
	return path.split("/").map(encodeURIComponent).join("/")
}

function browsePathWithCwd(cwd) {
	const cleaned = cleanRouteCwd(cwd)
	if (!cleaned) return "/browse"
	return `/browse/local${cleaned === "/" ? "" : encodePathForUrl(cleaned)}`
}

function parentPath(path) {
	if (!path || path === "/") return "/"
	const index = path.lastIndexOf("/")
	return index <= 0 ? "/" : path.slice(0, index)
}

function parseExplorerPath(url, prefix) {
	if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null
	const rest = url.pathname.slice(prefix.length).replace(/^\/+/, "")
	if (!rest) return { cwd: undefined, server: undefined }
	const slash = rest.indexOf("/")
	let server
	let path
	try {
		server = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash))
		path = slash < 0 ? "/" : cleanProjectRoot(`/${decodeURIComponent(rest.slice(slash + 1))}`)
	} catch {
		return null
	}
	if (server !== "local") return { cwd: undefined, server }
	return { cwd: prefix === "/view" ? parentPath(path) : path, server }
}

function projectPathForRoute(route, project) {
	const pathname = `${PROJECT_ROUTE_PREFIX}${project.root === "/" ? "/" : encodePathForUrl(project.root)}`
	const params = new URLSearchParams()
	const pane = project.pane ?? (project.file ? "workbench" : route.type === "session" ? "agent" : undefined)
	if (pane) params.set(PROJECT_PANE_PARAM_KEY, pane)
	if (project.file) params.set(PROJECT_FILE_PARAM_KEY, project.file)
	if (project.view) params.set(PROJECT_FILE_VIEW_PARAM_KEY, project.view)
	if (project.line) params.set(PROJECT_LINE_PARAM_KEY, String(project.line))
	if (project.column) params.set(PROJECT_COLUMN_PARAM_KEY, String(project.column))
	if (route.type === "session") params.set(PROJECT_SESSION_PARAM_KEY, route.id)
	let query = params.toString()
	if (project.file) {
		const encodedFile = new URLSearchParams({ [PROJECT_FILE_PARAM_KEY]: project.file }).toString()
		query = query.replace(encodedFile, encodedFile.replace(/%2F/gi, "/"))
	}
	return query ? `${pathname}?${query}` : pathname
}

function projectStateFromUrl(url, root) {
	const file = cleanProjectFile(url.searchParams.get(PROJECT_FILE_PARAM_KEY))
	const pane = cleanProjectPane(url.searchParams.get(PROJECT_PANE_PARAM_KEY)) ?? (file ? "workbench" : undefined)
	return cleanProjectBrowserState(root, {
		pane,
		file,
		view: url.searchParams.get(PROJECT_FILE_VIEW_PARAM_KEY),
		line: url.searchParams.get(PROJECT_LINE_PARAM_KEY),
		column: url.searchParams.get(PROJECT_COLUMN_PARAM_KEY),
	})
}

function parseProjectRoute(url) {
	if (url.pathname !== PROJECT_ROUTE_PREFIX && !url.pathname.startsWith(`${PROJECT_ROUTE_PREFIX}/`)) return null
	let root
	try {
		const suffix = url.pathname.slice(PROJECT_ROUTE_PREFIX.length)
		root = cleanProjectRoot(suffix ? decodeURIComponent(suffix) : "/")
	} catch {
		return null
	}
	if (!root) return null
	const project = projectStateFromUrl(url, root)
	const sessionId = cleanSelectedSessionId(url.searchParams.get(PROJECT_SESSION_PARAM_KEY))
	return sessionId
		? sessionRoute(sessionId, root, root, { ...project, pane: project?.pane ?? "agent" })
		: overviewRouteForCwd(root, undefined, root, project)
}

/**
 * @param {AppRoute} route
 * @returns {string}
 */
export function routeToArg(route) {
	const project = routeProjectState(route)
	if (project) return projectPathForRoute(route, project)
	if (route.type === "overview") {
		const path = browsePathWithCwd(route.cwd)
		const hash = overviewSelectionHash(route.selectedSessionId)
		return hash ? `${path}#${hash}` : path
	}
	if (route.type === "session") {
		if (cleanRouteCwd(route.cwd)) {
			const params = new URLSearchParams({ [ACTIVE_SESSION_HASH_KEY]: route.id })
			return `${browsePathWithCwd(route.cwd)}#${params}`
		}
		return pathWithCwd(`/sessions/${encodeURIComponent(route.id)}`, route.cwd)
	}
	if (route.type === "settings-credentials") return "/settings/credentials"
	throw new Error(`Unknown application route: ${JSON.stringify(route)}`)
}

/**
 * @param {AppRoute} route
 * @returns {string[]}
 */
export function routeToCliArgs(route) {
	return ["open", routeToArg(route)]
}

/**
 * @param {string} value
 * @returns {AppRoute | null}
 */
function parseUrlRoute(value) {
	if (!value.startsWith("/")) return null
	let url
	try {
		url = new URL(value, "http://cerex.local")
	} catch {
		return null
	}
	const cwd = url.searchParams.get("cwd") || undefined
	const activeSessionId = activeSessionIdFromHash(url.hash)
	const selectedSessionId = overviewSelectedSessionIdFromHash(url.hash)
	const canonicalProjectRoute = parseProjectRoute(url)
	if (canonicalProjectRoute) return canonicalProjectRoute
	if (url.pathname === "/" || url.pathname === "/sessions" || url.pathname === "/sessions/") return overviewRouteForCwd(cwd, selectedSessionId)
	for (const prefix of ["/browse", "/view", "/diff"]) {
		const explorer = parseExplorerPath(url, prefix)
		if (!explorer) continue
		if (explorer.server && explorer.server !== "local") return overviewRoute
		return activeSessionId
			? sessionRoute(activeSessionId, explorer.cwd)
			: overviewRouteForCwd(explorer.cwd, selectedSessionId)
	}
	if (url.pathname === "/settings/credentials") return settingsCredentialsRoute
	const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)\/?$/) ?? url.pathname.match(/^\/chat\/([^/]+)\/?$/)
	if (sessionMatch) return sessionRoute(decodeURIComponent(sessionMatch[1]), cwd)
	return null
}

/**
 * @param {string | undefined} arg
 * @returns {AppRoute}
 */
export function parseRouteArg(arg) {
	if (!arg) throw new Error("open requires a route: /projects/<path>, /browse, /sessions/<id>, or /settings/credentials")
	const urlRoute = parseUrlRoute(arg)
	if (urlRoute) return urlRoute
	throw new Error(`Unknown route "${arg}". Use /projects/<path>, /browse, /sessions/<id>, or /settings/credentials.`)
}
