import { spawn } from "node:child_process"

import { detectImageMime } from "./mime.js"
import { formatSize } from "./truncate.js"

export const DEFAULT_IMAGE_DETAIL = "high"
export const MAX_PROMPT_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_HIGH_DETAIL_IMAGE_DIMENSION = 2048
export const MAX_PROMPT_IMAGE_RESIZE_INPUT_BYTES = 64 * 1024 * 1024
const FFMPEG_RESIZE_TIMEOUT_MS = 15_000

/**
 * @typedef {{ widthPx: number, heightPx: number }} ImageDimensions
 * @typedef {"high" | "original"} ImageDetail
 * @typedef {{ data: string, mimeType: string, widthPx: number, heightPx: number }} OriginalPromptImageContent
 * @typedef {{ type: "image", data: string, mimeType: string, detail: ImageDetail, widthPx: number, heightPx: number, original?: OriginalPromptImageContent }} PromptImageContent
 * @typedef {{ buffer: Buffer, mimeType: string, dimensions: ImageDimensions, path: string }} PromptImageResizeInput
 * @typedef {(input: PromptImageResizeInput) => Promise<Buffer | null | undefined>} PromptImageResizeBuffer
 */

/**
 * @param {Buffer} buffer
 * @returns {ImageDimensions | null}
 */
function getPngDimensions(buffer) {
	try {
		if (buffer.length < 24) return null
		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null
		return { widthPx: buffer.readUInt32BE(16), heightPx: buffer.readUInt32BE(20) }
	} catch {
		return null
	}
}

/**
 * @param {Buffer} buffer
 * @returns {ImageDimensions | null}
 */
function getJpegDimensions(buffer) {
	try {
		if (buffer.length < 4) return null
		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null

		let offset = 2
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++
				continue
			}

			let marker = buffer[offset + 1]
			while (marker === 0xff && offset < buffer.length - 9) {
				offset++
				marker = buffer[offset + 1]
			}

			// Standalone markers have no payload length.
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
				offset += 2
				continue
			}

			if (offset + 3 >= buffer.length) return null
			const length = buffer.readUInt16BE(offset + 2)
			if (length < 2) return null

			const isStartOfFrame =
				(marker >= 0xc0 && marker <= 0xc3) ||
				(marker >= 0xc5 && marker <= 0xc7) ||
				(marker >= 0xc9 && marker <= 0xcb) ||
				(marker >= 0xcd && marker <= 0xcf)
			if (isStartOfFrame) {
				if (offset + 8 >= buffer.length) return null
				return { widthPx: buffer.readUInt16BE(offset + 7), heightPx: buffer.readUInt16BE(offset + 5) }
			}

			offset += 2 + length
		}

		return null
	} catch {
		return null
	}
}

/**
 * @param {Buffer} buffer
 * @returns {ImageDimensions | null}
 */
function getGifDimensions(buffer) {
	try {
		if (buffer.length < 10) return null
		const sig = buffer.subarray(0, 6).toString("ascii")
		if (sig !== "GIF87a" && sig !== "GIF89a") return null
		return { widthPx: buffer.readUInt16LE(6), heightPx: buffer.readUInt16LE(8) }
	} catch {
		return null
	}
}

/**
 * @param {Buffer} buffer
 * @returns {ImageDimensions | null}
 */
function getWebpDimensions(buffer) {
	try {
		if (buffer.length < 30) return null
		const riff = buffer.subarray(0, 4).toString("ascii")
		const webp = buffer.subarray(8, 12).toString("ascii")
		if (riff !== "RIFF" || webp !== "WEBP") return null

		const chunk = buffer.subarray(12, 16).toString("ascii")
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null
			return { widthPx: buffer.readUInt16LE(26) & 0x3fff, heightPx: buffer.readUInt16LE(28) & 0x3fff }
		}
		if (chunk === "VP8L") {
			if (buffer.length < 25) return null
			const bits = buffer.readUInt32LE(21)
			return { widthPx: (bits & 0x3fff) + 1, heightPx: ((bits >> 14) & 0x3fff) + 1 }
		}
		if (chunk === "VP8X") {
			if (buffer.length < 30) return null
			return {
				widthPx: (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1,
				heightPx: (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1,
			}
		}

		return null
	} catch {
		return null
	}
}

/**
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {ImageDimensions | null}
 */
export function getImageDimensions(buffer, mimeType) {
	if (mimeType === "image/png") return getPngDimensions(buffer)
	if (mimeType === "image/jpeg") return getJpegDimensions(buffer)
	if (mimeType === "image/gif") return getGifDimensions(buffer)
	if (mimeType === "image/webp") return getWebpDimensions(buffer)
	return null
}

/**
 * @param {Buffer} buffer
 * @param {string} path
 * @returns {Error}
 */
function promptImageByteLimitError(buffer, path) {
	return new Error(
		`Image${path} is ${formatSize(buffer.byteLength)}, which exceeds Pinano's ${formatSize(MAX_PROMPT_IMAGE_BYTES)} prompt image limit`,
	)
}

/**
 * @param {ImageDimensions} dimensions
 * @param {string} path
 * @returns {Error}
 */
function promptImageHighDetailDimensionError(dimensions, path) {
	return new Error(
		`Image${path} is ${dimensions.widthPx}×${dimensions.heightPx}px, which exceeds the ${MAX_HIGH_DETAIL_IMAGE_DIMENSION}px high-detail prompt limit. Pinano does not resize images yet; resize it first or request detail="original" if supported by the target model.`,
	)
}

/**
 * Keep the fallback error exactly aligned with the previous validation order.
 * @param {Buffer} buffer
 * @param {ImageDimensions} dimensions
 * @param {ImageDetail} detail
 * @param {string} path
 */
function promptImageLimitError(buffer, dimensions, detail, path) {
	if (buffer.byteLength > MAX_PROMPT_IMAGE_BYTES) return promptImageByteLimitError(buffer, path)
	if (detail === "high" && Math.max(dimensions.widthPx, dimensions.heightPx) > MAX_HIGH_DETAIL_IMAGE_DIMENSION) {
		return promptImageHighDetailDimensionError(dimensions, path)
	}
	return null
}

/**
 * @param {Buffer} buffer
 * @param {{ detail?: ImageDetail, path?: string }} [options]
 */
function inspectPromptImage(buffer, options = {}) {
	const mimeType = detectImageMime(buffer)
	const detail = options.detail ?? DEFAULT_IMAGE_DETAIL
	const path = options.path ? ` ${options.path}` : ""

	if (detail !== "high" && detail !== "original") {
		throw new Error(`Unsupported image detail: ${detail}`)
	}
	if (!mimeType) {
		throw new Error(`Unsupported image format${path}. Supported formats: PNG, JPEG, GIF, WebP`)
	}

	const byteLimitError = buffer.byteLength > MAX_PROMPT_IMAGE_BYTES ? promptImageByteLimitError(buffer, path) : null
	const dimensions = getImageDimensions(buffer, mimeType)
	if (!dimensions || dimensions.widthPx <= 0 || dimensions.heightPx <= 0) {
		if (byteLimitError) throw byteLimitError
		throw new Error(`Could not determine image dimensions${path}`)
	}

	return { mimeType, detail, path, dimensions }
}

/**
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {ImageDimensions} dimensions
 * @param {ImageDetail} detail
 * @param {OriginalPromptImageContent} [original]
 * @returns {PromptImageContent}
 */
function promptImageContent(buffer, mimeType, dimensions, detail, original) {
	return {
		type: "image",
		data: buffer.toString("base64"),
		mimeType,
		detail,
		widthPx: dimensions.widthPx,
		heightPx: dimensions.heightPx,
		...(original ? { original } : {}),
	}
}

/**
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {ImageDimensions} dimensions
 * @returns {OriginalPromptImageContent}
 */
function originalPromptImageContent(buffer, mimeType, dimensions) {
	return {
		data: buffer.toString("base64"),
		mimeType,
		widthPx: dimensions.widthPx,
		heightPx: dimensions.heightPx,
	}
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {Buffer} input
 * @param {{ timeoutMs?: number, maxOutputBytes?: number }} [options]
 * @returns {Promise<Buffer>}
 */
function runBufferInput(command, args, input, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
		const stdout = []
		const stderr = []
		let stdoutBytes = 0
		let rejected = false
		let timeout
		const rejectOnce = (err) => {
			if (rejected) return
			rejected = true
			if (timeout) clearTimeout(timeout)
			child.kill("SIGKILL")
			reject(err)
		}
		timeout = options.timeoutMs
			? setTimeout(() => rejectOnce(new Error(`${command} timed out`)), options.timeoutMs)
			: undefined
		child.stdout?.on("data", (chunk) => {
			stdoutBytes += chunk.length
			if (options.maxOutputBytes && stdoutBytes > options.maxOutputBytes) {
				rejectOnce(new Error(`${command} output exceeded ${formatSize(options.maxOutputBytes)}`))
				return
			}
			stdout.push(chunk)
		})
		child.stderr?.on("data", (chunk) => stderr.push(chunk))
		child.stdin?.on("error", rejectOnce)
		child.on("error", rejectOnce)
		child.on("exit", (code, signal) => {
			if (rejected) return
			if (timeout) clearTimeout(timeout)
			if (code === 0) resolve(Buffer.concat(stdout))
			else {
				const err = Buffer.concat(stderr).toString("utf8").trim()
				reject(new Error(`${command} failed${signal ? ` (${signal})` : ` (code ${code})`}${err ? `: ${err}` : ""}`))
			}
		})
		child.stdin?.end(input)
	})
}

/**
 * @type {PromptImageResizeBuffer}
 */
export async function resizePromptImageBufferWithFfmpeg(input) {
	const scale = `scale=w='min(${MAX_HIGH_DETAIL_IMAGE_DIMENSION},iw)':h='min(${MAX_HIGH_DETAIL_IMAGE_DIMENSION},ih)':force_original_aspect_ratio=decrease`
	try {
		const output = await runBufferInput("ffmpeg", [
			"-v", "error",
			"-nostdin",
			"-f", "image2pipe",
			"-i", "pipe:0",
			"-map", "0:v:0",
			"-frames:v", "1",
			"-vf", scale,
			"-f", "image2pipe",
			"-c:v", "png",
			"pipe:1",
		], input.buffer, {
			timeoutMs: FFMPEG_RESIZE_TIMEOUT_MS,
			maxOutputBytes: MAX_PROMPT_IMAGE_BYTES,
		})
		return output.length > 0 ? output : null
	} catch {
		return null
	}
}

/**
 * @param {Buffer} buffer
 * @param {{ detail?: ImageDetail, path?: string }} [options]
 * @returns {PromptImageContent}
 */
export function createPromptImageContent(buffer, options = {}) {
	const image = inspectPromptImage(buffer, options)
	const limitError = promptImageLimitError(buffer, image.dimensions, image.detail, image.path)
	if (limitError) throw limitError
	return promptImageContent(buffer, image.mimeType, image.dimensions, image.detail)
}

/**
 * @param {Buffer} buffer
 * @param {{ detail?: ImageDetail, path?: string, resizeImageBuffer?: PromptImageResizeBuffer }} [options]
 * @returns {Promise<PromptImageContent>}
 */
export async function createPromptImageContentAutoResize(buffer, options = {}) {
	const image = inspectPromptImage(buffer, options)
	const limitError = promptImageLimitError(buffer, image.dimensions, image.detail, image.path)
	if (!limitError) return promptImageContent(buffer, image.mimeType, image.dimensions, image.detail)
	if (image.detail === "original" || buffer.byteLength > MAX_PROMPT_IMAGE_RESIZE_INPUT_BYTES) throw limitError

	const resizeImageBuffer = options.resizeImageBuffer ?? resizePromptImageBufferWithFfmpeg
	let resized
	try {
		resized = await resizeImageBuffer({
			buffer,
			mimeType: image.mimeType,
			dimensions: image.dimensions,
			path: image.path,
		})
	} catch {
		throw limitError
	}
	if (!resized) throw limitError

	try {
		const resizedImage = inspectPromptImage(resized, { ...options, detail: image.detail })
		const resizedLimitError = promptImageLimitError(resized, resizedImage.dimensions, resizedImage.detail, resizedImage.path)
		if (resizedLimitError) throw resizedLimitError
		return promptImageContent(
			resized,
			resizedImage.mimeType,
			resizedImage.dimensions,
			resizedImage.detail,
			originalPromptImageContent(buffer, image.mimeType, image.dimensions),
		)
	} catch {
		throw limitError
	}
}

/**
 * @param {PromptImageContent} image
 */
export function promptImageWasResized(image) {
	return !!image.original
}
