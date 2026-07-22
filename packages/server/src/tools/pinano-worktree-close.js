#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { PINANO_INTERNAL_API_BASE_URL_ENV, PINANO_INTERNAL_API_TOKEN_ENV } from "../../../protocol/src/internal-api-env.js"
import { GIT_WORKTREE_CLOSE_OPERATION, GIT_WORKTREE_TERMINAL_APPLIED, GIT_WORKTREE_TERMINAL_DISCARDED, PINANO_WORKTREE_EVENT_ROUTE } from "../app/git-worktree-events.js"
import { CliError, gitOutput, postInternalEvent } from "./pinano-worktree-command-utils.js"

const VERSION = "pinano-worktree-close 0.1"
const CLOSE_TIMEOUT_MS = 30000

function usage() {
	return `${VERSION}

Usage:
  pinano-worktree-close (--applied | --discarded) [--path <path>]

Closes a Pinano-tracked Git worktree, records its terminal lifecycle state,
removes the Git worktree, and deletes its branch.

Options:
  --applied       mark the worktree's changes as integrated
  --discarded     mark the worktree as intentionally abandoned
  --path <path>   close a specific worktree path instead of the current worktree
  -h, --help      show this help
  --version       show version
`
}

function takeValue(args, index, label, inline) {
	if (inline !== undefined) return [inline, index]
	if (index + 1 >= args.length) throw new CliError(`option ${label} requires an argument`, 2)
	return [args[index + 1], index + 1]
}

export function parseArgs(args) {
	const config = {}
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]
		if (arg === "-h" || arg === "--help") {
			return { ...config, help: true }
		} else if (arg === "--version") {
			return { ...config, version: true }
		} else if (arg === "--applied") {
			if (config.terminalState) throw new CliError("choose only one of --applied or --discarded", 2)
			config.terminalState = GIT_WORKTREE_TERMINAL_APPLIED
		} else if (arg === "--discarded") {
			if (config.terminalState) throw new CliError("choose only one of --applied or --discarded", 2)
			config.terminalState = GIT_WORKTREE_TERMINAL_DISCARDED
		} else if (arg === "--path") {
			const [value, used] = takeValue(args, i, arg)
			config.path = value
			i = used
		} else if (arg.startsWith("--path=")) {
			config.path = arg.slice("--path=".length)
		} else if (arg.startsWith("-")) {
			throw new CliError(`unsupported option ${arg}`, 2)
		} else {
			throw new CliError(`unexpected argument ${arg}`, 2)
		}
	}
	if (config.help || config.version) return config
	if (!config.terminalState) throw new CliError("choose one of --applied or --discarded", 2)
	return config
}

function responseError(response) {
	const bodyError = response?.body && typeof response.body.error === "string" ? response.body.error : undefined
	const cleanup = response?.body?.cleanup
	const details = []
	if (response?.body?.recorded === true) details.push("close event recorded")
	if (response?.body?.recorded === false) details.push("close event not recorded")
	if (cleanup?.worktree?.worktreePathRemoved === true) details.push("worktree path removed")
	if (cleanup?.worktree?.worktreePathRemoved === false) details.push("worktree path still exists")
	if (cleanup?.worktree?.worktreeRemoveError) details.push(`worktree remove: ${cleanup.worktree.worktreeRemoveError}`)
	if (cleanup?.worktree?.leftoverRemovalError) details.push(`leftover cleanup: ${cleanup.worktree.leftoverRemovalError}`)
	if (cleanup?.branch?.branchDeleteError) details.push(`branch delete: ${cleanup.branch.branchDeleteError}`)
	if (cleanup?.branch?.branchDeleteSkipped) details.push(`branch not deleted: ${cleanup.branch.branchDeleteSkipped}`)
	return [bodyError || response?.text || "Pinano could not close the worktree", ...details].filter(Boolean).join("\n")
}

function cleanupLines(body = {}) {
	const lines = []
	const branch = body.cleanup?.branch
	const worktree = body.cleanup?.worktree
	if (body.alreadyClosed) lines.push("already closed")
	if (branch?.branchDeleted === true && branch.branch) lines.push(`deleted branch ${branch.branch}`)
	if (branch?.branchDeleteSkipped) lines.push(`branch not deleted: ${branch.branchDeleteSkipped}`)
	if (worktree?.worktreePathRemoved === false) lines.push("worktree path still exists")
	return lines
}

export async function runPinanoWorktreeClose(config, options = {}) {
	const cwd = resolve(options.cwd ?? process.cwd())
	const env = options.env ?? process.env
	if (!env[PINANO_INTERNAL_API_BASE_URL_ENV] || !env[PINANO_INTERNAL_API_TOKEN_ENV]) {
		throw new CliError("pinano-worktree-close must be run from a Pinano tool session")
	}
	const path = config.path
		? resolve(cwd, config.path)
		: await gitOutput(["rev-parse", "--show-toplevel"], cwd)
	if (!isAbsolute(path)) throw new CliError("worktree path must be absolute", 2)
	const response = await postInternalEvent(env[PINANO_INTERNAL_API_BASE_URL_ENV], env[PINANO_INTERNAL_API_TOKEN_ENV], PINANO_WORKTREE_EVENT_ROUTE, {
		version: 1,
		operation: GIT_WORKTREE_CLOSE_OPERATION,
		path,
		terminalState: config.terminalState,
		toolCallId: env.PINANO_TOOL_CALL_ID || undefined,
	}, { timeoutMs: CLOSE_TIMEOUT_MS })
	if (!response.ok) throw new CliError(responseError(response), response.status >= 400 && response.status < 500 ? 2 : 1)
	if (response.body?.recorded === false && response.body?.alreadyClosed !== true) throw new CliError("Pinano did not record the worktree close event", 1)
	process.stdout.write(`closed worktree ${path}\n`)
	process.stdout.write(`${config.terminalState}\n`)
	for (const line of cleanupLines(response.body)) process.stdout.write(`${line}\n`)
	return { path, terminalState: config.terminalState, response: response.body }
}

export async function main(argv = process.argv.slice(2), options = {}) {
	try {
		const config = parseArgs(argv)
		if (config.version) {
			process.stdout.write(`${VERSION}\n`)
			return 0
		}
		if (config.help) {
			process.stdout.write(usage())
			return 0
		}
		await runPinanoWorktreeClose(config, options)
		return 0
	} catch (err) {
		process.stderr.write(`${err?.message ?? String(err)}\n`)
		return err?.exitCode ?? 1
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = await main()
}
