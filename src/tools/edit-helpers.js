// Helpers used by the edit tool: line-ending detection, fuzzy-text matching,
// applying a batch of disjoint replacements.

export function detectLineEnding(content) {
	const crlf = content.indexOf("\r\n")
	const lf = content.indexOf("\n")
	if (lf === -1) return "\n"
	if (crlf === -1) return "\n"
	return crlf < lf ? "\r\n" : "\n"
}

export function normalizeToLF(text) {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

export function restoreLineEndings(text, ending) {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text
}

/** Strip a UTF-8 BOM if present. */
export function stripBom(content) {
	return content.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: content.slice(1) }
		: { bom: "", text: content }
}

/**
 * Fuzzy normalization for matching: NFKC, strip trailing whitespace per line,
 * normalize smart quotes / dashes / special spaces to ASCII equivalents.
 */
export function normalizeForFuzzyMatch(text) {
	return (
		text
			.normalize("NFKC")
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	)
}

export function fuzzyFindText(content, oldText) {
	const exact = content.indexOf(oldText)
	if (exact !== -1) {
		return {
			found: true,
			index: exact,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		}
	}
	const fuzzyContent = normalizeForFuzzyMatch(content)
	const fuzzyOldText = normalizeForFuzzyMatch(oldText)
	const idx = fuzzyContent.indexOf(fuzzyOldText)
	if (idx === -1) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content }
	}
	return {
		found: true,
		index: idx,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	}
}

function countOccurrences(content, oldText) {
	const fc = normalizeForFuzzyMatch(content)
	const ft = normalizeForFuzzyMatch(oldText)
	return fc.split(ft).length - 1
}

function notFound(path, idx, total) {
	if (total === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		)
	}
	return new Error(
		`Could not find edits[${idx}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	)
}

function duplicate(path, idx, total, n) {
	if (total === 1) {
		return new Error(
			`Found ${n} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		)
	}
	return new Error(
		`Found ${n} occurrences of edits[${idx}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	)
}

function emptyOld(path, idx, total) {
	if (total === 1) return new Error(`oldText must not be empty in ${path}.`)
	return new Error(`edits[${idx}].oldText must not be empty in ${path}.`)
}

function noChange(path, total) {
	if (total === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		)
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`)
}

/**
 * Apply a list of disjoint replacements to LF-normalized content. Returns
 * `{ baseContent, newContent }` where `baseContent` is whichever variant
 * matched (original or fuzzy-normalized).
 *
 * @param {string} normalizedContent
 * @param {{ oldText: string, newText: string }[]} edits
 * @param {string} path
 */
export function applyEditsToNormalizedContent(normalizedContent, edits, path) {
	const normalized = edits.map((e) => ({
		oldText: normalizeToLF(e.oldText),
		newText: normalizeToLF(e.newText),
	}))
	for (let i = 0; i < normalized.length; i++) {
		if (normalized[i].oldText.length === 0) throw emptyOld(path, i, normalized.length)
	}

	const initialMatches = normalized.map((e) => fuzzyFindText(normalizedContent, e.oldText))
	const baseContent = initialMatches.some((m) => m.usedFuzzyMatch)
		? normalizeForFuzzyMatch(normalizedContent)
		: normalizedContent

	const matched = []
	for (let i = 0; i < normalized.length; i++) {
		const e = normalized[i]
		const m = fuzzyFindText(baseContent, e.oldText)
		if (!m.found) throw notFound(path, i, normalized.length)
		const occ = countOccurrences(baseContent, e.oldText)
		if (occ > 1) throw duplicate(path, i, normalized.length, occ)
		matched.push({ editIndex: i, matchIndex: m.index, matchLength: m.matchLength, newText: e.newText })
	}

	matched.sort((a, b) => a.matchIndex - b.matchIndex)
	for (let i = 1; i < matched.length; i++) {
		const prev = matched[i - 1]
		const curr = matched[i]
		if (prev.matchIndex + prev.matchLength > curr.matchIndex) {
			throw new Error(
				`edits[${prev.editIndex}] and edits[${curr.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			)
		}
	}

	let newContent = baseContent
	for (let i = matched.length - 1; i >= 0; i--) {
		const e = matched[i]
		newContent =
			newContent.substring(0, e.matchIndex) + e.newText + newContent.substring(e.matchIndex + e.matchLength)
	}

	if (baseContent === newContent) throw noChange(path, normalized.length)
	return { baseContent, newContent }
}
