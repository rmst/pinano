import { Marked, Tokenizer } from "../vendor/marked/marked.js"
import { markdownMathExtensions, MAX_LATEX_LENGTH } from "./math.js"

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/
const ALERT_TYPES = new Set(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"])

function nextBlockExtensionStart(source, lexer) {
	const starts = lexer.options.extensions?.startBlock
	if (!starts?.length) return undefined
	const rest = source.slice(1)
	let first = Infinity
	for (const start of starts) {
		const index = start.call({ lexer }, rest)
		if (typeof index === "number" && index >= 0) first = Math.min(first, index + 1)
	}
	return first < Infinity ? first : undefined
}

class MarkdownTokenizer extends Tokenizer {
	lheading(source) {
		const token = super.lheading(source)
		if (!token) return undefined
		// Marked checks Setext headings before applying extension start hints, so a heading must not consume an earlier custom block boundary.
		const blockStart = nextBlockExtensionStart(source, this.lexer)
		return blockStart !== undefined && blockStart < token.raw.length ? undefined : token
	}

	del(source) {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(source)
		if (!match) return undefined
		const text = match[2]
		return { type: "del", raw: match[0], text, tokens: this.lexer.inlineTokens(text) }
	}
}

const normalizeLabel = (label) => label.trim().replace(/\s+/g, " ").toLowerCase()
const nextFootnoteDefinition = (source) => {
	const match = /\n {0,3}\[\^/.exec(source)
	return match ? match.index + 1 : undefined
}

function footnoteDefinitionTokenizer(source) {
	const opening = /^\[\^([^\]\r\n]+)\]:[ \t]*(.*)(?:\r?\n|$)/.exec(source)
	if (!opening) return undefined
	const lines = [opening[2]]
	let offset = opening[0].length
	let pendingBlank = false
	while (offset < source.length) {
		const newline = source.indexOf("\n", offset)
		const end = newline < 0 ? source.length : newline + 1
		const rawLine = source.slice(offset, newline < 0 ? source.length : newline).replace(/\r$/, "")
		if (!rawLine.trim()) {
			pendingBlank = true
			offset = end
			continue
		}
		const continuation = /^(?: {2,4}|\t)(.*)$/.exec(rawLine)
		if (!continuation) break
		if (pendingBlank) lines.push("")
		lines.push(continuation[1])
		pendingBlank = false
		offset = end
	}
	const text = lines.join("\n").trimEnd()
	const top = this.lexer.state.top
	this.lexer.state.top = true
	const tokens = this.lexer.blockTokens(text, [])
	this.lexer.state.top = top
	return {
		type: "footnote",
		raw: source.slice(0, offset),
		label: normalizeLabel(opening[1]),
		text,
		tokens,
	}
}

function footnoteReferenceTokenizer(source) {
	const match = /^\[\^([^\]\r\n]+)\]/.exec(source)
	if (!match) return undefined
	return {
		type: "footnote_ref",
		raw: match[0],
		label: normalizeLabel(match[1]),
		text: match[1],
	}
}

const footnoteExtensions = [
	{ name: "footnote", level: "block", start: nextFootnoteDefinition, tokenizer: footnoteDefinitionTokenizer, childTokens: ["tokens"] },
	{ name: "footnote_ref", level: "inline", start: (source) => source.indexOf("[^"), tokenizer: footnoteReferenceTokenizer },
]

const markdownParser = new Marked({ extensions: [...markdownMathExtensions, ...footnoteExtensions] })
markdownParser.setOptions({ tokenizer: new MarkdownTokenizer() })

function splitFrontmatter(source) {
	const opening = /^(?:\uFEFF)?---[ \t]*(?:\r?\n)/.exec(source)
	if (!opening) return null
	let offset = opening[0].length
	let hasField = false
	while (offset <= source.length) {
		const newline = source.indexOf("\n", offset)
		const end = newline < 0 ? source.length : newline + 1
		const line = source.slice(offset, newline < 0 ? source.length : newline).replace(/\r$/, "")
		if ((line === "---" || line === "...") && hasField) {
			return {
				raw: source.slice(0, end),
				text: source.slice(0, newline < 0 ? source.length : newline),
				body: source.slice(end),
			}
		}
		if (/^[^\s:#][^:]*:/.test(line)) hasField = true
		if (newline < 0) break
		offset = end
	}
	return null
}

function normalizeAlert(token) {
	if (token.type !== "blockquote") return
	const firstBlock = token.tokens?.[0]
	const firstInline = firstBlock?.tokens?.[0]
	if (!firstInline || firstInline.type !== "text") return
	const match = /^\[!([A-Za-z]+)\](?:\n|$)/.exec(firstInline.raw ?? firstInline.text)
	const alert = match?.[1]?.toUpperCase()
	if (!match || !ALERT_TYPES.has(alert)) return
	token.alert = alert
	firstInline.raw = firstInline.raw.slice(match[0].length)
	firstInline.text = firstInline.text.slice(match[0].length)
	firstBlock.raw = firstBlock.raw.replace(/^\[![A-Za-z]+\](?:\n|$)/, "")
	firstBlock.text = firstBlock.text.replace(/^\[![A-Za-z]+\](?:\n|$)/, "")
	if (!firstInline.raw && firstBlock.tokens.length > 1) firstBlock.tokens.shift()
}

function childTokenGroups(token) {
	if (token.type === "table") return [...token.header.map((cell) => cell.tokens), ...token.rows.flatMap((row) => row.map((cell) => cell.tokens))]
	if (token.type === "list") return token.items.map((item) => item.tokens)
	return token.tokens ? [token.tokens] : []
}

function normalizeTokens(tokens) {
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]
		const language = token.type === "code" ? token.lang?.split(/\s+/, 1)[0]?.toLowerCase() : undefined
		const latex = language === "math" ? token.text.trim() : ""
		if (latex && latex.length <= MAX_LATEX_LENGTH) {
			tokens[i] = { type: "math", raw: token.raw, text: latex, latex, display: true }
			continue
		}
		normalizeAlert(token)
		for (const children of childTokenGroups(token)) normalizeTokens(children)
	}
	return tokens
}

function resolveFootnotes(tokens) {
	const definitions = new Map()
	for (const token of tokens) {
		if (token.type === "footnote" && !definitions.has(token.label)) definitions.set(token.label, token)
	}
	const footnotes = []
	let referenceCount = 0
	const visit = (children) => {
		for (const token of children) {
			if (token.type === "footnote_ref") {
				const definition = definitions.get(token.label)
				if (definition) {
					if (!definition.index) {
						definition.index = footnotes.length + 1
						definition.references = []
						footnotes.push(definition)
					}
					token.index = definition.index
					token.reference = ++referenceCount
					definition.references.push(token.reference)
				}
			}
			for (const nested of childTokenGroups(token)) visit(nested)
		}
	}
	visit(tokens)
	return footnotes
}

export function parseMarkdown(source, { frontmatter: parseFrontmatter = false } = {}) {
	const frontmatter = parseFrontmatter ? splitFrontmatter(source) : null
	const tokens = normalizeTokens(markdownParser.lexer(frontmatter?.body ?? source))
	if (frontmatter) tokens.unshift({ type: "frontmatter", raw: frontmatter.raw, text: frontmatter.text })
	return { tokens, footnotes: resolveFootnotes(tokens) }
}

export function parseMarkdownInline(source) {
	return normalizeTokens(markdownParser.Lexer.lexInline(source, markdownParser.defaults))
}
