import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { applyProductEnvAliases, productEnvName, readProductEnv } from "../../../protocol/src/product.js"

export const AGENT_COMMANDS_BIN_ENV = productEnvName("COMMANDS_BIN")

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..", "..")

const commands = {
	cerex: "src/tools/cerex.js",
	"cerex-worktree-add": "src/tools/cerex-worktree-add.js",
	"cerex-worktree-close": "src/tools/cerex-worktree-close.js",
	pinano: "src/tools/cerex.js",
	"pinano-worktree-add": "src/tools/cerex-worktree-add.js",
	"pinano-worktree-close": "src/tools/cerex-worktree-close.js",
}

let binDir
let binDirKey

/** @param {string} s */
function shellQuote(s) {
	return `'${String(s).replaceAll("'", "'\\''")}'`
}

function toolTmpdir(baseEnv) {
	const fallbackTmpdir = readProductEnv(baseEnv, "FALLBACK_TOOLS_TMPDIR")
	if (fallbackTmpdir && isAbsolute(fallbackTmpdir)) return resolve(fallbackTmpdir)
	return undefined
}

function createWrapper(commandName, scriptPath, runtimePath) {
	const errorName = commandName
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

function ensureAgentCommands(baseEnv = process.env) {
	const parent = toolTmpdir(baseEnv)
	if (!parent) return undefined
	const key = `${parent}\0${process.execPath}`
	if (binDir && binDirKey === key) return binDir
	const removeParentOnExit = !existsSync(parent)
	mkdirSync(parent, { recursive: true })
	const dir = mkdtempSync(join(parent, ".agent-commands-"))
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

export function envWithAgentCommands(baseEnv = process.env) {
	let bin
	try {
		bin = ensureAgentCommands(baseEnv)
	} catch {
		bin = undefined
	}
	if (!bin) return applyProductEnvAliases({ ...baseEnv })
	return applyProductEnvAliases({
		...baseEnv,
		[AGENT_COMMANDS_BIN_ENV]: bin,
		PATH: baseEnv.PATH ? `${bin}${delimiter}${baseEnv.PATH}` : bin,
	})
}
