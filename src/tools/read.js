import { constants } from "node:fs"
import { access, readFile } from "node:fs/promises"

import { createPromptImageContent } from "./image-prompt.js"
import { detectImageMime } from "./mime.js"
import { resolveToCwd } from "./path-utils.js"
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js"

const TEXT_DESC = `Read the contents of a file. Supports text and images (png, jpg, gif, webp); images are returned as attachments. Use detail=original to preserve image resolution when supported. Text output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large text files; continue with offset to read the rest.`

const readSchema = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path to the file to read (relative or absolute)" },
		offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
		limit: { type: "number", description: "Maximum number of lines to read" },
		detail: {
			type: "string",
			enum: ["high", "original"],
			description:
				"Image detail to request when reading an image. Use high by default. original preserves source resolution when the target model supports it.",
		},
	},
	required: ["path"],
	additionalProperties: false,
}

/**
 * @param {string} cwd
 * @returns {import("../agent-core/types.js").AgentTool}
 */
export function createReadTool(cwd) {
	return {
		name: "read",
		label: "read",
		description: TEXT_DESC,
		parameters: readSchema,
		async execute(_id, { path, offset, limit, detail }, signal) {
			const abs = resolveToCwd(path, cwd)
			if (signal?.aborted) throw new Error("Operation aborted")
			await access(abs, constants.R_OK)
			const buffer = await readFile(abs)

			const mimeType = detectImageMime(buffer)
			if (mimeType) {
				const image = createPromptImageContent(buffer, { path, detail })
				return {
					content: [
						{ type: "text", text: `Read image file [${image.mimeType}, ${image.widthPx}×${image.heightPx}px, detail=${image.detail}]` },
						image,
					],
					details: { mimeType: image.mimeType, widthPx: image.widthPx, heightPx: image.heightPx, detail: image.detail },
				}
			}

			const text = buffer.toString("utf-8")
			const allLines = text.split("\n")
			const totalLines = allLines.length

			const startLine = offset ? Math.max(0, offset - 1) : 0
			const startDisplay = startLine + 1
			if (startLine >= totalLines) {
				throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`)
			}

			let selected
			let userLimited
			if (limit !== undefined) {
				const end = Math.min(startLine + limit, totalLines)
				selected = allLines.slice(startLine, end).join("\n")
				userLimited = end - startLine
			} else {
				selected = allLines.slice(startLine).join("\n")
			}

			const truncation = truncateHead(selected)
			let outputText
			let details
			if (truncation.firstLineExceedsLimit) {
				const firstSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"))
				outputText = `[Line ${startDisplay} is ${firstSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`
				details = { truncation }
			} else if (truncation.truncated) {
				const endDisplay = startDisplay + truncation.outputLines - 1
				const nextOffset = endDisplay + 1
				outputText = truncation.content
				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startDisplay}-${endDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`
				} else {
					outputText += `\n\n[Showing lines ${startDisplay}-${endDisplay} of ${totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`
				}
				details = { truncation }
			} else if (userLimited !== undefined && startLine + userLimited < totalLines) {
				const remaining = totalLines - (startLine + userLimited)
				const nextOffset = startLine + userLimited + 1
				outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`
			} else {
				outputText = truncation.content
			}

			return { content: [{ type: "text", text: outputText }], details: details ?? {} }
		},
	}
}
