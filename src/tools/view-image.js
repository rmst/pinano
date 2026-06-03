import { constants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"

import { createPromptImageContent } from "./image-prompt.js"
import { resolveToCwd } from "./path-utils.js"

const viewImageSchema = {
	type: "object",
	properties: {
		path: { type: "string", description: "Local filesystem path to an image file" },
		detail: {
			type: "string",
			enum: ["high", "original"],
			description:
				"Optional detail override. Supported values are high and original; omit this field for default high behavior. Use original to preserve the file's original resolution when supported by the target model.",
		},
	},
	required: ["path"],
	additionalProperties: false,
}

/**
 * @param {string} cwd
 * @returns {import("../agent-core/types.js").AgentTool}
 */
export function createViewImageTool(cwd) {
	return {
		name: "view_image",
		label: "view_image",
		description:
			"View a local image from the filesystem. Only use if given a full filepath by the user, and the image is not already attached to the thread context.",
		parameters: viewImageSchema,
		async execute(_id, { path, detail }, signal) {
			const abs = resolveToCwd(path, cwd)
			if (signal?.aborted) throw new Error("Operation aborted")
			await access(abs, constants.R_OK)
			const info = await stat(abs)
			if (!info.isFile()) throw new Error(`image path ${path} is not a file`)
			const image = createPromptImageContent(await readFile(abs), { path, detail })
			return {
				content: [image],
				details: { mimeType: image.mimeType, widthPx: image.widthPx, heightPx: image.heightPx, detail: image.detail },
			}
		},
	}
}
