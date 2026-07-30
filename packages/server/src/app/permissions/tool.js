export const REQUEST_PERMISSION_TOOL_NAME = "request_permission"
export const GITHUB_PERMISSION = "github"

const MAX_PERMISSION_REASON_LENGTH = 300

const permissionSchema = {
	type: "object",
	properties: {
		permission: {
			type: "string",
			minLength: 1,
			description: "The permission identifier provided by the proxy tool that requested access.",
		},
		reason: {
			type: "string",
			minLength: 1,
			maxLength: MAX_PERMISSION_REASON_LENGTH,
			description: "A concise, specific explanation of what you intend to do and why this capability is needed now. The user sees this text.",
		},
	},
	required: ["permission", "reason"],
	additionalProperties: false,
}

function normalizedReason(value) {
	if (typeof value !== "string" || !value.trim()) throw new Error("Permission reason must be a non-empty string")
	const reason = value.trim()
	if (reason.length > MAX_PERMISSION_REASON_LENGTH) throw new Error(`Permission reason must not exceed ${MAX_PERMISSION_REASON_LENGTH} characters`)
	return reason
}

function permissionResult(permission, granted) {
	return {
		content: [{ type: "text", text: granted ? `${permission} permission granted` : `${permission} permission denied by the user` }],
		details: { permission, granted },
	}
}

/** A small, runtime-independent broker for blocking capability requests. */
export class PermissionRequestBroker {
	/** @param {{ isGranted: (permission: string, context: any) => Promise<boolean>, requestContext?: (permission: string) => Promise<any>, grant: (permission: string, request: { context: any, input: any }) => Promise<void>, settle?: (permission: string, context: any, granted: boolean) => void | Promise<void>, onPendingChange?: (count: number) => void }} options */
	constructor(options) {
		this.isGranted = options.isGranted
		this.requestContext = options.requestContext ?? (async () => ({ mode: "approval" }))
		this.grant = options.grant
		this.settle = options.settle ?? (() => {})
		this.onPendingChange = options.onPendingChange ?? (() => {})
		this.pending = new Map()
	}

	pendingChanged() {
		try {
			this.onPendingChange(this.pending.size)
		} catch {}
	}

	removePending(toolCallId, request, notify = true) {
		if (this.pending.get(toolCallId) !== request) return false
		this.pending.delete(toolCallId)
		request.signal?.removeEventListener("abort", request.abort)
		if (notify) this.pendingChanged()
		return true
	}

	request(toolCallId, permission, reasonValue, signal) {
		if (permission !== GITHUB_PERMISSION) throw new Error(`Unsupported permission: ${permission}`)
		if (this.pending.has(toolCallId)) throw new Error(`Permission request is already pending: ${toolCallId}`)
		const reason = normalizedReason(reasonValue)
		const result = new Promise((resolve, reject) => {
			const abort = () => {
				if (!this.removePending(toolCallId, pending)) return
				void this.settle(permission, pending.context, false)
				reject(new Error("Permission request was cancelled"))
			}
			const pending = { permission, reason, resolve, reject, signal, abort, context: undefined, ready: undefined }
			this.pending.set(toolCallId, pending)
			this.pendingChanged()
			pending.ready = (async () => {
				pending.context = await this.requestContext(permission)
				if (pending.context?.mode === "approval" && await this.isGranted(permission, pending.context)) {
					if (!this.removePending(toolCallId, pending)) return false
					await this.settle(permission, pending.context, true)
					resolve(permissionResult(permission, true))
					return false
				}
				return this.pending.get(toolCallId) === pending
			})().catch((err) => {
				this.removePending(toolCallId, pending)
				void this.settle(permission, pending.context, false)
				reject(err)
				return false
			})
			if (signal?.aborted) abort()
			else signal?.addEventListener("abort", abort, { once: true })
		})
		return result
	}

	async describe(toolCallId) {
		const request = this.pending.get(toolCallId)
		if (!request) throw Object.assign(new Error("Permission request is no longer pending"), { status: 409 })
		if (!(await request.ready) || this.pending.get(toolCallId) !== request) throw Object.assign(new Error("Permission request is no longer pending"), { status: 409 })
		return { permission: request.permission, reason: request.reason, ...request.context }
	}

	async resolve(toolCallId, decision, input = undefined) {
		const request = this.pending.get(toolCallId)
		if (!request) throw Object.assign(new Error("Permission request is no longer pending"), { status: 409 })
		if (decision !== "allow" && decision !== "deny") throw Object.assign(new Error("Permission decision must be allow or deny"), { status: 400 })
		if (!(await request.ready) || this.pending.get(toolCallId) !== request) throw Object.assign(new Error("Permission request is no longer pending"), { status: 409 })
		if (decision === "allow") await this.grant(request.permission, { context: request.context, input })
		const contextKey = JSON.stringify(request.context)
		const matching = decision === "allow"
			? [...this.pending.entries()].filter(([, pending]) => pending.permission === request.permission && JSON.stringify(pending.context) === contextKey)
			: [[toolCallId, request]]
		for (const [id, pending] of matching) {
			this.removePending(id, pending, false)
			pending.resolve(permissionResult(pending.permission, decision === "allow"))
		}
		await this.settle(request.permission, request.context, decision === "allow")
		this.pendingChanged()
		return { permission: request.permission, granted: decision === "allow" }
	}

	dispose() {
		for (const [id, request] of this.pending) {
			this.removePending(id, request, false)
			void this.settle(request.permission, request.context, false)
			request.resolve(permissionResult(request.permission, false))
		}
		this.pendingChanged()
	}
}

/** @param {() => any} getAgent */
export function createRequestPermissionTool(getAgent) {
	return {
		name: REQUEST_PERMISSION_TOOL_NAME,
		label: REQUEST_PERMISSION_TOOL_NAME,
		description: [
			"Requests a user-controlled Cerex capability and waits for their decision. The user sees your reason verbatim.",
			"Call this only after a proxy tool explicitly says that permission is required. Explain what you intend to do and why the capability is needed now; be factual and specific. If granted, retry the original command. If denied, continue without the capability or explain the blocker.",
		].join("\n"),
		parameters: permissionSchema,
		executionMode: "sequential",
		exposure: "direct_model_only",
		async execute(toolCallId, args, signal) {
			const request = getAgent()?.requestPermission
			if (typeof request !== "function") throw new Error("Permission requests are unavailable in this session")
			return await request(toolCallId, args.permission, args.reason, signal)
		},
	}
}
