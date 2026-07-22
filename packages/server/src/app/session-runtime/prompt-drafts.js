import { promptImageLabel, promptImagePlaceholders } from "../../../../protocol/src/prompt-images.js"
import { isProjectContextMessage } from "../project-context.js"
import { isAutomatedMaintenanceMessage, isHumanUserEntry } from "../session-properties.js"
import { imageBlocksFromContent, textFromContent } from "./transcript-projection.js"

const PROMPT_IMAGE_LABEL_RE = /\[Image #\d+\]/g

/** @param {string} text */
function uniquePromptImageLabels(text) {
	const seen = new Set()
	return promptImagePlaceholders(text)
		.map((item) => item.placeholder)
		.filter((label) => {
			if (seen.has(label)) return false
			seen.add(label)
			return true
		})
}

/** @param {string} text @param {Map<string, string>} replacements */
function replacePromptImageLabels(text, replacements) {
	if (replacements.size === 0) return text
	return text.replace(PROMPT_IMAGE_LABEL_RE, (label) => replacements.get(label) ?? label)
}

/** @param {any} message */
function promptDraftPartFromMessage(message) {
	return {
		text: textFromContent(message?.content),
		images: imageBlocksFromContent(message?.content),
	}
}

/** @param {{ text: string, images: any[] }[]} parts */
function promptDraftFromParts(parts) {
	let nextImageNumber = 1
	const usedImageNumbers = new Set()
	const textParts = []
	const images = []
	const labelForImage = (image) => {
		const number = Number(image?.imageNumber)
		if (Number.isInteger(number) && number > 0) {
			usedImageNumbers.add(number)
			nextImageNumber = Math.max(nextImageNumber, number + 1)
			return promptImageLabel(number)
		}
		while (usedImageNumbers.has(nextImageNumber)) nextImageNumber += 1
		const generated = nextImageNumber
		usedImageNumbers.add(generated)
		nextImageNumber += 1
		return promptImageLabel(generated)
	}
	for (const part of parts) {
		const labels = uniquePromptImageLabels(part.text)
		const replacements = new Map()
		const generatedLabels = []
		for (let i = 0; i < part.images.length; i += 1) {
			const nextLabel = labelForImage(part.images[i])
			if (labels[i]) replacements.set(labels[i], nextLabel)
			else generatedLabels.push(nextLabel)
			images.push(part.images[i])
		}
		const text = replacePromptImageLabels(part.text, replacements)
		const generatedPrefix = generatedLabels.join("\n")
		let restoredText = text
		if (generatedPrefix) {
			if (!text) restoredText = generatedPrefix
			else if (labels.length > 0) restoredText = `${text}\n\n${generatedPrefix}`
			else restoredText = `${generatedPrefix}\n\n${text}`
		}
		if (restoredText) textParts.push(restoredText)
	}
	return { text: textParts.join("\n\n"), images }
}

/** @param {any} message */
export function isCancellableUserMessage(message) {
	return message?.role === "user" && !isAutomatedMaintenanceMessage(message) && !isProjectContextMessage(message)
}

/** @param {import("../agent-runtime.js").AgentRuntime} agent */
export function queuedAgentMessages(agent) {
	return agent.getQueuedMessages?.() ?? []
}

/** @param {any} item */
export function normalizeQueuedMessageItem(item) {
	return item?.message
		? { behavior: item.behavior === "followUp" ? "followUp" : "steer", message: item.message }
		: { behavior: "steer", message: item }
}

/** @param {import("../../session-manager/index.js").Session} session @param {any} promptEntry */
export function cancellableBranchUserMessages(session, promptEntry) {
	const branch = session.getBranch()
	const promptIndex = branch.findIndex((entry) => entry.id === promptEntry.id)
	const entries = promptIndex >= 0 ? branch.slice(promptIndex) : [promptEntry]
	return entries
		.filter((entry) => isHumanUserEntry(entry) && !isProjectContextMessage(entry.message))
		.map((entry) => entry.message)
}

/** @param {any[]} messages */
export function promptDraftFromMessages(messages) {
	return promptDraftFromParts(messages.map(promptDraftPartFromMessage))
}

/** @param {any[]} messages */
export function promptDraftResponseFromMessages(messages) {
	if (messages.length === 0) return {}
	const draft = promptDraftFromMessages(messages)
	return { text: draft.text, images: draft.images, restoredMessageCount: messages.length }
}
