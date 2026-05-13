// Truncate text outputs by line count and byte size, whichever cap hits first.
// Used by read (head), bash (tail), grep, find for capping LLM-visible output.

export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024
export const GREP_MAX_LINE_LENGTH = 500

export function formatSize(bytes) {
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function makeResult(content, totalLines, totalBytes, outputLines, outputBytes, opts) {
	return {
		content,
		truncated: false,
		truncatedBy: null,
		totalLines,
		totalBytes,
		outputLines,
		outputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines: opts.maxLines,
		maxBytes: opts.maxBytes,
	}
}

/** Keep first N lines/bytes. Suitable for file reads. Never returns partial lines. */
export function truncateHead(content, options = {}) {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
	const totalBytes = Buffer.byteLength(content, "utf-8")
	const lines = content.split("\n")
	const totalLines = lines.length

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return makeResult(content, totalLines, totalBytes, totalLines, totalBytes, { maxLines, maxBytes })
	}

	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8")
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		}
	}

	const out = []
	let outBytes = 0
	let truncatedBy = "lines"
	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i]
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0)
		if (outBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes"
			break
		}
		out.push(line)
		outBytes += lineBytes
	}
	if (out.length >= maxLines && outBytes <= maxBytes) truncatedBy = "lines"

	const outputContent = out.join("\n")
	const finalOutBytes = Buffer.byteLength(outputContent, "utf-8")
	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: out.length,
		outputBytes: finalOutBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	}
}

/** Keep last N lines/bytes. Suitable for bash output. May return a partial first line. */
export function truncateTail(content, options = {}) {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
	const totalBytes = Buffer.byteLength(content, "utf-8")
	const lines = content.split("\n")
	const totalLines = lines.length

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return makeResult(content, totalLines, totalBytes, totalLines, totalBytes, { maxLines, maxBytes })
	}

	const out = []
	let outBytes = 0
	let truncatedBy = "lines"
	let lastLinePartial = false

	for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
		const line = lines[i]
		const lineBytes = Buffer.byteLength(line, "utf-8") + (out.length > 0 ? 1 : 0)
		if (outBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes"
			if (out.length === 0) {
				const trimmed = truncateStringFromEnd(line, maxBytes)
				out.unshift(trimmed)
				outBytes = Buffer.byteLength(trimmed, "utf-8")
				lastLinePartial = true
			}
			break
		}
		out.unshift(line)
		outBytes += lineBytes
	}
	if (out.length >= maxLines && outBytes <= maxBytes) truncatedBy = "lines"

	const outputContent = out.join("\n")
	const finalOutBytes = Buffer.byteLength(outputContent, "utf-8")
	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: out.length,
		outputBytes: finalOutBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	}
}

function truncateStringFromEnd(str, maxBytes) {
	const buf = Buffer.from(str, "utf-8")
	if (buf.length <= maxBytes) return str
	let start = buf.length - maxBytes
	// Walk forward to a UTF-8 character boundary.
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
	return buf.slice(start).toString("utf-8")
}

/** Truncate one line to `maxChars`, suffixing "... [truncated]". Used by grep. */
export function truncateLine(line, maxChars = GREP_MAX_LINE_LENGTH) {
	if (line.length <= maxChars) return { text: line, wasTruncated: false }
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true }
}
