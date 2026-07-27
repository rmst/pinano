#!/usr/bin/env node

import { constants, existsSync } from "node:fs"
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { INTERNAL_API_BASE_URL_ENV, INTERNAL_API_TOKEN_ENV } from "../../../protocol/src/internal-api-env.js"
import { applyProductEnvAliases, LEGACY_PRODUCT_STATE_DIRECTORY, PRODUCT_STATE_DIRECTORY, PROJECT_DOCUMENTS_DIRECTORY_NAME, readProductEnv } from "../../../protocol/src/product.js"
import { GIT_WORKTREE_ADD_OPERATION, CREATED_AT_CONFIG, INITIAL_HEAD_CONFIG, INTEGRATION_TARGET_CONFIG, WORKTREE_EVENT_ROUTE } from "../app/source-control/worktree-events.js"
import { ensureProjectStateDirectoryIgnored } from "../app/project/labels.js"
import { CliError, commandResult, gitOutput, postInternalEvent, run } from "./worktree-command-utils.js"

const VERSION = "cerex-worktree-add 0.1"

function usage() {
	return `${VERSION}

Usage:
  cerex-worktree-add [options] <name> [<start-point>]

Creates a short-lived Cerex-managed Git worktree. The worktree path defaults to
<repo>/.cerex/wt/<name>. Without <start-point>, the integration target is used.

Options:
  --integration-target <branch>   branch where this work should eventually land
  -b, --branch <branch>           branch to create for the new worktree
  --path <path>                   override the default worktree path
  --copy                          copy ignored files (default)
  --no-copy                       do not copy ignored files
  -h, --help                      show this help
  --version                       show version
`
}

function takeValue(args, index, label, inline) {
	if (inline !== undefined) return [inline, index]
	if (index + 1 >= args.length) throw new CliError(`option ${label} requires an argument`, 2)
	return [args[index + 1], index + 1]
}

export function parseArgs(args) {
	const config = {
		copy: "force",
		positionals: [],
	}
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]
		if (arg === "--") {
			config.positionals.push(...args.slice(i + 1))
			break
		} else if (arg === "-h" || arg === "--help") {
			return { ...config, help: true }
		} else if (arg === "--version") {
			return { ...config, version: true }
		} else if (arg === "--integration-target") {
			const [value, used] = takeValue(args, i, arg)
			config.integrationTarget = value
			i = used
		} else if (arg.startsWith("--integration-target=")) {
			config.integrationTarget = arg.slice("--integration-target=".length)
		} else if (arg === "-b" || arg === "--branch") {
			const [value, used] = takeValue(args, i, arg)
			config.branch = value
			i = used
		} else if (arg.startsWith("--branch=")) {
			config.branch = arg.slice("--branch=".length)
		} else if (arg.startsWith("-b") && arg.length > 2) {
			config.branch = arg.slice(2)
		} else if (arg === "--path") {
			const [value, used] = takeValue(args, i, arg)
			config.path = value
			i = used
		} else if (arg.startsWith("--path=")) {
			config.path = arg.slice("--path=".length)
		} else if (arg === "--copy") {
			config.copy = "force"
		} else if (arg === "--no-copy") {
			config.copy = "none"
		} else if (arg.startsWith("-")) {
			throw new CliError(`unsupported option ${arg}`, 2)
		} else {
			config.positionals.push(arg)
		}
	}
	if (config.help || config.version) return config
	if (config.positionals.length < 1) throw new CliError("missing worktree name", 2)
	if (config.positionals.length > 2) throw new CliError("too many positional arguments", 2)
	if (!config.integrationTarget) throw new CliError("missing required --integration-target <branch>", 2)
	return {
		...config,
		name: config.positionals[0],
		startPoint: config.positionals[1],
	}
}

async function git(args, cwd) {
	return await run("git", args, { cwd })
}

async function normalizeBranchName(repo, value, label) {
	if (!value || value.startsWith("-")) throw new CliError(`${label} must be a branch name`, 2)
	const result = await commandResult("git", ["check-ref-format", "--branch", value], { cwd: repo })
	if (result.code !== 0) throw new CliError(`${label} is not a valid branch name: ${value}`, 2)
	return result.stdout.trim() || value
}

async function assertExistingLocalBranch(repo, branch, label) {
	const result = await commandResult("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { cwd: repo })
	if (result.code !== 0) throw new CliError(`${label} does not exist as a local branch: ${branch}`, 2)
}

function isInside(path, parent) {
	const rel = relative(parent, path)
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel))
}

async function ensureWorktreeStorageIgnored(repo) {
	const worktreeDir = join(repo, PRODUCT_STATE_DIRECTORY, "wt")
	await mkdir(worktreeDir, { recursive: true })
	await ensureProjectStateDirectoryIgnored(repo)
	const gitignore = join(worktreeDir, ".gitignore")
	let text = ""
	try {
		text = await readFile(gitignore, "utf-8")
	} catch {}
	if (text.split(/\r?\n/).includes("*")) return
	const prefix = text && !text.endsWith("\n") ? "\n" : ""
	await writeFile(gitignore, `${text}${prefix}*\n`)
}

async function ignoredEntries(repo) {
	const result = await git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], repo)
	return result.stdout.split("\0").filter(Boolean)
}

function shouldSkipIgnoredEntry(relPath, repo, worktreePath) {
	const normalized = relPath.replaceAll("\\", "/").replace(/\/+$/, "")
	if (normalized === ".git"
		|| normalized.startsWith(".git/")
		|| [PRODUCT_STATE_DIRECTORY, LEGACY_PRODUCT_STATE_DIRECTORY].some((directory) =>
			normalized === `${directory}/wt` || normalized.startsWith(`${directory}/wt/`))) return true
	const source = resolve(repo, normalized)
	return isInside(source, worktreePath) || isInside(worktreePath, source)
}

async function pathExists(path) {
	try {
		await access(path, constants.F_OK)
		return true
	} catch {
		return false
	}
}

async function copyPath(source, destination, mode) {
	await mkdir(dirname(destination), { recursive: true })
	const args = mode === "cow"
		? process.platform === "darwin"
			? ["-cR", source, destination]
			: ["-a", "--reflink=always", source, destination]
		: ["-a", source, destination]
	await run("cp", args)
}

async function copyPathCow(source, destination) {
	try {
		await copyPath(source, destination, "cow")
		return
	} catch (err) {
		if (process.platform === "darwin") throw err
		await run("cp", ["-cR", source, destination])
	}
}

async function copyOne(source, destination, canCow) {
	if (canCow) await copyPathCow(source, destination)
	else await copyPath(source, destination, "normal")
}

async function copyProjectStateDirectory(repo, worktreePath, canCow, directory) {
	const stateDir = join(repo, directory)
	const entries = await readdir(stateDir).catch(() => [])
	let copied = 0
	for (const entry of entries) {
		if (entry === "wt" || (directory === PRODUCT_STATE_DIRECTORY && entry === PROJECT_DOCUMENTS_DIRECTORY_NAME)) continue
		const source = join(stateDir, entry)
		if (!(await pathExists(source))) continue
		if (isInside(source, worktreePath) || isInside(worktreePath, source)) continue
		await copyOne(source, join(worktreePath, directory, entry), canCow)
		copied += 1
	}
	return copied
}

async function cowAvailable(repo, worktreePath) {
	const probeName = `${PRODUCT_STATE_DIRECTORY}/copy-probe-${process.pid}-${Date.now()}`
	const source = join(repo, probeName)
	const destination = join(worktreePath, probeName)
	try {
		await mkdir(dirname(source), { recursive: true })
		await mkdir(dirname(destination), { recursive: true })
		await writeFile(source, "cerex copy probe\n")
		await copyPathCow(source, destination)
		return true
	} catch {
		return false
	} finally {
		await rm(source, { force: true })
		await rm(destination, { force: true })
	}
}

async function copyIgnoredFiles(repo, worktreePath, mode) {
	if (mode === "none") return { copied: 0 }
	const entries = (await ignoredEntries(repo)).filter((entry) => {
		const relPath = entry.replace(/\/+$/, "")
		return [PRODUCT_STATE_DIRECTORY, LEGACY_PRODUCT_STATE_DIRECTORY].includes(relPath) || !shouldSkipIgnoredEntry(entry, repo, worktreePath)
	})
	if (entries.length === 0) return { copied: 0 }
	const canCow = await cowAvailable(repo, worktreePath)
	let copied = 0
	for (const entry of entries) {
		const relPath = entry.replace(/\/+$/, "")
		if ([PRODUCT_STATE_DIRECTORY, LEGACY_PRODUCT_STATE_DIRECTORY].includes(relPath)) {
			copied += await copyProjectStateDirectory(repo, worktreePath, canCow, relPath)
			continue
		}
		const source = join(repo, relPath)
		if (!(await pathExists(source))) continue
		const destination = join(worktreePath, relPath)
		await copyOne(source, destination, canCow)
		copied += 1
	}
	return { copied }
}

async function updateSubmodules(worktreePath) {
	if (!existsSync(join(worktreePath, ".gitmodules"))) return false
	await git(["submodule", "update", "--init", "--recursive"], worktreePath)
	return true
}

async function recordWorktree(env, event) {
	const response = await postInternalEvent(env[INTERNAL_API_BASE_URL_ENV], env[INTERNAL_API_TOKEN_ENV], WORKTREE_EVENT_ROUTE, {
		version: 1,
		operation: GIT_WORKTREE_ADD_OPERATION,
		...event,
		toolCallId: readProductEnv(env, "TOOL_CALL_ID") || undefined,
	})
	if (!response.ok && env[INTERNAL_API_BASE_URL_ENV] && env[INTERNAL_API_TOKEN_ENV]) {
		process.stderr.write("cerex-worktree-add: warning: worktree was created but could not be recorded by Cerex.\n")
	}
}

export async function runManagedWorktreeAdd(config, options = {}) {
	const cwd = resolve(options.cwd ?? process.cwd())
	const env = applyProductEnvAliases({ ...(options.env ?? process.env) })
	const repo = await gitOutput(["rev-parse", "--show-toplevel"], cwd)
	const integrationTarget = await normalizeBranchName(repo, config.integrationTarget, "integration target")
	await assertExistingLocalBranch(repo, integrationTarget, "integration target")
	const branch = await normalizeBranchName(repo, config.branch ?? config.name, "worktree branch")
	const startPoint = config.startPoint ?? integrationTarget
	const worktreeRoot = join(repo, PRODUCT_STATE_DIRECTORY, "wt")
	const worktreePath = resolve(config.path ? resolve(cwd, config.path) : join(worktreeRoot, config.name))
	if (!config.path && !isInside(worktreePath, worktreeRoot)) {
		throw new CliError(`worktree name escapes ${PRODUCT_STATE_DIRECTORY}/wt: ${config.name}`, 2)
	}

	await ensureWorktreeStorageIgnored(repo)
	await mkdir(dirname(worktreePath), { recursive: true })
	await git(["worktree", "add", "-b", branch, worktreePath, startPoint], repo)
	const initialHead = await gitOutput(["rev-parse", "HEAD"], worktreePath)
	const createdAt = new Date().toISOString()
	await git(["config", `branch.${branch}.${INTEGRATION_TARGET_CONFIG}`, integrationTarget], worktreePath)
	await git(["config", `branch.${branch}.${INITIAL_HEAD_CONFIG}`, initialHead], worktreePath)
	await git(["config", `branch.${branch}.${CREATED_AT_CONFIG}`, createdAt], worktreePath)
	await recordWorktree(env, { path: worktreePath, branch, integrationTarget, initialHead, createdAt, repositoryRoot: repo })
	const copy = await copyIgnoredFiles(repo, worktreePath, config.copy)
	const submodules = await updateSubmodules(worktreePath)

	process.stdout.write(`created worktree ${worktreePath}\n`)
	process.stdout.write(`branch ${branch}\n`)
	process.stdout.write(`integration target ${integrationTarget}\n`)
	if (copy.copied > 0) process.stdout.write(`copied ${copy.copied} ignored ${copy.copied === 1 ? "entry" : "entries"}\n`)
	if (submodules) process.stdout.write("initialized submodules\n")
	return { path: worktreePath, branch, integrationTarget, copied: copy.copied, submodules }
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
		await runManagedWorktreeAdd(config, options)
		return 0
	} catch (err) {
		process.stderr.write(`${err?.message ?? String(err)}\n`)
		return err?.exitCode ?? 1
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = await main()
}
