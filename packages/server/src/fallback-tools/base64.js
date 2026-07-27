#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const VERSION = "cerex-base64 0.1 base64-compatible subset"

class Base64Error extends Error {
	constructor(message, exitCode = 1) {
		super(message)
		this.exitCode = exitCode
	}
}

function usage() {
	return `${VERSION}

Supported subset: encode/decode stdin or files, -d/--decode, -i/--ignore-garbage,
-w/--wrap COLS (including -w0), -b COLS, --version, --help.
Unsupported options fail clearly.
`
}

function parseArgs(args) {
	const config = {
		decode: false,
		ignoreGarbage: false,
		wrap: 76,
		files: [],
	}
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]
		if (arg === "--") {
			config.files.push(...args.slice(i + 1))
			break
		}
		if (arg === "--version") return { ...config, version: true }
		if (arg === "--help" || arg === "-h") return { ...config, help: true }
		if (arg === "--decode") config.decode = true
		else if (arg === "--ignore-garbage") config.ignoreGarbage = true
		else if (arg === "--wrap") {
			const [value, used] = takeValue(args, i, arg)
			config.wrap = parseWrap(value)
			i = used
		} else if (arg.startsWith("--wrap=")) {
			config.wrap = parseWrap(arg.slice("--wrap=".length))
		} else if (arg.startsWith("--")) {
			throw new Base64Error(`unsupported option ${arg}`, 2)
		} else if (arg.startsWith("-") && arg !== "-") {
			for (let j = 1; j < arg.length; j += 1) {
				const flag = arg[j]
				if (flag === "d" || flag === "D") config.decode = true
				else if (flag === "i") config.ignoreGarbage = true
				else if (flag === "w" || flag === "b") {
					const inline = j + 1 < arg.length ? arg.slice(j + 1) : undefined
					const [value, used] = takeValue(args, i, `-${flag}`, inline)
					config.wrap = parseWrap(value)
					i = used
					break
				} else {
					throw new Base64Error(`unsupported option -${flag}`, 2)
				}
			}
		} else {
			config.files.push(arg)
		}
	}
	return config
}

function takeValue(args, index, label, inline) {
	if (inline !== undefined) return [inline, index]
	if (index + 1 >= args.length) throw new Base64Error(`option ${label} requires an argument`, 2)
	return [args[index + 1], index + 1]
}

function parseWrap(value) {
	const number = Number(value)
	if (!Number.isInteger(number) || number < 0) throw new Base64Error("wrap column count must be a non-negative integer", 2)
	return number
}

async function readInput(files) {
	if (files.length === 0) return readStdin()
	const buffers = []
	for (const file of files) buffers.push(file === "-" ? await readStdin() : await readFile(file))
	return Buffer.concat(buffers)
}

async function readStdin() {
	const chunks = []
	return new Promise((resolvePromise, reject) => {
		process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
		process.stdin.on("end", () => resolvePromise(Buffer.concat(chunks)))
		process.stdin.on("error", reject)
		process.stdin.resume?.()
	})
}

function encode(buffer, wrap) {
	const text = buffer.toString("base64")
	return `${wrapText(text, wrap)}\n`
}

function wrapText(text, columns) {
	if (columns === 0 || text.length <= columns) return text
	const lines = []
	for (let index = 0; index < text.length; index += columns) lines.push(text.slice(index, index + columns))
	return lines.join("\n")
}

function decode(buffer, ignoreGarbage) {
	let text = buffer.toString("utf-8")
	if (ignoreGarbage) text = text.replace(/[^A-Za-z0-9+/=]/g, "")
	else {
		const compact = text.replace(/[\t\n\r ]/g, "")
		if (/[^A-Za-z0-9+/=]/.test(compact)) throw new Base64Error("invalid base64 input", 1)
		text = compact
	}
	return Buffer.from(text, "base64")
}

async function run(config) {
	const input = await readInput(config.files)
	if (config.decode) {
		process.stdout.write(decode(input, config.ignoreGarbage))
	} else {
		process.stdout.write(encode(input, config.wrap))
	}
	return 0
}

async function main() {
	try {
		const config = parseArgs(process.argv.slice(2))
		if (config.version) {
			process.stdout.write(`${VERSION}\n`)
			return 0
		}
		if (config.help) {
			process.stdout.write(usage())
			return 0
		}
		return await run(config)
	} catch (err) {
		const code = err?.exitCode ?? 1
		process.stderr.write(`cerex base64 fallback: ${err?.message || err}\n`)
		if (code === 2) process.stderr.write("This fallback only supports common base64 usage. Install base64 for full support.\n")
		return code
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	process.exitCode = await main()
}
