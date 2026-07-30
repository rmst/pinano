import { gitCredentialScopeKey, isGithubCredentialHost, listGitTokenCredentials, saveGitTokenCredential, setGitTokenCredentialAgentAccess } from "../auth/git.js"
import { GITHUB_PERMISSION } from "./tool.js"

const defaultCredential = () => ({
	kind: "gitToken",
	provider: "github",
	host: "github.com",
	path: "*",
	label: "github.com",
})

const credentialDescriptor = (credential) => ({
	kind: "gitToken",
	provider: "github",
	key: credential.key ?? gitCredentialScopeKey(credential),
	host: credential.host,
	path: credential.path,
	label: credential.path === "*" ? credential.host : `${credential.host}/${credential.path}`,
	agentAccess: credential.agentAccess === true,
})

const credentialForDescriptor = (credentials, descriptor) => {
	if (!descriptor) return undefined
	const key = descriptor.key ?? gitCredentialScopeKey(descriptor)
	return credentials.find((credential) => credential.key === key)
}

export class GithubPermissionController {
	constructor(options = {}) {
		this.listCredentials = options.listCredentials ?? listGitTokenCredentials
		this.saveCredential = options.saveCredential ?? saveGitTokenCredential
		this.setAgentAccess = options.setAgentAccess ?? setGitTokenCredentialAgentAccess
		this.credentialRequest = undefined
		this.credentialSelections = new Map()
	}

	requireGithub(permission) {
		if (permission !== GITHUB_PERMISSION) throw new Error(`Unsupported permission: ${permission}`)
	}

	credentialRequired(request) {
		this.credentialRequest = request
	}

	selectedCredential(target, candidates) {
		const targetKey = gitCredentialScopeKey(target)
		const selectedKey = this.credentialSelections.get(targetKey)
		const selected = candidates.find((credential) => credential.key === selectedKey)
		if (!selected && selectedKey) this.credentialSelections.delete(targetKey)
		return selected?.key
	}

	async githubCredentials() {
		return (await this.listCredentials()).filter((credential) => isGithubCredentialHost(credential.host))
	}

	async isGranted(permission, context) {
		this.requireGithub(permission)
		if (context?.mode !== "approval") return false
		const current = credentialForDescriptor(await this.githubCredentials(), context.credential)
		return current?.agentAccess === true
	}

	selectionContext(credentials, target = defaultCredential(), candidates = credentials) {
		return {
			mode: "select",
			target,
			candidates: candidates.map(credentialDescriptor),
		}
	}

	async requestContext(permission) {
		this.requireGithub(permission)
		const credentials = await this.githubCredentials()
		const challenge = this.credentialRequest
		if (challenge?.reason === "missing") {
			if (credentials.length === 0) return { mode: "setup", credential: challenge.credential ?? challenge.target ?? defaultCredential() }
			this.credentialRequest = undefined
		}
		if (challenge?.reason === "ambiguous") {
			const candidates = (challenge.candidates ?? [])
				.map((candidate) => credentialForDescriptor(credentials, candidate))
				.filter(Boolean)
			if (candidates.length > 1) return this.selectionContext(credentials, challenge.target, candidates)
			this.credentialRequest = undefined
			if (candidates.length === 1) return { mode: "approval", credential: credentialDescriptor(candidates[0]), target: challenge.target }
			if (credentials.length === 0) return { mode: "setup", credential: challenge.target ?? defaultCredential() }
		}
		if (challenge?.reason === "approval") {
			const current = credentialForDescriptor(credentials, challenge.credential)
			if (current) return { mode: "approval", credential: credentialDescriptor(current), target: challenge.target }
			this.credentialRequest = undefined
			if (credentials.length === 0) return { mode: "setup", credential: challenge.target ?? defaultCredential() }
		}
		if (challenge?.reason === "rejected" || challenge?.reason === "insufficient") {
			const current = credentialForDescriptor(credentials, challenge.credential)
			if (current && current.updatedAt === challenge.credentialUpdatedAt) {
				return {
					mode: "replace",
					issue: challenge.reason,
					credential: credentialDescriptor(current),
					target: challenge.target,
				}
			}
			this.credentialRequest = undefined
			if (current) return { mode: "approval", credential: credentialDescriptor(current), target: challenge.target }
			if (credentials.length === 0) return { mode: "setup", credential: challenge.target ?? challenge.credential ?? defaultCredential() }
		}
		if (credentials.length === 0) return { mode: "setup", credential: defaultCredential() }
		if (credentials.length === 1) return { mode: "approval", credential: credentialDescriptor(credentials[0]) }
		return this.selectionContext(credentials)
	}

	async grant(permission, request) {
		this.requireGithub(permission)
		const context = request.context
		if (context?.mode === "setup" || context?.mode === "replace") {
			const secret = typeof request.input?.secret === "string" ? request.input.secret.trim() : ""
			if (!secret) throw Object.assign(new Error("GitHub token is required"), { status: 400 })
			const credential = context.credential
			if (credential?.kind !== "gitToken" || !isGithubCredentialHost(credential.host) || !credential.path) {
				throw new Error("GitHub credential scope is unavailable")
			}
			await this.saveCredential({ host: credential.host, path: credential.path }, secret, { agentAccess: true })
		} else if (context?.mode === "approval") {
			const credential = context.credential
			await this.setAgentAccess({ host: credential.host, path: credential.path }, true)
		} else if (context?.mode === "select") {
			const selectedKey = typeof request.input?.credentialKey === "string" ? request.input.credentialKey : ""
			const selected = context.candidates?.find((credential) => credential.key === selectedKey)
			if (!selected) throw Object.assign(new Error("Choose a GitHub credential"), { status: 400 })
			await this.setAgentAccess({ host: selected.host, path: selected.path }, true)
			const target = context.target ?? defaultCredential()
			this.credentialSelections.set(gitCredentialScopeKey(target), selected.key)
		} else {
			throw new Error("GitHub permission context is unavailable")
		}
		this.credentialRequest = undefined
	}

	settle() {
		this.credentialRequest = undefined
	}
}
