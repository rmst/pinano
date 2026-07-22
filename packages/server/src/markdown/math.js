const MAX_LATEX_LENGTH = 5000

const isWhitespace = (character) => !character || /\s/.test(character)
const isAsciiAlphaNumeric = (character) => !!character && /[A-Za-z0-9]/.test(character)
const isInlineBoundary = (character) => !character || !isAsciiAlphaNumeric(character)

function precedingBackslashCount(text, index) {
	let count = 0
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) count++
	return count
}

const isEscaped = (text, index) => precedingBackslashCount(text, index) % 2 === 1
const validLatex = (latex) => latex.length > 0 && latex.length <= MAX_LATEX_LENGTH

function previousRawCharacter(tokens) {
	const raw = tokens.at(-1)?.raw
	return typeof raw === "string" ? raw.at(-1) : undefined
}

function backtickRunAt(text, start) {
	let end = start
	while (text[end] === "`") end++
	return text.slice(start, end)
}

function findBacktickClose(text, start, marker) {
	let index = start
	while (index < text.length) {
		index = text.indexOf(marker, index)
		if (index < 0) return -1
		if (text[index - 1] !== "`" && text[index + marker.length] !== "`") return index
		while (text[index] === "`") index++
	}
	return -1
}

function githubCodeMath(source, previousCharacter) {
	if (!source.startsWith("$`") || previousCharacter === "$" || !isInlineBoundary(previousCharacter)) return null
	const marker = backtickRunAt(source, 1)
	const close = findBacktickClose(source, marker.length + 1, marker)
	if (close < 0 || source[close + marker.length] !== "$" || !isInlineBoundary(source[close + marker.length + 1])) return null
	const latex = source.slice(marker.length + 1, close).trim()
	if (!validLatex(latex)) return null
	const end = close + marker.length + 1
	return { raw: source.slice(0, end), latex }
}

function dollarMath(source, previousCharacter) {
	if (source[0] !== "$" || source[1] === "$" || previousCharacter === "$" || !isInlineBoundary(previousCharacter) || isWhitespace(source[1])) return null
	for (let i = 1; i < source.length && source[i] !== "\n" && source[i] !== "\r"; i++) {
		if (source[i] !== "$" || isEscaped(source, i)) continue
		if (source[i - 1] === "$" || source[i + 1] === "$" || isWhitespace(source[i - 1]) || !isInlineBoundary(source[i + 1])) return null
		const latex = source.slice(1, i).trim()
		if (!validLatex(latex) || latex.includes("`")) return null
		return { raw: source.slice(0, i + 1), latex }
	}
	return null
}

function parenthesizedMath(source) {
	if (!source.startsWith("\\(")) return null
	for (let i = 2; i < source.length - 1 && source[i] !== "\n" && source[i] !== "\r"; i++) {
		if (source[i] !== "\\" || isEscaped(source, i)) continue
		if (source[i + 1] === "(") return null
		if (source[i + 1] !== ")") continue
		const latex = source.slice(2, i).trim()
		if (!validLatex(latex)) return null
		return { raw: source.slice(0, i + 2), latex }
	}
	return null
}

function inlineMathStart(source) {
	const dollar = source.indexOf("$")
	const slash = source.search(/\\[()[\]]/)
	if (dollar < 0) return slash < 0 ? undefined : slash
	if (slash < 0) return dollar
	return Math.min(dollar, slash)
}

function inlineMathTokenizer(source, tokens) {
	const previousCharacter = previousRawCharacter(tokens)
	const match = source[0] === "$"
		? githubCodeMath(source, previousCharacter) ?? dollarMath(source, previousCharacter)
		: source.startsWith("\\(") ? parenthesizedMath(source) : null
	if (match) return { type: "math", raw: match.raw, text: match.latex, latex: match.latex, display: false }

	if (/^\\[()[\]]/.test(source)) return { type: "math_source", raw: source.slice(0, 2), text: source.slice(0, 2) }
	return undefined
}

function sourceLine(source, start) {
	const newline = source.indexOf("\n", start)
	const end = newline < 0 ? source.length : newline + 1
	const rawContentEnd = newline < 0 ? source.length : newline
	const contentEnd = rawContentEnd > start && source[rawContentEnd - 1] === "\r" ? rawContentEnd - 1 : rawContentEnd
	return { text: source.slice(start, contentEnd), end }
}

function displayCloseAtEnd(text, delimiter, from = 0) {
	let index = from
	while (index < text.length) {
		index = text.indexOf(delimiter, index)
		if (index < 0) return -1
		if (!isEscaped(text, index) && !text.slice(index + delimiter.length).trim()) return index
		index += delimiter.length
	}
	return -1
}

function displayMathTokenizer(source) {
	const openingLine = sourceLine(source, 0)
	const opening = /^( {0,3})(\$\$|\\\[)(.*)$/.exec(openingLine.text)
	if (!opening || opening[2] === "$$" && opening[3].startsWith("$")) return undefined
	const closeDelimiter = opening[2] === "$$" ? "$$" : "\\]"
	const first = opening[3]
	const sameLineClose = displayCloseAtEnd(first, closeDelimiter)
	if (sameLineClose >= 0) {
		const latex = first.slice(0, sameLineClose).trim()
		if (!validLatex(latex)) return undefined
		return {
			type: "math",
			raw: source.slice(0, openingLine.end),
			text: latex,
			latex,
			display: true,
		}
	}
	if (first.trim()) return undefined

	const latexLines = []
	let latexLength = 0
	let offset = openingLine.end
	while (offset < source.length) {
		const line = sourceLine(source, offset)
		const close = displayCloseAtEnd(line.text, closeDelimiter)
		if (close >= 0) {
			latexLines.push(line.text.slice(0, close))
			const latex = latexLines.join("\n").trim()
			if (!validLatex(latex)) return undefined
			return {
				type: "math",
				raw: source.slice(0, line.end),
				text: latex,
				latex,
				display: true,
			}
		}
		latexLines.push(line.text)
		latexLength += line.text.length
		if (latexLength > MAX_LATEX_LENGTH) return undefined
		offset = line.end
	}
	return undefined
}

function displayMathStart(source) {
	const match = /\n {0,3}(?:\$\$|\\\[)/.exec(source)
	return match ? match.index + 1 : undefined
}

export const markdownMathExtensions = [
	{ name: "math", level: "block", start: displayMathStart, tokenizer: displayMathTokenizer },
	{ name: "math", level: "inline", start: inlineMathStart, tokenizer: inlineMathTokenizer },
]

export { MAX_LATEX_LENGTH }
