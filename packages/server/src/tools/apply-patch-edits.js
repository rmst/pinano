const normalizePunctuation = (value) => value.trim().replaceAll(/./gs, (char) => {
	switch (char) {
		case "‐":
		case "‑":
		case "‒":
		case "–":
		case "—":
		case "―":
		case "−": return "-"
		case "‘":
		case "’":
		case "‚":
		case "‛": return "'"
		case "“":
		case "”":
		case "„":
		case "‟": return "\""
		case " ":
		case " ":
		case " ":
		case " ":
		case " ":
		case " ":
		case " ":
		case " ":
		case " ":
		case " ":
		case " ":
		case " ":
		case "　": return " "
		default: return char
	}
})

const LINE_COMPARATORS = [
	(left, right) => left === right,
	(left, right) => left.trimEnd() === right.trimEnd(),
	(left, right) => left.trim() === right.trim(),
	(left, right) => normalizePunctuation(left) === normalizePunctuation(right),
]

function matchesAt(lines, pattern, index, compare) {
	return pattern.every((line, offset) => compare(lines[index + offset], line))
}

function seekSequence(lines, pattern, start, endOfFile) {
	if (pattern.length === 0) return start
	if (pattern.length > lines.length) return -1
	const lastStart = lines.length - pattern.length
	const searchStart = endOfFile ? lastStart : start
	if (searchStart > lastStart) return -1
	for (const compare of LINE_COMPARATORS) {
		for (let index = searchStart; index <= lastStart; index++) {
			if (matchesAt(lines, pattern, index, compare)) return index
		}
	}
	return -1
}

function splitContent(content) {
	if (content.length === 0) return []
	const lines = content.split("\n")
	if (lines.at(-1) === "") lines.pop()
	return lines
}

function hunkReplacement(hunk) {
	return {
		oldLines: hunk.lines.filter((line) => line.kind !== "+").map((line) => line.text),
		newLines: hunk.lines.filter((line) => line.kind !== "-").map((line) => line.text),
	}
}

function applyReplacements(lines, replacements) {
	const result = [...lines]
	for (const replacement of [...replacements].reverse()) {
		result.splice(replacement.index, replacement.oldLength, ...replacement.newLines)
	}
	return result
}

/** Apply parsed update hunks using Codex-compatible ordered context matching while keeping mutation planning transactional. */
export function applyUpdateHunks(content, hunks, path) {
	const lines = splitContent(content)
	const replacements = []
	let searchFrom = 0

	for (const hunk of hunks) {
		if (hunk.context !== null) {
			const contextIndex = seekSequence(lines, [hunk.context], searchFrom, false)
			if (contextIndex < 0) throw new Error(`Failed to find context '${hunk.context}' in ${path}`)
			searchFrom = contextIndex + 1
		}

		let { oldLines, newLines } = hunkReplacement(hunk)
		if (oldLines.length === 0) {
			const insertionIndex = lines.at(-1) === "" ? lines.length - 1 : lines.length
			replacements.push({ index: insertionIndex, oldLength: 0, newLines })
			continue
		}

		let matchIndex = seekSequence(lines, oldLines, searchFrom, hunk.endOfFile)
		if (matchIndex < 0 && oldLines.at(-1) === "") {
			oldLines = oldLines.slice(0, -1)
			if (newLines.at(-1) === "") newLines = newLines.slice(0, -1)
			matchIndex = seekSequence(lines, oldLines, searchFrom, hunk.endOfFile)
		}
		if (matchIndex < 0) {
			throw new Error(`Failed to find expected lines in ${path}:\n${hunkReplacement(hunk).oldLines.join("\n")}`)
		}
		replacements.push({ index: matchIndex, oldLength: oldLines.length, newLines })
		searchFrom = matchIndex + oldLines.length
	}

	replacements.sort((left, right) => left.index - right.index)
	for (let index = 1; index < replacements.length; index++) {
		const previous = replacements[index - 1]
		const current = replacements[index]
		if (previous.index + previous.oldLength > current.index) {
			throw new Error(`Patch hunks overlap in ${path}`)
		}
	}
	const result = applyReplacements(lines, replacements)
	if (result.at(-1) !== "") result.push("")
	return result.join("\n")
}
