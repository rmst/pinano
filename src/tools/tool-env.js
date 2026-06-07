import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, isAbsolute, join, resolve } from "node:path"

import { PINANO_INTERNAL_API_BASE_URL_ENV, PINANO_INTERNAL_API_TOKEN_ENV } from "../internal-api-env.js"
import { envWithFallbackTools } from "./fallback-tools.js"
import { envWithInternalProxyTools } from "./internal-proxy-tools.js"

let gitWrapperBinDir
let gitWrapperBinDirKey

/** @param {string} s */
function shellQuote(s) {
	return `'${String(s).replaceAll("'", "'\\''")}'`
}

function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK)
		return true
	} catch {
		return false
	}
}

function pathEntries(pathEnv) {
	return String(pathEnv || "")
		.split(delimiter)
		.filter(Boolean)
}

function findExecutableOnPath(name, pathEnv, skipDirs = []) {
	const skipped = new Set(skipDirs.filter((dir) => dir && isAbsolute(dir)).map((dir) => resolve(dir)))
	for (const dir of pathEntries(pathEnv)) {
		if (!isAbsolute(dir)) continue
		const absoluteDir = resolve(dir)
		if (skipped.has(absoluteDir)) continue
		const candidate = join(absoluteDir, name)
		if (isExecutable(candidate)) return candidate
	}
	return undefined
}

function toolTmpdir(baseEnv) {
	if (baseEnv.PINANO_FALLBACK_TOOLS_TMPDIR && isAbsolute(baseEnv.PINANO_FALLBACK_TOOLS_TMPDIR)) return resolve(baseEnv.PINANO_FALLBACK_TOOLS_TMPDIR)
	if (baseEnv.PINANO_SESSION_DIR && isAbsolute(baseEnv.PINANO_SESSION_DIR)) return join(resolve(baseEnv.PINANO_SESSION_DIR), "tmp")
	return undefined
}

function withToolCallId(baseEnv, toolCallId) {
	if (toolCallId === undefined || toolCallId === null) return { ...baseEnv }
	return { ...baseEnv, PINANO_TOOL_CALL_ID: String(toolCallId) }
}

function resolveRealGit(baseEnv, wrapperBin) {
	if (baseEnv.PINANO_REAL_GIT && isAbsolute(baseEnv.PINANO_REAL_GIT) && isExecutable(baseEnv.PINANO_REAL_GIT)) return resolve(baseEnv.PINANO_REAL_GIT)
	return findExecutableOnPath("git", baseEnv.PATH, [wrapperBin, baseEnv.PINANO_GIT_WRAPPER_BIN, gitWrapperBinDir])
}

function createGitEventRecorder() {
	return `import * as http from "node:http"

const baseUrl = process.env.${PINANO_INTERNAL_API_BASE_URL_ENV}
const token = process.env.${PINANO_INTERNAL_API_TOKEN_ENV}
if (baseUrl && token) {
	const body = JSON.stringify({
		cwd: process.cwd(),
		argv: process.argv.slice(2),
		toolCallId: process.env.PINANO_TOOL_CALL_ID || undefined,
	})
	try {
		const url = new URL("/internal/git/events", baseUrl)
		const req = http.request(url, {
			method: "POST",
			headers: {
				authorization: \`Bearer \${token}\`,
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body),
			},
		}, (res) => {
			res.resume()
			res.on("end", () => process.exit(0))
		})
		req.on("error", () => process.exit(0))
		req.end(body)
	} catch {
		process.exit(0)
	}
}
`
}

function createGitWrapper(realGitPath, recorderPath, runtimePath) {
	return `#!/bin/sh
record_git_event=0
previous_arg=
for arg in "$@"; do
	if [ "$previous_arg" = "worktree" ] && [ "$arg" = "add" ]; then
		record_git_event=1
		break
	fi
	previous_arg=$arg
done
if [ "$record_git_event" = "1" ]; then
	${shellQuote(runtimePath)} ${shellQuote(recorderPath)} "$@" </dev/null >/dev/null 2>&1 &
fi
exec ${shellQuote(realGitPath)} "$@"
`
}

function ensureGitEventWrapper(baseEnv = process.env) {
	if (!baseEnv[PINANO_INTERNAL_API_BASE_URL_ENV] || !baseEnv[PINANO_INTERNAL_API_TOKEN_ENV]) return undefined
	const parent = toolTmpdir(baseEnv)
	if (!parent) return undefined
	const realGit = resolveRealGit(baseEnv)
	if (!realGit) return undefined
	const key = `${parent}\0${realGit}\0${process.execPath}`
	if (gitWrapperBinDir && gitWrapperBinDirKey === key) return { bin: gitWrapperBinDir, realGit }
	const removeParentOnExit = !existsSync(parent)
	mkdirSync(parent, { recursive: true })
	const dir = mkdtempSync(join(parent, ".pinano-git-wrapper-"))
	const bin = join(dir, "bin")
	try {
		mkdirSync(bin, { recursive: true })
		const recorder = join(dir, "record-git-event.mjs")
		const wrapper = join(bin, "git")
		writeFileSync(recorder, createGitEventRecorder(), { mode: 0o600 })
		writeFileSync(wrapper, createGitWrapper(realGit, recorder, process.execPath))
		chmodSync(wrapper, 0o755)
		gitWrapperBinDir = bin
		gitWrapperBinDirKey = key
		process.once("exit", () => {
			rmSync(dir, { recursive: true, force: true })
			if (removeParentOnExit) {
				try {
					rmSync(parent)
				} catch {}
			}
		})
		return { bin, realGit }
	} catch (err) {
		gitWrapperBinDir = undefined
		gitWrapperBinDirKey = undefined
		rmSync(dir, { recursive: true, force: true })
		throw err
	}
}

export function envWithGitEventWrapper(baseEnv = process.env, options = {}) {
	let wrapper
	try {
		wrapper = ensureGitEventWrapper(baseEnv)
	} catch {
		wrapper = undefined
	}
	const env = withToolCallId(baseEnv, options.toolCallId)
	if (!wrapper) return env
	const path = baseEnv.PATH ? `${wrapper.bin}${delimiter}${baseEnv.PATH}` : wrapper.bin
	return {
		...env,
		PINANO_REAL_GIT: wrapper.realGit,
		PINANO_GIT_WRAPPER_BIN: wrapper.bin,
		PATH: path,
	}
}

export function envForToolSubprocess(baseEnv = process.env, options = {}) {
	return envWithFallbackTools(envWithInternalProxyTools(envWithGitEventWrapper(baseEnv, options)))
}
