#!/usr/bin/env -S node --no-warnings
import { fileURLToPath } from "node:url"

import { applyProductEnvAliases } from "../packages/protocol/src/product.js"
import { runReexecSupervisor } from "../packages/server/src/app/runtime/reexec.js"

applyProductEnvAliases(process.env)

await runReexecSupervisor({
	command: process.execPath,
	args: [...process.execArgv, fileURLToPath(new URL("../cli/main.js", import.meta.url)), ...process.argv.slice(2)],
	cwd: process.cwd(),
	env: process.env,
})
