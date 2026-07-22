import { constants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"

import { createPromptImageContentAutoResize } from "./image-prompt.js"
import { resolveToCwd } from "./path-utils.js"

const viewImageSchema = {
	type: "object",
	properties: {
		path: { type: "string", description: "Local filesystem path to an image file" },
		detail: {
			type: "string",
			enum: ["high", "original"],
			description:
				"Optional detail override. Supported values are high and original; omit this field for default high behavior. High-detail images are resized to prompt limits when possible. Use original to preserve the file's original resolution when supported by the target model.",
		},
	},
	required: ["path"],
	additionalProperties: false,
}

const viewImageCodeModeOutputSchema = {
	type: "object",
	properties: {
		image_url: { type: "string", description: "Base64 data URL for the image." },
		detail: { type: "string", enum: ["high", "original"] },
	},
	required: ["image_url", "detail"],
	additionalProperties: false,
}

function projectViewImageResult(result) {
	const image = result.content.find((item) => item.type === "image")
	if (!image) throw new Error("view_image did not return image content")
	return {
		image_url: `data:${image.mimeType};base64,${image.data}`,
		detail: image.detail,
	}
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
			"View a local image from the filesystem. Only use if the image is not already attached to the thread context.",
		parameters: viewImageSchema,
		codeMode: {
			outputSchema: viewImageCodeModeOutputSchema,
			projectResult: projectViewImageResult,
		},
		async execute(_id, { path, detail }, signal) {
			const abs = resolveToCwd(path, cwd)
			if (signal?.aborted) throw new Error("Operation aborted")
			await access(abs, constants.R_OK)
			const info = await stat(abs)
			if (!info.isFile()) throw new Error(`image path ${path} is not a file`)
			const image = await createPromptImageContentAutoResize(await readFile(abs), { path, detail })
			return {
				content: [image],
				details: {
					mimeType: image.mimeType,
					widthPx: image.widthPx,
					heightPx: image.heightPx,
					detail: image.detail,
					...(image.original ? { original: { mimeType: image.original.mimeType, widthPx: image.original.widthPx, heightPx: image.original.heightPx } } : {}),
				},
			}
		},
	}
}
