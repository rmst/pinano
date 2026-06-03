import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createPromptImageContent } from "../tools/image-prompt.js"
import { detectImageMime } from "../tools/mime.js"

const LINUX_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]
const WSL_POWERSHELL_COMMAND = "powershell.exe"
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
 * @typedef {{ type: "image", data: string, mimeType: string, detail: "high" | "original", widthPx: number, heightPx: number }} ClipboardImageContent
 */

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

async function tryClipboardCommand(run, command, args, source, errors) {
	try {
		const buffer = await run(command, args, { timeoutMs: 5000 })
		if (buffer.length === 0) {
			errors.push(`${source}: empty output`)
			return null
		}
		if (!detectImageMime(buffer)) {
			errors.push(`${source}: output was not a supported image`)
			return null
		}
		return buffer
	} catch (err) {
		errors.push(`${source}: ${err?.message ?? err}`)
		return null
	}
}

async function readMacClipboardImage(options = {}) {
	const run = options.runBuffer ?? runBuffer
	const dir = await mkdtemp(join(tmpdir(), "pinano-clipboard-"))
	const path = join(dir, "clipboard.png")
	const pngClass = `${String.fromCharCode(0x00ab)}class PNGf${String.fromCharCode(0x00bb)}`
	try {
		await run("osascript", [
			"-e", `set theImage to the clipboard as ${pngClass}`,
			"-e", `set theFile to open for access POSIX file "${path}" with write permission`,
			"-e", "write theImage to theFile",
			"-e", "close access theFile",
		], { timeoutMs: 5000 })
		return await readFile(path)
	} catch (err) {
		throw new Error(`failed to read image from macOS clipboard: ${err?.message ?? err}`)
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
		throw new Error(`no Linux clipboard image tool found; install wl-clipboard (recommended; provides wl-paste), or xclip as an X11 fallback${wslHint}`)
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

	throw new Error(`failed to read image from Linux clipboard (${errors.join("; ")})`)
}

/**
 * Read an image from the platform clipboard and return a Pinano prompt image block.
 * @param {{ platform?: string, runBuffer?: typeof runBuffer, commandAvailable?: typeof commandAvailable, isWsl?: boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<ClipboardImageContent>}
 */
export async function readClipboardImage(options = {}) {
	const platform = options.platform ?? process.platform
	const buffer = platform === "darwin"
		? await readMacClipboardImage(options)
		: platform === "linux"
			? await readLinuxClipboardImage(options)
			: undefined
	if (!buffer) throw new Error(`clipboard image paste is not supported on ${platform}`)
	return createPromptImageContent(buffer, { path: "from clipboard" })
}
