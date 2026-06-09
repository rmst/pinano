import { statSync } from "node:fs"
import { basename, isAbsolute, resolve } from "node:path"

const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"])
const SHELL_SEPARATORS = new Set(["|", "||", "&&", ";"])
const FULL_OUTPUT_COMMANDS = new Set(["cat", "bat", "batcat", "less", "more", "nl"])
const FILE_READ_COMMANDS = new Set([
	...FULL_OUTPUT_COMMANDS,
	"awk",
	"grep",
	"head",
	"rg",
	"sed",
	"tail",
])
const OPTIONS_WITH_VALUES = new Set([
	"-A",
	"-B",
	"-C",
	"-e",
	"-g",
	"-m",
	"-t",
	"--after-context",
	"--before-context",
	"--context",
	"--file",
	"--glob",
	"--max-count",
	"--regexp",
	"--type",
])
const COMMAND_OPTIONS_WITH_VALUES = new Map([
	["awk", new Set(["-f"])],
	["grep", new Set(["-f"])],
	["rg", new Set(["-f"])],
	["sed", new Set(["-f"])],
])
const COMMAND_OPTION_NAMES_WITH_VALUES = new Set(["-f"])
const PATTERN_ARGUMENT_OPTIONS = new Set(["-e", "-f", "--file", "--regexp"])

function commandName(token) {
	return basename(token).toLowerCase()
}

function isAssignment(token) {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

function isShellSeparator(token) {
	return SHELL_SEPARATORS.has(token)
}

function isRedirectionToken(token) {
	return /^(?:\d*)?>/.test(token) || token === "<" || token.startsWith("<") || token === "2>&1"
}

function hasOutputRedirection(tokens) {
	return tokens.some((token) => /^(?:1)?>/.test(token) || token === "&>" || token === "&>>")
}

function shellWords(command) {
	/** @type {string[]} */
	const words = []
	let word = ""
	let quote = ""
	const push = () => {
		if (word.length > 0) {
			words.push(word)
			word = ""
		}
	}
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]
		if (quote) {
			if (ch === quote) {
				quote = ""
			} else if (quote === "\"" && ch === "\\" && i + 1 < command.length) {
				word += command[++i]
			} else {
				word += ch
			}
			continue
		}
		if (ch === "'" || ch === "\"") {
			quote = ch
			continue
		}
		if (ch === "\\" && i + 1 < command.length) {
			word += command[++i]
			continue
		}
		if (ch === "\n") {
			push()
			words.push(";")
			continue
		}
		if (/\s/.test(ch)) {
			push()
			continue
		}
		if (ch === "&" && command[i + 1] === "&") {
			push()
			words.push("&&")
			i++
			continue
		}
		if (ch === "|" && command[i + 1] === "|") {
			push()
			words.push("||")
			i++
			continue
		}
		if (ch === "|" || ch === ";") {
			push()
			words.push(ch)
			continue
		}
		word += ch
	}
	push()
	return words
}

function commandSegments(command) {
	/** @type {{ tokens: string[], pipedToNext: boolean }[]} */
	const segments = []
	let tokens = []
	for (const word of shellWords(command)) {
		if (isShellSeparator(word)) {
			if (tokens.length > 0) segments.push({ tokens, pipedToNext: word === "|" })
			tokens = []
		} else {
			tokens.push(word)
		}
	}
	if (tokens.length > 0) segments.push({ tokens, pipedToNext: false })
	return segments
}

function commandStart(tokens) {
	let i = 0
	while (i < tokens.length && isAssignment(tokens[i])) i++
	if (tokens[i] === "env") {
		i++
		while (i < tokens.length && isAssignment(tokens[i])) i++
	}
	return i
}

function isLiteralPathToken(token) {
	if (!token || token === "-" || token.startsWith("-")) return false
	if (/^[0-9]+$/.test(token)) return false
	if (/[$`*?[\]{}]/.test(token)) return false
	if (/^[a-z]+:\/\//i.test(token)) return false
	if (isRedirectionToken(token)) return false
	return true
}

function shellOptionName(token) {
	if (token.startsWith("--")) return token.includes("=") ? token.slice(0, token.indexOf("=")) : token
	if (token.length > 2) {
		const shortName = token.slice(0, 2)
		if (OPTIONS_WITH_VALUES.has(shortName) || COMMAND_OPTION_NAMES_WITH_VALUES.has(shortName)) return shortName
	}
	return token
}

function optionTakesSeparateValue(command, token, name) {
	if (token !== name) return false
	return OPTIONS_WITH_VALUES.has(name) || COMMAND_OPTIONS_WITH_VALUES.get(command)?.has(name) === true
}

function collectPositionals(tokens, start, command) {
	/** @type {string[]} */
	const out = []
	/** @type {Set<string>} */
	const options = new Set()
	for (let i = start; i < tokens.length; i++) {
		const token = tokens[i]
		if (token === "--") {
			out.push(...tokens.slice(i + 1).filter(isLiteralPathToken))
			break
		}
		if (isRedirectionToken(token)) {
			i++
			continue
		}
		if (token.startsWith("-")) {
			const name = shellOptionName(token)
			options.add(name)
			if (optionTakesSeparateValue(command, token, name)) i++
			continue
		}
		if (isLiteralPathToken(token)) out.push(token)
	}
	return { out, options }
}

function pathTokensForSegment(tokens) {
	const start = commandStart(tokens)
	if (start >= tokens.length) return { command: "", tokens: [] }
	const command = commandName(tokens[start])
	if (!FILE_READ_COMMANDS.has(command)) return { command, tokens: [] }
	if (command === "grep" || command === "rg") {
		const { out, options } = collectPositionals(tokens, start + 1, command)
		if (command === "rg" && options.has("--files")) return { command, tokens: [] }
		const patternPassedByOption = [...options].some((option) => PATTERN_ARGUMENT_OPTIONS.has(option))
		return { command, tokens: patternPassedByOption ? out : out.slice(1) }
	}
	if (command === "sed" || command === "awk") {
		const { out, options } = collectPositionals(tokens, start + 1, command)
		const scriptPassedByOption = [...options].some((option) => option === "-e" || option === "-f" || option === "--file")
		return { command, tokens: scriptPassedByOption ? out : out.slice(1) }
	}
	return { command, tokens: collectPositionals(tokens, start + 1, command).out }
}

function existingShellFilePath(token, cwd) {
	const abs = isAbsolute(token) ? token : resolve(cwd, token)
	try {
		return statSync(abs).isFile() ? abs : null
	} catch {
		return null
	}
}

function isContextFilePath(path) {
	return CONTEXT_FILE_NAMES.has(basename(path))
}

/**
 * Best-effort extraction of literal filesystem paths from common shell file read commands. This deliberately ignores variables, globs, command substitution, directories, and non-existing paths to avoid surprising context injections from broad discovery commands.
 *
 * @param {string} command
 * @param {string} cwd
 * @returns {{ paths: string[], manuallyLoadedContextPaths: string[] }}
 */
export function extractShellCommandPathInfo(command, cwd) {
	/** @type {string[]} */
	const paths = []
	/** @type {string[]} */
	const manuallyLoadedContextPaths = []
	for (const segment of commandSegments(command)) {
		const extracted = pathTokensForSegment(segment.tokens)
		const segmentPaths = hasOutputRedirection(segment.tokens)
			? []
			: extracted.tokens
				.map((token) => existingShellFilePath(token, cwd))
				.filter((path) => typeof path === "string")
		paths.push(...segmentPaths)
		if (FULL_OUTPUT_COMMANDS.has(extracted.command) && !segment.pipedToNext && !hasOutputRedirection(segment.tokens)) {
			manuallyLoadedContextPaths.push(...segmentPaths.filter(isContextFilePath))
		}
	}
	return { paths, manuallyLoadedContextPaths }
}
