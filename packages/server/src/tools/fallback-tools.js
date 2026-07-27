import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..", "..")

const fallbackTools = {
	base64: "src/fallback-tools/base64.js",
	curl: "src/fallback-tools/curl.js",
	jq: "src/fallback-tools/jq.js",
	sqlite3: "src/fallback-tools/sqlite3.js",
}

let binDir
let binDirKey

/** @param {string} s */
function shellQuote(s) {
	return `'${String(s).replaceAll("'", "'\\''")}'`
}

function createWrapper(toolName, scriptPath, fallbackRuntime) {
	return `#!/bin/sh
script=${shellQuote(scriptPath)}
fallback_runtime=${shellQuote(fallbackRuntime)}
node_ok() {
	command -v node >/dev/null 2>&1 || return 1
	node -e 'const [major] = process.versions.node.split(".").map(Number); process.exit(major >= 18 ? 0 : 1)' >/dev/null 2>&1
}
if node_ok; then
	exec node "$script" "$@"
elif [ -x "$fallback_runtime" ]; then
	exec "$fallback_runtime" "$script" "$@"
elif command -v qn >/dev/null 2>&1; then
	exec qn "$script" "$@"
else
	echo "cerex ${toolName} fallback requires node or qn" >&2
	exit 127
fi
`
}

function createRuntimeWrapper(runtimePath) {
	return `#!/bin/sh
exec ${shellQuote(runtimePath)} "$@"
`
}

function runtimeWrapperNames(runtimePath) {
	const name = basename(runtimePath)
	if (name === "node" || name === "qn") return [name]
	return []
}

function fallbackToolsTmpdir(baseEnv) {
	const configured = baseEnv.CEREX_FALLBACK_TOOLS_TMPDIR
	if (!configured) return tmpdir()
	if (!isAbsolute(configured)) throw new Error(`CEREX_FALLBACK_TOOLS_TMPDIR must be absolute: ${configured}`)
	return resolve(configured)
}

function ensureFallbackToolsBin(baseEnv = process.env) {
	const parent = fallbackToolsTmpdir(baseEnv)
	const key = parent
	if (binDir && binDirKey === key) return binDir
	const removeParentOnExit = !existsSync(parent)
	mkdirSync(parent, { recursive: true })
	const dir = mkdtempSync(join(parent, ".fallback-tools-"))
	const bin = join(dir, "bin")
	binDir = bin
	binDirKey = key
	try {
		mkdirSync(bin, { recursive: true })
		for (const [toolName, relativeScript] of Object.entries(fallbackTools)) {
			const path = join(bin, toolName)
			writeFileSync(path, createWrapper(toolName, join(repoRoot, relativeScript), process.execPath))
			chmodSync(path, 0o755)
		}
		for (const runtimeName of runtimeWrapperNames(process.execPath)) {
			const path = join(bin, runtimeName)
			if (existsSync(path)) continue
			writeFileSync(path, createRuntimeWrapper(process.execPath))
			chmodSync(path, 0o755)
		}
		process.once("exit", () => {
			rmSync(dir, { recursive: true, force: true })
			if (removeParentOnExit) {
				try {
					rmSync(parent)
				} catch {}
			}
		})
		return bin
	} catch (err) {
		binDir = undefined
		binDirKey = undefined
		rmSync(dir, { recursive: true, force: true })
		throw err
	}
}

/**
 * Return an environment for shell commands with Cerex fallback tools appended
 * to PATH. Appending is deliberate: real system tools always win.
 *
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function envWithFallbackTools(baseEnv = process.env) {
	const bin = ensureFallbackToolsBin(baseEnv)
	const path = baseEnv.PATH ? `${baseEnv.PATH}:${bin}` : bin
	return {
		...baseEnv,
		PATH: path,
	}
}

export function fallbackToolNames() {
	return Object.keys(fallbackTools)
}
