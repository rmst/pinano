import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const PINANO_COMMANDS_BIN_ENV = "PINANO_COMMANDS_BIN"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..", "..")

const commands = {
	pinano: "src/tools/pinano.js",
	"pinano-worktree-add": "src/tools/pinano-worktree-add.js",
	"pinano-worktree-close": "src/tools/pinano-worktree-close.js",
}

let binDir
let binDirKey

/** @param {string} s */
function shellQuote(s) {
	return `'${String(s).replaceAll("'", "'\\''")}'`
}

function toolTmpdir(baseEnv) {
	if (baseEnv.PINANO_FALLBACK_TOOLS_TMPDIR && isAbsolute(baseEnv.PINANO_FALLBACK_TOOLS_TMPDIR)) return resolve(baseEnv.PINANO_FALLBACK_TOOLS_TMPDIR)
	if (baseEnv.PINANO_SESSION_DIR && isAbsolute(baseEnv.PINANO_SESSION_DIR)) return join(resolve(baseEnv.PINANO_SESSION_DIR), ".tmp")
	return undefined
}

function createWrapper(commandName, scriptPath, runtimePath) {
	const errorName = commandName === "pinano" ? "pinano" : commandName
	return `#!/bin/sh
script=${shellQuote(scriptPath)}
runtime=${shellQuote(runtimePath)}
node_ok() {
	command -v node >/dev/null 2>&1 || return 1
	node -e 'const [major] = process.versions.node.split(".").map(Number); process.exit(major >= 18 ? 0 : 1)' >/dev/null 2>&1
}
if node_ok; then
	exec node "$script" "$@"
elif [ -x "$runtime" ]; then
	exec "$runtime" "$script" "$@"
elif command -v qn >/dev/null 2>&1; then
	exec qn "$script" "$@"
else
	echo "${errorName} requires node or qn" >&2
	exit 127
fi
`
}

function ensurePinanoCommands(baseEnv = process.env) {
	const parent = toolTmpdir(baseEnv)
	if (!parent) return undefined
	const key = `${parent}\0${process.execPath}`
	if (binDir && binDirKey === key) return binDir
	const removeParentOnExit = !existsSync(parent)
	mkdirSync(parent, { recursive: true })
	const dir = mkdtempSync(join(parent, ".pinano-commands-"))
	const bin = join(dir, "bin")
	try {
		mkdirSync(bin, { recursive: true })
		for (const [commandName, relativeScript] of Object.entries(commands)) {
			const path = join(bin, commandName)
			writeFileSync(path, createWrapper(commandName, join(repoRoot, relativeScript), process.execPath))
			chmodSync(path, 0o755)
		}
		binDir = bin
		binDirKey = key
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

export function envWithPinanoCommands(baseEnv = process.env) {
	let bin
	try {
		bin = ensurePinanoCommands(baseEnv)
	} catch {
		bin = undefined
	}
	if (!bin) return { ...baseEnv }
	return {
		...baseEnv,
		[PINANO_COMMANDS_BIN_ENV]: bin,
		PATH: baseEnv.PATH ? `${bin}${delimiter}${baseEnv.PATH}` : bin,
	}
}
