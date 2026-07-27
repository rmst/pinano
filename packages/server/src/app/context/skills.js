import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

import { insertContextAfterLatestResponsesCompaction } from "../../../../protocol/src/responses-compaction.js"
import { optionalProductHomePath } from "../paths.js"

const SKILL_FILENAME = "SKILL.md"
const SKILLS_DIR_NAME = "skills"
const AGENTS_DIR_NAME = ".agents"
const MAX_SCAN_DEPTH = 6
const MAX_SKILLS_DIRS_PER_ROOT = 2000
const MAX_NAME_LEN = 64
const MAX_DESCRIPTION_LEN = 1024
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,63}$/
const COMMON_ENV_VARS = new Set(["PATH", "HOME", "USER", "SHELL", "PWD", "TMPDIR", "TEMP", "TMP", "LANG", "TERM", "XDG_CONFIG_HOME"])

/**
 * @typedef {"repo" | "user"} SkillScope
 * @typedef {{ path: string, scope: SkillScope }} SkillRoot
 * @typedef {{ name: string, description: string, path: string, dir: string, root: string, scope: SkillScope }} SkillMetadata
 * @typedef {{ path: string, message: string }} SkillError
 * @typedef {{ skills: SkillMetadata[], errors: SkillError[], roots: SkillRoot[] }} SkillLoadOutcome
 * @typedef {{ availableMessage?: any, skillMessages: any[], selectedPaths: Set<string>, loadOutcome: SkillLoadOutcome, mentionedNames: string[], unresolvedMentions: string[] }} SkillsContext
 */

function realpathOrSelf(path) {
	try {
		return realpathSync(path)
	} catch {
		return resolve(path)
	}
}

function safeStat(path) {
	try {
		return statSync(path)
	} catch {
		return undefined
	}
}

function safeLstat(path) {
	try {
		return lstatSync(path)
	} catch {
		return undefined
	}
}

function fileIsReadable(path) {
	try {
		return statSync(path).isFile()
	} catch {
		return false
	}
}

function ancestorsRootFirst(cwd, root = "/") {
	const boundary = resolve(root)
	const resolvedCwd = resolve(cwd)
	const rel = relative(boundary, resolvedCwd)
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Skills cwd is outside its root: ${resolvedCwd}`)
	const dirs = []
	for (let dir = resolvedCwd;;) {
		dirs.unshift(dir)
		if (dir === boundary) break
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return dirs
}

/** @param {string} cwd @param {{ root?: string }} [options] @returns {SkillRoot[]} */
export function projectSkillRoots(cwd, options = {}) {
	const roots = []
	for (const dir of ancestorsRootFirst(cwd, options.root)) {
		const path = join(dir, AGENTS_DIR_NAME, SKILLS_DIR_NAME)
		if (safeStat(path)?.isDirectory()) roots.push({ path, scope: "repo" })
	}
	return dedupeRoots(roots)
}

/** @returns {SkillRoot[]} */
export function userSkillRoots() {
	const roots = []
	const productHome = optionalProductHomePath()
	if (productHome) roots.push({ path: join(productHome, SKILLS_DIR_NAME), scope: "user" })
	roots.push({ path: join(homedir(), AGENTS_DIR_NAME, SKILLS_DIR_NAME), scope: "user" })
	return dedupeRoots(roots)
}

/** @param {string} cwd @returns {SkillRoot[]} */
export function defaultSkillRoots(cwd) {
	return dedupeRoots([...projectSkillRoots(cwd), ...userSkillRoots()])
}

/** @param {SkillRoot[]} roots */
function dedupeRoots(roots) {
	const seen = new Set()
	return roots.filter((root) => {
		const key = realpathOrSelf(root.path)
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

function frontmatterEnd(lines) {
	for (let i = 1; i < lines.length; i++) {
		if (/^---\s*$/.test(lines[i])) return i
	}
	return -1
}

function parseQuotedString(value) {
	if (value.length < 2) return undefined
	const quote = value[0]
	if ((quote !== "\"" && quote !== "'") || value.at(-1) !== quote) return undefined
	const inner = value.slice(1, -1)
	if (quote === "'") return inner.replace(/''/g, "'")
	return inner.replace(/\\(["\\/bfnrt])/g, (_match, ch) => ({
		"\"": "\"",
		"\\": "\\",
		"/": "/",
		b: "\b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
	})[ch] ?? ch)
}

function scalarLineValue(value) {
	const trimmed = value.trim()
	if (!trimmed) return ""
	const quoted = parseQuotedString(trimmed)
	return quoted ?? trimmed
}

function indentation(line) {
	return line.match(/^[ \t]*/)?.[0].replace(/\t/g, "  ").length ?? 0
}

function blockScalarValue(lines, startIndex, parentIndent, folded) {
	const body = []
	let i = startIndex + 1
	for (; i < lines.length; i++) {
		const line = lines[i]
		if (line.trim() && indentation(line) <= parentIndent) break
		body.push(line.slice(Math.min(line.length, parentIndent + 2)))
	}
	const text = folded
		? body.join("\n").split(/\n{2,}/).map((part) => part.replace(/\n/g, " ")).join("\n\n")
		: body.join("\n")
	return { value: text.trimEnd(), nextIndex: i - 1 }
}

/** Parse the small YAML subset Cerex needs from SKILL.md frontmatter. */
export function parseSkillFrontmatter(content) {
	const normalized = content.replace(/\r\n?/g, "\n")
	const lines = normalized.split("\n")
	if (!/^---\s*$/.test(lines[0] ?? "")) throw new Error("missing YAML frontmatter delimited by ---")
	const end = frontmatterEnd(lines)
	if (end < 0) throw new Error("missing closing YAML frontmatter delimiter")
	const frontmatterLines = lines.slice(1, end)
	const data = {}
	const path = []
	for (let i = 0; i < frontmatterLines.length; i++) {
		const raw = frontmatterLines[i]
		if (!raw.trim() || raw.trimStart().startsWith("#")) continue
		const match = /^([ \t]*)([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$/.exec(raw)
		if (!match) continue
		const indent = indentation(match[1])
		const key = match[2]
		const value = match[3] ?? ""
		while (path.length > 0 && path[path.length - 1].indent >= indent) path.pop()
		const fullKey = [...path.map((item) => item.key), key].join(".")
		if (value.trim() === "") {
			path.push({ key, indent })
			continue
		}
		if (/^[>|]/.test(value.trim())) {
			const folded = value.trim().startsWith(">")
			const block = blockScalarValue(frontmatterLines, i, indent, folded)
			data[fullKey] = block.value
			i = block.nextIndex
			continue
		}
		data[fullKey] = scalarLineValue(value)
	}
	return {
		name: data.name,
		description: data.description,
		shortDescription: data["metadata.short-description"],
	}
}

function validateSkillMetadata(path, metadata) {
	const name = String(metadata.name ?? basename(dirname(path))).trim()
	if (!name) throw new Error("missing field `name`")
	if (!SKILL_NAME_RE.test(name)) throw new Error("invalid name: use 1-64 letters, numbers, _, - or :, starting with a letter or number")
	const description = String(metadata.description ?? "").replace(/\s+/g, " ").trim()
	if (description.length > MAX_DESCRIPTION_LEN) throw new Error(`invalid description: must be at most ${MAX_DESCRIPTION_LEN} characters`)
	if (name.length > MAX_NAME_LEN) throw new Error(`invalid name: must be at most ${MAX_NAME_LEN} characters`)
	const resolvedPath = realpathOrSelf(path)
	return {
		name,
		description,
		path: resolvedPath,
		dir: dirname(resolvedPath),
	}
}

function parseSkillFile(path, root) {
	const content = readFileSync(path, "utf-8")
	const parsed = validateSkillMetadata(path, parseSkillFrontmatter(content))
	return {
		...parsed,
		root: realpathOrSelf(root.path),
		scope: root.scope,
	}
}

function discoverSkillsUnderRoot(root, outcome, allowPath = () => true) {
	const rootPath = realpathOrSelf(root.path)
	if (!allowPath(rootPath)) {
		outcome.errors.push({ path: rootPath, message: "skills directory is outside the workspace root" })
		return
	}
	if (!safeStat(rootPath)?.isDirectory()) return
	const queue = [{ path: rootPath, depth: 0 }]
	const visited = new Set([rootPath])
	while (queue.length > 0) {
		const current = queue.shift()
		if (!current) break
		if (!allowPath(current.path)) continue
		let entries
		try {
			entries = readdirSync(current.path, { withFileTypes: true })
		} catch (err) {
			outcome.errors.push({ path: current.path, message: `failed to read skills directory: ${err?.message ?? err}` })
			continue
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue
			const path = join(current.path, entry.name)
			const lst = safeLstat(path)
			const isDir = entry.isDirectory() || (lst?.isSymbolicLink() && safeStat(path)?.isDirectory())
			if (isDir) {
				if (current.depth >= MAX_SCAN_DEPTH || visited.size >= MAX_SKILLS_DIRS_PER_ROOT) continue
				const resolved = realpathOrSelf(path)
				if (allowPath(resolved) && !visited.has(resolved)) {
					visited.add(resolved)
					queue.push({ path: resolved, depth: current.depth + 1 })
				}
				continue
			}
			if (entry.name !== SKILL_FILENAME || !fileIsReadable(path)) continue
			try {
				if (!allowPath(realpathOrSelf(path))) continue
				outcome.skills.push(parseSkillFile(path, { ...root, path: rootPath }))
			} catch (err) {
				outcome.errors.push({ path, message: err?.message ?? String(err) })
			}
		}
	}
}

function skillSortKey(skill) {
	const scopeRank = skill.scope === "repo" ? 0 : 1
	return [scopeRank, skill.name, skill.path]
}

function compareSkill(a, b) {
	const ak = skillSortKey(a)
	const bk = skillSortKey(b)
	for (let i = 0; i < ak.length; i++) {
		if (ak[i] < bk[i]) return -1
		if (ak[i] > bk[i]) return 1
	}
	return 0
}

/** @param {string} cwd @param {{ roots?: SkillRoot[], allowPath?: (path: string) => boolean }} [options] @returns {SkillLoadOutcome} */
export function loadSkillsForCwd(cwd, options = {}) {
	const roots = dedupeRoots(options.roots ?? defaultSkillRoots(cwd))
	const outcome = { skills: [], errors: [], roots }
	for (const root of roots) discoverSkillsUnderRoot(root, outcome, options.allowPath)
	const seenPaths = new Set()
	outcome.skills = outcome.skills
		.filter((skill) => {
			if (seenPaths.has(skill.path)) return false
			seenPaths.add(skill.path)
			return true
		})
		.sort(compareSkill)
	return outcome
}

/** @param {...SkillLoadOutcome} outcomes @returns {SkillLoadOutcome} */
export function mergeSkillLoadOutcomes(...outcomes) {
	const roots = dedupeRoots(outcomes.flatMap((outcome) => outcome?.roots ?? []))
	const seenSkills = new Set()
	const skills = outcomes
		.flatMap((outcome) => outcome?.skills ?? [])
		.filter((skill) => {
			if (seenSkills.has(skill.path)) return false
			seenSkills.add(skill.path)
			return true
		})
		.sort(compareSkill)
	const seenErrors = new Set()
	const errors = outcomes
		.flatMap((outcome) => outcome?.errors ?? [])
		.filter((error) => {
			const key = `${error.path}\0${error.message}`
			if (seenErrors.has(key)) return false
			seenErrors.add(key)
			return true
		})
	return { skills, errors, roots }
}

function xmlText(value) {
	return String(value ?? "").replace(/[&<>]/g, (ch) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
	})[ch])
}

function availableSkillsText(skills) {
	if (skills.length === 0) return ""
	return [
		"<skills_instructions>",
		"## Skills",
		"A skill is a set of local instructions stored in a `SKILL.md` file. Below is the list of skills available in this session.",
		"### Available skills",
		...skills.map((skill) => skill.description ? `- ${skill.name}: ${skill.description} (file: ${skill.path})` : `- ${skill.name}: (file: ${skill.path})`),
		"### How to use skills",
		"- If the user names a skill with `$skill-name` or plain text, use that skill for this turn.",
		"- If the task clearly matches a listed skill's description, use the minimal matching skill set.",
		"- Before taking task actions with a skill, read its complete `SKILL.md` unless the full body is already provided in a `<skill>` context block.",
		"- Resolve relative paths mentioned by `SKILL.md` from the skill directory. Open referenced files in `references/` when the skill asks for them, run scripts from `scripts/` with normal shell tools when useful, and reuse files in `assets/` when the skill asks for them.",
		"- Do not carry skills across turns unless re-mentioned or still directly relevant to the active turn.",
		"</skills_instructions>",
	].join("\n")
}

/** @param {SkillMetadata[]} skills */
export function availableSkillsMessage(skills) {
	const text = availableSkillsText(skills)
	if (!text) return undefined
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		skillContext: true,
	}
}

/** @param {string} text */
export function extractSkillMentions(text) {
	const mentions = []
	const seen = new Set()
	for (const match of String(text ?? "").matchAll(/(^|[^A-Za-z0-9_])\$([A-Za-z0-9][A-Za-z0-9_:-]{0,63})(?![A-Za-z0-9_:-])/g)) {
		const name = match[2]
		if (COMMON_ENV_VARS.has(name.toUpperCase())) continue
		if (seen.has(name)) continue
		seen.add(name)
		mentions.push(name)
	}
	return mentions
}

function skillCountsByName(skills) {
	const counts = new Map()
	for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1)
	return counts
}

/** @param {string[]} names @param {SkillMetadata[]} skills */
export function resolveMentionedSkills(names, skills) {
	const counts = skillCountsByName(skills)
	const selected = []
	const unresolved = []
	for (const name of names) {
		if (counts.get(name) !== 1) {
			unresolved.push(name)
			continue
		}
		const skill = skills.find((candidate) => candidate.name === name)
		if (skill) selected.push(skill)
	}
	return { selected, unresolved }
}

/** @param {SkillMetadata} skill */
export function skillInjectionMessage(skill, contents = readFileSync(skill.path, "utf-8")) {
	return {
		role: "user",
		content: [{
			type: "text",
			text: `<skill>\n<name>${xmlText(skill.name)}</name>\n<path>${xmlText(skill.path)}</path>\n${contents}\n</skill>`,
		}],
		timestamp: Date.now(),
		skillContext: true,
		skillPath: skill.path,
	}
}

function failedSkillLoad(path, err, roots = []) {
	return { skills: [], errors: [{ path, message: err?.message ?? String(err) }], roots }
}

/**
 * Combine host-owned project skills with service-owned user skills, then construct model context in the service.
 * @param {string} cwd
 * @param {string} promptText
 * @param {any} workspace
 * @param {{ userRoots?: SkillRoot[] }} [options]
 * @returns {Promise<SkillsContext>}
 */
export async function buildWorkspaceSkillsContextForPrompt(cwd, promptText, workspace, options = {}) {
	const resolvedCwd = isAbsolute(cwd) ? cwd : resolve(cwd)
	let projectOutcome
	try {
		projectOutcome = await workspace.context.loadProjectSkills(resolvedCwd)
	} catch (err) {
		projectOutcome = failedSkillLoad(resolvedCwd, err)
	}
	const roots = options.userRoots ?? userSkillRoots()
	let userOutcome
	try {
		userOutcome = loadSkillsForCwd(resolvedCwd, { roots })
	} catch (err) {
		userOutcome = failedSkillLoad(resolvedCwd, err, roots)
	}
	const loadOutcome = mergeSkillLoadOutcomes(projectOutcome, userOutcome)
	const mentionedNames = extractSkillMentions(promptText)
	const { selected, unresolved } = resolveMentionedSkills(mentionedNames, loadOutcome.skills)
	const skillMessages = []
	const selectedPaths = new Set()
	for (const skill of selected) {
		try {
			const contents = skill.scope === "repo"
				? await workspace.context.readProjectSkill(resolvedCwd, skill.path)
				: readFileSync(skill.path, "utf-8")
			skillMessages.push(skillInjectionMessage(skill, contents))
			selectedPaths.add(skill.path)
		} catch {
			unresolved.push(skill.name)
		}
	}
	return {
		availableMessage: availableSkillsMessage(loadOutcome.skills),
		skillMessages,
		selectedPaths,
		loadOutcome,
		mentionedNames,
		unresolvedMentions: [...new Set(unresolved)],
	}
}

/** @param {string} cwd @param {string} promptText @param {{ roots?: SkillRoot[] }} [options] @returns {SkillsContext} */
export function buildSkillsContextForPrompt(cwd, promptText, options = {}) {
	const resolvedCwd = isAbsolute(cwd) ? cwd : resolve(cwd)
	let loadOutcome
	try {
		loadOutcome = loadSkillsForCwd(resolvedCwd, options)
	} catch (err) {
		loadOutcome = failedSkillLoad(resolvedCwd, err, options.roots ?? [])
	}
	const mentionedNames = extractSkillMentions(promptText)
	const { selected, unresolved } = resolveMentionedSkills(mentionedNames, loadOutcome.skills)
	const skillMessages = []
	const selectedPaths = new Set()
	for (const skill of selected) {
		try {
			skillMessages.push(skillInjectionMessage(skill))
			selectedPaths.add(skill.path)
		} catch {
			unresolved.push(skill.name)
		}
	}
	return {
		availableMessage: availableSkillsMessage(loadOutcome.skills),
		skillMessages,
		selectedPaths,
		loadOutcome,
		mentionedNames,
		unresolvedMentions: unresolved,
	}
}

/** @param {SkillsContext | undefined} context */
export function skillsContextMessages(context) {
	if (!context) return []
	return [context.availableMessage, ...(context.skillMessages ?? [])].filter(Boolean)
}

/** @param {SkillsContext | undefined} current @param {SkillsContext} next @returns {SkillsContext} */
export function mergeSkillsContext(current, next) {
	if (!current) return next
	const selectedPaths = new Set(current.selectedPaths)
	const skillMessages = [...current.skillMessages]
	for (const message of next.skillMessages) {
		const path = message?.skillPath ?? ""
		if (path && selectedPaths.has(path)) continue
		if (path) selectedPaths.add(path)
		skillMessages.push(message)
	}
	return {
		...next,
		availableMessage: next.availableMessage ?? current.availableMessage,
		skillMessages,
		selectedPaths,
		mentionedNames: [...new Set([...current.mentionedNames, ...next.mentionedNames])],
		unresolvedMentions: [...new Set([...current.unresolvedMentions, ...next.unresolvedMentions])],
	}
}

/** @param {SkillsContext | undefined} context @param {any[]} messages */
export function prependSkillsContext(context, messages) {
	return insertContextAfterLatestResponsesCompaction(skillsContextMessages(context), messages)
}
