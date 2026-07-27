import { spawn } from "node:child_process"
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
	createPromptImageContentAutoResize,
	MAX_PROMPT_IMAGE_BYTES,
	MAX_PROMPT_IMAGE_RESIZE_INPUT_BYTES,
} from "../tools/image-prompt.js"
import { detectImageMime } from "../tools/mime.js"
import { formatSize } from "../tools/truncate.js"

const LINUX_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]
const WSL_POWERSHELL_COMMAND = "powershell.exe"
const MAC_IMAGE_FORMATS = [
	{ code: "PNGf", extension: "png" },
	{ code: "JPEG", extension: "jpg" },
	{ code: "GIFf", extension: "gif" },
	{ code: "TIFF", extension: "tiff", convertTo: "png" },
]
const MAC_CLIPBOARD_IMAGE_INFO_RE = /\b(?:PNGf|JPEG|GIFf|TIFF)\b|(?:PNG|JPEG|GIF|TIFF) picture|public\.(?:png|jpeg|tiff|gif)|com\.compuserve\.gif/i
const MAC_CLIPBOARD_FILE_INFO_RE = /\bfurl\b|file URL/i
const IMAGE_MIME_SNIFF_BYTES = 12
const WSL_CLIPBOARD_IMAGE_SCRIPT = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {
	[Console]::Error.WriteLine("clipboard does not contain an image")
	exit 2
}
$image = [System.Windows.Forms.Clipboard]::GetImage()
$stream = New-Object System.IO.MemoryStream
try {
	$image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
	$bytes = $stream.ToArray()
	[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
} finally {
	if ($null -ne $image) { $image.Dispose() }
	$stream.Dispose()
}
`

/**
 * @typedef {{ command: string, args: string[] }} ClipboardCommand
 * @typedef {{ type: "image", data: string, mimeType: string, detail: "high" | "original", widthPx: number, heightPx: number, original?: { data: string, mimeType: string, widthPx: number, heightPx: number } }} ClipboardImageContent
 * @typedef {"noImage" | "unsupported" | "unavailable"} ClipboardImagePasteErrorKind
 */

export class ClipboardImagePasteError extends Error {
	/**
	 * @param {ClipboardImagePasteErrorKind} kind
	 * @param {string} message
	 * @param {{ details?: string[] }} [options]
	 */
	constructor(kind, message, options = {}) {
		super(message)
		this.name = "ClipboardImagePasteError"
		this.kind = kind
		this.details = options.details ?? []
	}
}

/** @param {unknown} err */
export function clipboardImagePasteNotice(err) {
	if (err instanceof ClipboardImagePasteError && err.kind === "noImage") return ""
	if (err instanceof ClipboardImagePasteError) return err.message
	return "Could not paste clipboard image"
}

/** @param {string} command @param {string[]} args @param {{ timeoutMs?: number }} [options] */
function runBuffer(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
		const stdout = []
		const stderr = []
		let rejected = false
		let timeout
		const rejectOnce = (err) => {
			if (rejected) return
			rejected = true
			if (timeout) clearTimeout(timeout)
			reject(err)
		}
		timeout = options.timeoutMs
			? setTimeout(() => {
				child.kill("SIGKILL")
				rejectOnce(new Error(`${command} timed out`))
			}, options.timeoutMs)
			: undefined
		child.stdout?.on("data", (chunk) => stdout.push(chunk))
		child.stderr?.on("data", (chunk) => stderr.push(chunk))
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
	})
}

/** @param {string} command */
async function commandAvailable(command) {
	try {
		const out = await runBuffer("sh", ["-lc", `command -v ${command}`], { timeoutMs: 1000 })
		return out.toString("utf8").trim().length > 0
	} catch {
		return false
	}
}

/** @param {string} mimeType @returns {ClipboardCommand[]} */
const linuxCommandsForMime = (mimeType) => [
	{ command: "wl-paste", args: ["--type", mimeType] },
	{ command: "xclip", args: ["-selection", "clipboard", "-t", mimeType, "-o"] },
]

/** @param {string} text */
function utf16LeBase64(text) {
	const bytes = new Uint8Array(text.length * 2)
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		bytes[i * 2] = code & 0xff
		bytes[i * 2 + 1] = code >> 8
	}
	return Buffer.from(bytes).toString("base64")
}

const wslPowerShellClipboardImageCommand = () => ({
	command: WSL_POWERSHELL_COMMAND,
	args: ["-NoProfile", "-NonInteractive", "-Sta", "-EncodedCommand", utf16LeBase64(WSL_CLIPBOARD_IMAGE_SCRIPT)],
})

/** @param {unknown} value */
const envHasWslMarker = (value) => typeof value === "string" && value.length > 0

async function detectWsl(options = {}) {
	if (typeof options.isWsl === "boolean") return options.isWsl
	const env = options.env ?? process.env
	if (envHasWslMarker(env.WSL_INTEROP) || envHasWslMarker(env.WSL_DISTRO_NAME)) return true
	try {
		const version = await readFile("/proc/version", "utf8")
		return /microsoft|wsl/i.test(version)
	} catch {
		return false
	}
}

/** @param {string} value */
function appleScriptString(value) {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** @param {string} code */
const appleEventClass = (code) => `${String.fromCharCode(0x00ab)}class ${code}${String.fromCharCode(0x00bb)}`

/**
 * @param {string} code
 * @param {string} path
 */
const macClipboardExtractionScript = (code, path) => [
	"set theFile to missing value",
	"try",
	`set theImage to the clipboard as ${appleEventClass(code)}`,
	`set theFile to open for access POSIX file ${appleScriptString(path)} with write permission`,
	"set eof of theFile to 0",
	"write theImage to theFile",
	"close access theFile",
	"on error errMsg number errNum",
	"try",
	"if theFile is not missing value then close access theFile",
	"end try",
	"error errMsg number errNum",
	"end try",
]

const macClipboardFilePathScript = () => [
	"try",
	"set theFile to the clipboard as alias",
	"return POSIX path of theFile",
	"on error errMsg number errNum",
	"error errMsg number errNum",
	"end try",
]

async function readMacClipboardInfo(run, errors) {
	try {
		const out = await run("osascript", ["-e", "clipboard info"], { timeoutMs: 2000 })
		const info = out.toString("utf8").trim()
		if (!info) errors.push("macOS clipboard info: empty output")
		return info
	} catch (err) {
		errors.push(`macOS clipboard info: ${err?.message ?? err}`)
		return ""
	}
}

/**
 * @param {Buffer} buffer
 * @param {string} source
 * @param {string[]} errors
 */
function supportedImageBuffer(buffer, source, errors) {
	if (buffer.length === 0) {
		errors.push(`${source}: empty output`)
		return false
	}
	if (!detectImageMime(buffer)) {
		errors.push(`${source}: output was not a supported image`)
		return false
	}
	return true
}

/** @param {string} path */
async function readFilePrefix(path) {
	const handle = await open(path, "r")
	try {
		const buffer = Buffer.alloc(IMAGE_MIME_SNIFF_BYTES)
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
		return buffer.subarray(0, bytesRead)
	} finally {
		await handle.close()
	}
}

async function readMacClipboardFileImage(run, errors) {
	try {
		const out = await run("osascript", macClipboardFilePathScript().flatMap((line) => ["-e", line]), { timeoutMs: 2000 })
		const path = out.toString("utf8").trim()
		if (!path) {
			errors.push("macOS clipboard file: empty file path")
			return null
		}
		const file = await stat(path)
		if (!file.isFile()) {
			errors.push("macOS clipboard file: path is not a file")
			return null
		}
		const prefix = await readFilePrefix(path)
		if (!detectImageMime(prefix)) {
			errors.push("macOS clipboard file: output was not a supported image")
			return null
		}
		if (file.size > MAX_PROMPT_IMAGE_RESIZE_INPUT_BYTES) {
			throw new ClipboardImagePasteError(
				"unsupported",
				`Image from clipboard is ${formatSize(file.size)}, which exceeds Cerex's ${formatSize(MAX_PROMPT_IMAGE_BYTES)} prompt image limit`,
			)
		}
		const buffer = await readFile(path)
		return supportedImageBuffer(buffer, "macOS clipboard file", errors) ? buffer : null
	} catch (err) {
		if (err instanceof ClipboardImagePasteError) throw err
		errors.push(`macOS clipboard file: ${err?.message ?? err}`)
		return null
	}
}

async function tryClipboardCommand(run, command, args, source, errors) {
	try {
		const buffer = await run(command, args, { timeoutMs: 5000 })
		return supportedImageBuffer(buffer, source, errors) ? buffer : null
	} catch (err) {
		errors.push(`${source}: ${err?.message ?? err}`)
		return null
	}
}

async function readMacClipboardImage(options = {}) {
	const run = options.runBuffer ?? runBuffer
	const dir = await mkdtemp(join(tmpdir(), "clipboard-"))
	const errors = []
	try {
		const info = await readMacClipboardInfo(run, errors)
		if (!info) {
			throw new ClipboardImagePasteError("unavailable", "Could not access the macOS clipboard", { details: errors })
		}
		const hasImageData = MAC_CLIPBOARD_IMAGE_INFO_RE.test(info)
		const hasFileData = MAC_CLIPBOARD_FILE_INFO_RE.test(info)
		if (!hasImageData && !hasFileData) {
			throw new ClipboardImagePasteError("noImage", "No image on clipboard")
		}

		if (hasImageData) {
			for (const format of MAC_IMAGE_FORMATS) {
				const path = join(dir, `clipboard.${format.extension}`)
				try {
					await run("osascript", macClipboardExtractionScript(format.code, path).flatMap((line) => ["-e", line]), { timeoutMs: 5000 })
					if (format.convertTo === "png") {
						const convertedPath = join(dir, `clipboard-${format.code}.png`)
						await run("sips", ["-s", "format", "png", path, "--out", convertedPath], { timeoutMs: 5000 })
						const buffer = await readFile(convertedPath)
						if (supportedImageBuffer(buffer, `macOS clipboard ${format.code}`, errors)) return buffer
					} else {
						const buffer = await readFile(path)
						if (supportedImageBuffer(buffer, `macOS clipboard ${format.code}`, errors)) return buffer
					}
				} catch (err) {
					errors.push(`macOS clipboard ${format.code}: ${err?.message ?? err}`)
				}
			}
		}
		if (hasFileData) {
			const fileBuffer = await readMacClipboardFileImage(run, errors)
			if (fileBuffer) return fileBuffer
			if (!hasImageData) {
				throw new ClipboardImagePasteError("noImage", "No image on clipboard", { details: errors })
			}
		}

		throw new ClipboardImagePasteError("unsupported", "Could not read a supported image from the clipboard", { details: errors })
	} catch (err) {
		if (err instanceof ClipboardImagePasteError) throw err
		throw new ClipboardImagePasteError("unavailable", "Could not access the macOS clipboard", { details: [String(err?.message ?? err)] })
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {})
	}
}

async function readLinuxClipboardImage(options = {}) {
	const run = options.runBuffer ?? runBuffer
	const available = options.commandAvailable ?? commandAvailable
	const candidates = []
	for (const command of ["wl-paste", "xclip"]) {
		if (await available(command)) candidates.push(command)
	}
	const isWsl = await detectWsl(options)
	const canUseWslPowerShell = isWsl && await available(WSL_POWERSHELL_COMMAND)
	if (candidates.length === 0 && !canUseWslPowerShell) {
		const wslHint = isWsl ? ", or enable WSL Windows interop so powershell.exe is available" : ""
		throw new ClipboardImagePasteError(
			"unavailable",
			`Clipboard image paste needs wl-clipboard (wl-paste), xclip, or powershell.exe WSL clipboard interop${wslHint}`,
		)
	}

	const errors = []
	for (const mimeType of LINUX_IMAGE_MIME_TYPES) {
		for (const candidate of linuxCommandsForMime(mimeType).filter((cmd) => candidates.includes(cmd.command))) {
			const buffer = await tryClipboardCommand(run, candidate.command, candidate.args, `${candidate.command} ${mimeType}`, errors)
			if (buffer) return buffer
		}
	}
	if (canUseWslPowerShell) {
		const candidate = wslPowerShellClipboardImageCommand()
		const buffer = await tryClipboardCommand(run, candidate.command, candidate.args, `${candidate.command} WSL clipboard`, errors)
		if (buffer) return buffer
	}

	throw new ClipboardImagePasteError("unsupported", "Could not read a supported image from the clipboard", { details: errors })
}

/**
 * Read an image from the platform clipboard and return a Cerex prompt image block.
 * @param {{ platform?: string, runBuffer?: typeof runBuffer, commandAvailable?: typeof commandAvailable, isWsl?: boolean, env?: NodeJS.ProcessEnv, resizeImageBuffer?: import("../tools/image-prompt.js").PromptImageResizeBuffer }} [options]
 * @returns {Promise<ClipboardImageContent>}
 */
export async function readClipboardImage(options = {}) {
	const platform = options.platform ?? process.platform
	const buffer = platform === "darwin"
		? await readMacClipboardImage(options)
		: platform === "linux"
			? await readLinuxClipboardImage(options)
			: undefined
	if (!buffer) throw new ClipboardImagePasteError("unavailable", `Clipboard image paste is not supported on ${platform}`)
	try {
		return await createPromptImageContentAutoResize(buffer, { path: "from clipboard", resizeImageBuffer: options.resizeImageBuffer })
	} catch (err) {
		throw new ClipboardImagePasteError("unsupported", err?.message ?? "Could not read a supported image from the clipboard")
	}
}
