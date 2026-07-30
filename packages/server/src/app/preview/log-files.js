import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

const PREVIEW_LOG_IGNORE = "*\n"

function isScopedPreviewLogDirectory(path) {
	return basename(path) === "logs" && basename(dirname(path)) === "previews"
}

function initializeIgnoreSync(directory) {
	if (!isScopedPreviewLogDirectory(directory)) return
	const path = join(directory, ".gitignore")
	if (existsSync(path)) return
	try {
		writeFileSync(path, PREVIEW_LOG_IGNORE)
	} catch {}
}

async function initializeIgnore(directory) {
	if (!isScopedPreviewLogDirectory(directory)) return
	try {
		await writeFile(join(directory, ".gitignore"), PREVIEW_LOG_IGNORE, { flag: "wx" })
	} catch {}
}

export function preparePreviewLogPathSync(path) {
	const directory = dirname(path)
	mkdirSync(directory, { recursive: true })
	initializeIgnoreSync(directory)
}

export async function preparePreviewLogPath(path) {
	const directory = dirname(path)
	await mkdir(directory, { recursive: true })
	await initializeIgnore(directory)
}
