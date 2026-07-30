export const SOURCE_LINE_ATTRIBUTE = "data-cerex-source-line"
export const SOURCE_LINE_COUNT_ATTRIBUTE = "data-cerex-source-line-count"

const RAW_TEXT_ELEMENTS = new Set(["iframe", "noembed", "noframes", "noscript", "plaintext", "script", "style", "textarea", "title", "xmp"])
const NON_CONTENT_ELEMENTS = new Set([
	"base", "head", "link", "meta", "noscript", "script", "style", "template", "title",
])

const newlineCount = (value) => value.match(/\n|\r(?!\n)/g)?.length ?? 0

function tagEnd(source, start) {
	let quote = ""
	for (let index = start + 1; index < source.length; index++) {
		const character = source[index]
		if (quote) {
			if (character === quote) quote = ""
			continue
		}
		if (character === "\"" || character === "'") quote = character
		else if (character === ">") return index + 1
	}
	return -1
}

function rawTextClosingTag(source, name, start) {
	let index = start
	while ((index = source.indexOf(`</${name}`, index)) >= 0) {
		const boundary = source[index + name.length + 2]
		if (boundary === ">" || boundary === "/" || /\s/.test(boundary)) return index
		index += name.length + 2
	}
	return -1
}

function attributeRanges(tag, name) {
	const ranges = []
	let index = 1
	while (index < tag.length && !/[\s/>]/.test(tag[index])) index++
	while (index < tag.length) {
		const whitespaceStart = index
		while (/\s/.test(tag[index])) index++
		if (tag[index] === "/" || tag[index] === ">" || index >= tag.length) break
		const attributeStart = index
		while (index < tag.length && !/[\s=/>"']/.test(tag[index])) index++
		if (index === attributeStart) {
			index++
			continue
		}
		const attributeName = tag.slice(attributeStart, index)
		const afterName = index
		while (/\s/.test(tag[index])) index++
		if (tag[index] === "=") {
			index++
			while (/\s/.test(tag[index])) index++
			const quote = tag[index] === "\"" || tag[index] === "'" ? tag[index++] : ""
			if (quote) {
				while (index < tag.length && tag[index] !== quote) index++
				if (tag[index] === quote) index++
			} else {
				while (index < tag.length && !/[\s/>]/.test(tag[index])) index++
			}
		} else index = afterName
		if (attributeName.toLowerCase() === name.toLowerCase()) ranges.push([whitespaceStart, index])
	}
	return ranges
}

function replaceAttribute(tag, name, value) {
	const clean = attributeRanges(tag, name).reverse().reduce(
		(result, [start, end]) => result.slice(0, start) + result.slice(end),
		tag,
	)
	const close = clean.endsWith("/>") ? clean.length - 2 : clean.length - 1
	const prefix = clean.slice(0, close)
	return `${prefix}${/\s$/.test(prefix) ? "" : " "}${name}="${value}"${clean.slice(close)}`
}

function annotateTag(tag, attributes) {
	let annotated = tag
	for (const [name, value] of attributes) annotated = replaceAttribute(annotated, name, value)
	return annotated
}

function openingTagName(tag) {
	if (/^<\s*[!/?]/.test(tag)) return ""
	return /^<\s*([A-Za-z][\w:-]*)/.exec(tag)?.[1]?.toLowerCase() ?? ""
}

export function annotateFirstHtmlElement(html, attributes) {
	const lowerHtml = html.toLowerCase()
	let cursor = 0
	while (cursor < html.length) {
		const start = html.indexOf("<", cursor)
		if (start < 0) return html
		if (html.startsWith("<!--", start)) {
			const end = html.indexOf("-->", start + 4)
			cursor = end < 0 ? html.length : end + 3
			continue
		}
		if (html.startsWith("<![CDATA[", start)) {
			const end = html.indexOf("]]>", start + 9)
			cursor = end < 0 ? html.length : end + 3
			continue
		}
		const end = tagEnd(html, start)
		if (end < 0) return html
		const tag = html.slice(start, end)
		const name = openingTagName(tag)
		if (!name) {
			cursor = end
			continue
		}
		if (NON_CONTENT_ELEMENTS.has(name)) {
			if (RAW_TEXT_ELEMENTS.has(name) || name === "template") {
				const close = rawTextClosingTag(lowerHtml, name, end)
				const closeEnd = close < 0 ? -1 : tagEnd(html, close)
				cursor = closeEnd < 0 ? end : closeEnd
			} else cursor = end
			continue
		}
		return `${html.slice(0, start)}${annotateTag(tag, attributes)}${html.slice(end)}`
	}
	return html
}

export function annotateHtmlSource(source) {
	const lines = 1 + newlineCount(source)
	const lowerSource = source.toLowerCase()
	let cursor = 0
	let line = 1
	let rawTextElement = ""
	let anchored = false
	let output = ""
	while (cursor < source.length) {
		let start
		if (rawTextElement) {
			start = rawTextClosingTag(lowerSource, rawTextElement, cursor)
			if (start < 0) {
				output += source.slice(cursor)
				break
			}
			rawTextElement = ""
		} else {
			start = source.indexOf("<", cursor)
			if (start < 0) {
				output += source.slice(cursor)
				break
			}
		}

		const preceding = source.slice(cursor, start)
		output += preceding
		line += newlineCount(preceding)
		if (source.startsWith("<!--", start)) {
			const commentEnd = source.indexOf("-->", start + 4)
			const end = commentEnd < 0 ? source.length : commentEnd + 3
			const comment = source.slice(start, end)
			output += comment
			line += newlineCount(comment)
			cursor = end
			continue
		}
		if (source.startsWith("<![CDATA[", start)) {
			const cdataEnd = source.indexOf("]]>", start + 9)
			const end = cdataEnd < 0 ? source.length : cdataEnd + 3
			const cdata = source.slice(start, end)
			output += cdata
			line += newlineCount(cdata)
			cursor = end
			continue
		}

		const end = tagEnd(source, start)
		if (end < 0) {
			output += source.slice(start)
			break
		}
		const tag = source.slice(start, end)
		const name = openingTagName(tag)
		let annotated = tag
		if (name) {
			const attributes = []
			if (name === "html") attributes.push([SOURCE_LINE_COUNT_ATTRIBUTE, lines])
			if (!NON_CONTENT_ELEMENTS.has(name)) {
				attributes.push([SOURCE_LINE_ATTRIBUTE, line])
				if (!anchored && name !== "html") attributes.push([SOURCE_LINE_COUNT_ATTRIBUTE, lines])
				anchored = true
			}
			annotated = annotateTag(tag, attributes)
			if (RAW_TEXT_ELEMENTS.has(name)) rawTextElement = name
		}
		output += annotated
		line += newlineCount(tag)
		cursor = end
	}
	return output
}
