#!/usr/bin/env node
import { runReexecSupervisor } from "./reexec.js"

function failUsage() {
	console.error("usage: reexec-supervisor-main.js -- <command> [args...]")
	process.exit(2)
}

const argv = process.argv.slice(2)
if (argv[0] !== "--") failUsage()
const command = argv[1]
if (!command) failUsage()

await runReexecSupervisor({
	command,
	args: argv.slice(2),
	cwd: process.cwd(),
	env: process.env,
})
