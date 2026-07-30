import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { GITHUB_PROXY_ROUTE } from "../../../../protocol/src/internal-proxy-routes.js"
import { gitCredentialScopeFromRemote, gitCredentialScopeKey, isGithubCredentialHost, listGitTokenCredentials, redactGitSecrets } from "../../app/auth/git.js"
import { minimizeCoveredMounts, pathIsWithin } from "../../app/sandbox/paths.js"
import { hostPathForWorkerPath, workerSandboxMountForHostPath } from "../../app/workers/tool/worker-mounts.js"
import { runSandboxedScript } from "../../app/workers/launchers.js"
import { internalHttpJsonResponse, internalHttpRequestBodyText } from "../../app/workers/internal-http.js"

export { GITHUB_PROXY_ROUTE }

const execFileAsync = promisify(execFile)
const PROXY_EXIT_CODE = 1
const GITHUB_COMMANDS = new Set([
	"api", "attestation", "browse", "cache", "codespace", "completion", "gist", "help", "issue", "label", "org", "pr", "project",
	"release", "repo", "ruleset", "run", "search", "secret", "ssh-key", "status", "variable", "version", "workflow",
])

function outputBase64(value) {
	return Buffer.from(value ?? "").toString("base64")
}

function response({ stdout = "", stderr = "", exitCode = 0 } = {}) {
	return { exitCode, stdoutBase64: outputBase64(stdout), stderrBase64: outputBase64(stderr) }
}

function proxyError(message) {
	return response({ stderr: `gh proxy: ${message}\n`, exitCode: PROXY_EXIT_CODE })
}

function parsePayload(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("gh proxy body must be an object"), { status: 400 })
	if (!Array.isArray(value.argv) || !value.argv.every((arg) => typeof arg === "string")) throw Object.assign(new Error("gh proxy argv must be an array of strings"), { status: 400 })
	return {
		argv: value.argv,
		cwd: typeof value.cwd === "string" && value.cwd ? value.cwd : undefined,
		toolCallId: typeof value.toolCallId === "string" && value.toolCallId ? value.toolCallId : undefined,
	}
}

async function repositoryPaths(cwd) {
	try {
		const result = await execFileAsync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], {
			env: { PATH: process.env.PATH, GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
			encoding: "utf8",
			timeout: 2000,
		})
		const [root, gitDir, gitCommonDir] = result.stdout.trim().split("\n")
		if (!root) return { root: cwd, gitMetadata: [] }
		return {
			root,
			gitMetadata: [...new Set([gitDir, gitCommonDir].filter((path) => path && !pathIsWithin(root, path)))],
		}
	} catch {
		return { root: cwd, gitMetadata: [] }
	}
}

function githubSandboxMounts(mappedCwd, repository, workerContext) {
	const root = workerSandboxMountForHostPath(repository.root ?? mappedCwd.path, workerContext)
	if (!root) throw new Error("GitHub repository root is outside the tool sandbox")
	const metadata = (repository.gitMetadata ?? []).map((path) => {
		const mount = workerSandboxMountForHostPath(path, workerContext, { readOnly: true })
		if (!mount) throw new Error("GitHub repository metadata is outside the tool sandbox")
		return mount
	})
	return minimizeCoveredMounts([root, ...metadata])
}

function parseRequest(request) {
	try {
		return parsePayload(JSON.parse(internalHttpRequestBodyText(request) || "{}"))
	} catch (err) {
		if (err?.status) throw err
		throw Object.assign(new Error("Invalid JSON body"), { status: 400 })
	}
}

function commandWords(argv) {
	return argv.filter((arg) => arg !== "--help" && arg !== "--version" && !arg.startsWith("-"))
}

function commandValidationError(argv) {
	if (argv.some((arg) => arg.includes("://"))) return "URL arguments are not allowed"
	if (argv.some((arg) => arg === "--hostname" || arg.startsWith("--hostname=") || arg === "--host" || arg.startsWith("--host="))) return "host overrides are not allowed"
	if (argv.includes("--web") || argv.some((arg) => arg.startsWith("--web="))) return "opening a browser is not available through the secure proxy"
	const restricted = ["auth", "alias", "config", "extension"].find((name) => argv.includes(name))
	if (restricted) return `gh ${restricted} is not available through the secure proxy`
	const [command, subcommand, action] = commandWords(argv)
	if (command && !GITHUB_COMMANDS.has(command)) return `gh command is not available through the secure proxy: ${command}`
	if (command === "browse") return "gh browse is not available through the secure proxy"
	if (command === "codespace" && ["code", "cp", "ports", "ssh"].includes(subcommand)) return `gh codespace ${subcommand} is not available through the secure proxy`
	if (command === "repo" && ["clone", "fork", "sync"].includes(subcommand)) return `gh repo ${subcommand} is not available through the secure proxy; use the ordinary Git tools instead`
	if (command === "pr" && subcommand === "checkout") return "gh pr checkout is not available through the secure proxy; use the ordinary Git tools instead"
	if (command === "gist" && subcommand === "clone") return "gh gist clone is not available through the secure proxy"
	if (argv.some((arg) => ["--body-file", "--env-file", "--input"].includes(arg) || ["--body-file=", "--env-file=", "--input="].some((prefix) => arg.startsWith(prefix)))) {
		return "file-input options are not available through the secure proxy"
	}
	if (argv.some((arg) => arg.startsWith("@") || arg.includes("=@"))) return "file-valued fields are not available through the secure proxy"
	if (command === "attestation") return "gh attestation is not available through the secure proxy"
	if (command === "gist" && ["create", "edit"].includes(subcommand)) return `gh gist ${subcommand} is not available through the secure proxy`
	if (command === "release" && ["create", "upload"].includes(subcommand)) return `gh release ${subcommand} is not available through the secure proxy`
	if (command === "ssh-key" && subcommand === "add") return "gh ssh-key add is not available through the secure proxy"
	if (command === "repo" && subcommand === "deploy-key" && action === "add") return "gh repo deploy-key add is not available through the secure proxy"
	return undefined
}

async function repositoryOrigin(cwd) {
	try {
		const result = await execFileAsync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
			env: { PATH: process.env.PATH, GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
			encoding: "utf8",
			timeout: 2000,
		})
		return result.stdout.trim()
	} catch {
		return ""
	}
}

function githubCredentials(credentials) {
	return credentials.filter((credential) => isGithubCredentialHost(credential.host))
}

function credentialDescriptor(credential) {
	return {
		kind: "gitToken",
		provider: "github",
		key: credential.key ?? gitCredentialScopeKey(credential),
		host: credential.host,
		path: credential.path,
		label: credential.path === "*" ? credential.host : `${credential.host}/${credential.path}`,
		...(typeof credential.agentAccess === "boolean" ? { agentAccess: credential.agentAccess } : {}),
	}
}

function targetDescriptor(origin) {
	const originScope = gitCredentialScopeFromRemote(origin)
	const scope = originScope && isGithubCredentialHost(originScope.host)
		? originScope
		: { host: "github.com", path: "*" }
	return credentialDescriptor(scope)
}

function credentialRequest(origin, credential, reason, candidates = undefined) {
	return {
		reason,
		...(credential?.updatedAt === undefined ? {} : { credentialUpdatedAt: credential.updatedAt }),
		target: targetDescriptor(origin),
		...(credential ? { credential: credentialDescriptor(credential) } : {}),
		...(candidates ? { candidates: candidates.map(credentialDescriptor) } : {}),
	}
}

function authenticationRejected(result) {
	if (!result || result.exitCode === 0) return false
	const output = `${result.stdout?.toString("utf8") ?? ""}\n${result.stderr?.toString("utf8") ?? ""}`
	return /(?:\bHTTP\s+401\b|\bbad credentials\b|\binvalid (?:authentication )?token\b)/i.test(output)
}

function authorizationInsufficient(result, origin) {
	if (!result || result.exitCode === 0) return false
	const output = `${result.stdout?.toString("utf8") ?? ""}\n${result.stderr?.toString("utf8") ?? ""}`
	if (/resource not accessible by (?:integration|personal access token)/i.test(output)) return true
	const scope = gitCredentialScopeFromRemote(origin)
	if (!scope || !isGithubCredentialHost(scope.host)) return false
	const escapedPath = scope.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	if (/could not resolve to a repository with the name/i.test(output)) {
		return new RegExp(`[\"']${escapedPath}[\"']`, "i").test(output)
	}
	if (!/\bHTTP\s+404\b/i.test(output)) return false
	return new RegExp(`api\\.github\\.com/repos/${escapedPath}(?:\\b|[/?#])`, "i").test(output)
}

const githubScript = String.raw`#!/bin/sh
set -eu
real_git=$(command -v git || true)
test -n "$real_git" || { echo "gh proxy: git is unavailable in the secure sandbox" >&2; exit 127; }
mkdir -p "$HOME/bin" "$TMPDIR"
cat > "$HOME/bin/git" <<'CEREX_GIT_WRAPPER'
#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
	case "$1" in
		-C|--git-dir|--work-tree) shift 2 ;;
		--git-dir=*|--work-tree=*) shift ;;
		-*) echo "gh proxy: git option is not allowed: $1" >&2; exit 126 ;;
		*) break ;;
	esac
done
command_name=
test "$#" -eq 0 || command_name=$1
case "$command_name" in
	rev-parse|status|symbolic-ref|show-ref|for-each-ref|log|merge-base|ls-files|show) ;;
	config)
		config_mode=
		test "$#" -lt 2 || config_mode=$2
		if [ "$config_mode" = "--local" ] || [ "$config_mode" = "--worktree" ]; then
			config_mode=
			test "$#" -lt 3 || config_mode=$3
		fi
		case "$config_mode" in --get|--get-all|--get-regexp|--list|-l) ;; *) echo "gh proxy: mutating git config commands are not allowed" >&2; exit 126 ;; esac
		;;
	remote)
		remote_command=
		test "$#" -lt 2 || remote_command=$2
		case " $remote_command " in " get-url "|" -v ") ;; *) echo "gh proxy: mutating git remote commands are not allowed" >&2; exit 126 ;; esac ;;
	*) test -n "$command_name" || command_name=empty; echo "gh proxy: git command is not allowed: $command_name" >&2; exit 126 ;;
esac
case " $* " in *" --textconv "*|*" --ext-diff "*) echo "gh proxy: external git helpers are not allowed" >&2; exit 126 ;; esac
exec env -u GH_TOKEN -u GITHUB_TOKEN \
	GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 GIT_PAGER=cat \
	GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \
	GIT_CONFIG_KEY_1=core.fsmonitor GIT_CONFIG_VALUE_1=false \
	GIT_CONFIG_KEY_2=core.pager GIT_CONFIG_VALUE_2=cat \
	"$CEREX_REAL_GIT" "$@"
CEREX_GIT_WRAPPER
chmod 700 "$HOME/bin/git"
CEREX_REAL_GIT=$real_git
export CEREX_REAL_GIT
PATH="$HOME/bin:$PATH"
export PATH
IFS= read -r GH_TOKEN || true
test -n "$GH_TOKEN" || { echo "gh proxy: GitHub credential is empty" >&2; exit 1; }
export GH_TOKEN
export GH_HOST=github.com
export GH_PROMPT_DISABLED=1
export GH_PAGER=cat
export PAGER=cat
export GIT_TERMINAL_PROMPT=0
export EDITOR=false
export GH_EDITOR=false
export BROWSER=false
unset GITHUB_TOKEN
exec gh "$@"
`

export async function runGithubProxyPayload(payload, context = {}, options = {}) {
	const validationError = commandValidationError(payload.argv)
	if (validationError) return proxyError(validationError)
	if (!payload.cwd) return proxyError("working directory is unavailable")
	if (context.workerContext?.target?.type !== "local") return proxyError("GitHub access is currently available only in local environments")
	const mappedCwd = hostPathForWorkerPath(payload.cwd, context.workerContext)
	if (!mappedCwd?.path) return proxyError("working directory is outside the tool sandbox")
	const repository = await (options.readRepositoryPaths ?? repositoryPaths)(mappedCwd.path)
	const origin = await (options.readOrigin ?? repositoryOrigin)(mappedCwd.path)
	const credentials = (options.listCredentials ?? listGitTokenCredentials)()
	const stored = githubCredentials(await credentials)
	if (stored.length === 0) {
		await options.onCredentialRequired?.(credentialRequest(origin, undefined, "missing"))
		return proxyError('GitHub credentials are needed. Call request_permission with permission "github" and a concise reason for this GitHub operation, then retry this gh command')
	}
	const target = targetDescriptor(origin)
	const exact = stored.find((credential) => credential.key === target.key)
	let credential = exact ?? (stored.length === 1 ? stored[0] : undefined)
	if (!credential && stored.length > 1) {
		const selectedKey = await options.selectCredential?.(target, stored.map(credentialDescriptor))
		credential = stored.find((candidate) => candidate.key === selectedKey)
		if (!credential) {
			await options.onCredentialRequired?.(credentialRequest(origin, undefined, "ambiguous", stored))
			return proxyError('More than one GitHub credential may apply. Call request_permission with permission "github" and a concise reason for this GitHub operation, choose a credential, then retry this gh command')
		}
	}
	if (credential.agentAccess !== true) {
		await options.onCredentialRequired?.(credentialRequest(origin, credential, "approval"))
		return proxyError('GitHub access needs your approval. Call request_permission with permission "github" and a concise reason for this GitHub operation, then retry this gh command')
	}
	const sandbox = context.workerContext.sandbox ?? { type: "none" }
	const run = options.runSandboxed ?? runSandboxedScript
	try {
		const result = await run({
			sandbox,
			cwd: sandbox.type === "container" ? payload.cwd : mappedCwd.path,
			mounts: githubSandboxMounts(mappedCwd, repository, context.workerContext),
			script: githubScript,
			args: payload.argv,
			input: `${credential.token}\n`,
			timeoutMs: 5 * 60 * 1000,
		})
		const rejected = authenticationRejected(result)
		const insufficient = !rejected && authorizationInsufficient(result, origin)
		if (rejected || insufficient) await options.onCredentialRequired?.(credentialRequest(origin, credential, rejected ? "rejected" : "insufficient"))
		const stderr = redactGitSecrets(result.stderr?.toString("utf8"), [credential.token])
		return response({
			stdout: redactGitSecrets(result.stdout?.toString("utf8"), [credential.token]),
			stderr: rejected
				? `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}gh proxy: The stored GitHub credential was rejected. Call request_permission with permission "github" and a concise reason to replace it, then retry this gh command.\n`
				: insufficient
					? `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}gh proxy: The stored GitHub credential may not have access to this repository. Call request_permission with permission "github" and a concise reason to replace it, then retry this gh command.\n`
					: stderr,
			exitCode: result.exitCode,
		})
	} catch (err) {
		return proxyError(redactGitSecrets(err?.message ?? String(err), [credential.token]))
	}
}

export async function handleGithubProxyRequest(request, workerContext = undefined, options = {}) {
	if (request.method !== "POST") return internalHttpJsonResponse({ error: "Method Not Allowed" }, 405)
	const result = await runGithubProxyPayload(parseRequest(request), { sessionId: options.sessionId, workerContext }, options)
	return internalHttpJsonResponse(result)
}
