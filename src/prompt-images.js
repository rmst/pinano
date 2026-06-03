export const PROMPT_IMAGE_CLOSE_TAG = "</image>"

const PROMPT_IMAGE_LABEL_RE = /\[Image #(\d+)\]/g
const PROMPT_IMAGE_OPEN_TAG_RE = /^<image name=\[Image #\d+\]>$/

/** @param {number} number */
export function promptImageLabel(number) {
	return `[Image #${number}]`
}

/** @param {number | string} label */
export function promptImageOpenTag(label) {
	return `<image name=${typeof label === "number" ? promptImageLabel(label) : label}>`
}

/** @param {string} text */
export function isPromptImageMarkerText(text) {
	return text === PROMPT_IMAGE_CLOSE_TAG || PROMPT_IMAGE_OPEN_TAG_RE.test(text)
}

/** @param {string} text */
export function promptImagePlaceholders(text) {
	return [...String(text || "").matchAll(PROMPT_IMAGE_LABEL_RE)].map((match) => ({
		placeholder: match[0],
		index: Number(match[1]),
	}))
}

/** @param {string} text */
export function promptImageLabelsForText(text) {
	const seen = new Set()
	return promptImagePlaceholders(text)
		.map((item) => item.placeholder)
		.filter((label) => {
			if (seen.has(label)) return false
			seen.add(label)
			return true
		})
}

/**
 * Build Codex-style prompt image framing: image blocks are sent before the typed text and wrapped in text markers.
 * @param {string} message
 * @param {any[]} [images]
 */
export function promptContentWithImages(message, images = []) {
	const labels = promptImageLabelsForText(message)
	const content = images.flatMap((image, index) => {
		const label = labels[index] ?? promptImageLabel(index + 1)
		return [
			{ type: "text", text: promptImageOpenTag(label) },
			image,
			{ type: "text", text: PROMPT_IMAGE_CLOSE_TAG },
		]
	})
	if (message) content.push({ type: "text", text: message })
	if (content.length === 0) content.push({ type: "text", text: "" })
	return content
}
