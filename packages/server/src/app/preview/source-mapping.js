import { isAbsolute, relative, resolve, sep } from "node:path"

function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function sourceRelativePath(sourceRoot, path) {
	const value = relative(resolve(sourceRoot), resolve(path))
	if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) return undefined
	return value.split(sep).join("/")
}

function routePathname(value) {
	try {
		const pathname = new URL(value, "http://preview.invalid").pathname
		return pathname === "/" ? pathname : pathname.replace(/\/+$/, "")
	} catch {
		return undefined
	}
}

function decodeSegment(value) {
	try {
		return decodeURIComponent(value)
	} catch {
		return undefined
	}
}

function routeMatch(mapping, pathname) {
	const routeParts = mapping.route === "/" ? [] : mapping.route.slice(1).split("/")
	const pathParts = pathname === "/" ? [] : pathname.replace(/^\//, "").replace(/\/$/, "").split("/")
	const captures = {}
	for (let index = 0; index < routeParts.length; index++) {
		const routePart = routeParts[index]
		if (routePart.startsWith("*")) {
			if (index >= pathParts.length) return undefined
			const values = pathParts.slice(index).map(decodeSegment)
			if (values.some((value) => value === undefined)) return undefined
			captures[routePart.slice(1)] = values.join("/")
			return captures
		}
		const value = decodeSegment(pathParts[index])
		if (value === undefined) return undefined
		if (routePart.startsWith(":")) {
			if (!value || value.includes("/")) return undefined
			captures[routePart.slice(1)] = value
		}
		else if (routePart !== value) return undefined
	}
	return pathParts.length === routeParts.length ? captures : undefined
}

function fillTemplate(template, captures, encode) {
	return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name) => encode(captures[name]))
}

function sourceFromRoute(sourceRoot, mapping, captures) {
	const relativePath = fillTemplate(mapping.source, captures, (value) => value)
	const path = resolve(sourceRoot, relativePath)
	return sourceRelativePath(sourceRoot, path) === relativePath ? path : undefined
}

function sourceTemplateMatch(mapping, value) {
	const template = mapping.source
	const wildcardNames = new Set(mapping.route.split("/").filter((part) => part.startsWith("*")).map((part) => part.slice(1)))
	const names = []
	let source = "^"
	let cursor = 0
	for (const match of template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
		source += escapeRegex(template.slice(cursor, match.index))
		names.push(match[1])
		source += wildcardNames.has(match[1]) ? "(.+?)" : "([^/]+?)"
		cursor = match.index + match[0].length
	}
	source += `${escapeRegex(template.slice(cursor))}$`
	const match = new RegExp(source).exec(value)
	if (!match) return undefined
	return Object.fromEntries(names.map((name, index) => [name, match[index + 1]]))
}

function pathFromMapping(mapping, captures) {
	const names = mapping.route.split("/")
		.filter((part) => part.startsWith(":") || part.startsWith("*"))
		.map((part) => part.slice(1))
	if (names.some((name) => !Object.prototype.hasOwnProperty.call(captures, name) || !captures[name])) return undefined
	const path = mapping.route
		.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, name) => encodeURIComponent(captures[name]))
		.replace(/\*([A-Za-z][A-Za-z0-9_]*)/g, (_match, name) => String(captures[name]).split("/").map(encodeURIComponent).join("/"))
	return path
}

export function previewSourcePathForRoute(definition, value, sourceRoot = definition?.projectDir) {
	if (!sourceRoot) return undefined
	const pathname = routePathname(value)
	if (!pathname) return undefined
	for (const mapping of definition.routeSourceMap ?? []) {
		const captures = routeMatch(mapping, pathname)
		if (captures) return sourceFromRoute(sourceRoot, mapping, captures)
	}
	return undefined
}

export function previewPathForSource(definition, sourcePath, sourceRoot = definition?.projectDir) {
	if (!sourceRoot) return undefined
	const relativePath = sourceRelativePath(sourceRoot, sourcePath)
	if (!relativePath) return undefined
	for (const mapping of definition.routeSourceMap ?? []) {
		const captures = sourceTemplateMatch(mapping, relativePath)
		if (captures) {
			const path = pathFromMapping(mapping, captures)
			if (path) return path
		}
	}
	return undefined
}

export function previewMatchesSource(definition, sourcePath, sourceRoot = definition?.projectDir) {
	if (!definition) return false
	const configPath = definition.configPath ?? definition.source?.configPath
	if (configPath && resolve(sourcePath) === resolve(configPath)) return true
	return previewPathForSource(definition, sourcePath, sourceRoot) !== undefined
}

export function previewDefinitionForSource(definitions, sourcePath, sourceRoot = undefined) {
	const matches = definitions.filter((definition) => {
		if (definition.kind !== "static") return previewMatchesSource(definition, sourcePath, sourceRoot ?? definition.projectDir)
		return definition.source?.path && sourceRelativePath(definition.source.path, sourcePath) !== undefined
	})
	if (matches.length <= 1) return matches[0]
	const staticMatches = matches.filter((definition) => definition.kind === "static")
	if (staticMatches.length === matches.length) {
		return staticMatches.sort((a, b) => b.source.path.length - a.source.path.length)[0]
	}
	throw Object.assign(new Error(`Source file matches multiple previews: ${matches.map((definition) => definition.name).join(", ")}`), { status: 409 })
}

export function previewEntryPathForSource(definition, sourcePath, sourceRoot = definition?.projectDir) {
	const fallback = definition.entryPath ?? "/"
	if (definition.kind === "process") return previewPathForSource(definition, sourcePath, sourceRoot) ?? fallback
	if (definition.kind !== "static" || !definition.source?.path) return fallback
	const relativePath = sourceRelativePath(definition.source.path, sourcePath)
	return relativePath ? `/${relativePath.split("/").map(encodeURIComponent).join("/")}` : fallback
}
