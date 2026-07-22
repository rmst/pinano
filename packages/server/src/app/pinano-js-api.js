// The in-model JavaScript helper tool is currently deactivated. This help text
// is retained for future work and may be stale; do not treat it as model-facing
// session API documentation that must track every session metadata change.

const GENERAL_HELP = `Pinano JS helpers:
- await pinano.help()
- await pinano.help("session")
- const session = pinano.session()        // current session
- const session = pinano.session(id)      // exact session id

Session handles expose async get() and set(patch).`

const SESSION_HELP = `Pinano session API:

const handle = pinano.session()
await handle.get()
await handle.set({
	descriptionInUi: "stable UI label" | null,
	projectDir: "/absolute/project/root" | null,
	cwd: "/absolute/path",        // interpreted inside the selected environment
	environmentId: "local",       // configured environment id for subsequent tools
})

Patch semantics: omitted fields are unchanged; null clears nullable fields. Switching to an environment with a configured cwd also switches cwd unless cwd is supplied explicitly. set(patch) returns the updated session info.`

function normalizeSessionId(id) {
	if (id === undefined || id === null || id === "") return undefined
	if (typeof id !== "string") throw new TypeError("session id must be a string")
	return id
}

/**
 * @param {object} bridge
 * @param {(topic?: string) => string | Promise<string>} [bridge.help]
 * @param {(sessionId?: string) => Promise<any>} bridge.getSession
 * @param {(sessionId: string | undefined, patch: any) => Promise<any>} bridge.setSession
 */
export function createPinanoJsApi(bridge) {
	const help = async (topic = undefined) => {
		if (bridge.help) return bridge.help(topic)
		if (topic === undefined || topic === null || topic === "") return GENERAL_HELP
		if (String(topic).toLowerCase() === "session") return SESSION_HELP
		return `No Pinano help topic named ${JSON.stringify(String(topic))}. Available topics: session.`
	}

	const session = (id = undefined) => {
		const sessionId = normalizeSessionId(id)
		return Object.freeze({
			async get() {
				return bridge.getSession(sessionId)
			},
			async set(patch) {
				return bridge.setSession(sessionId, patch)
			},
		})
	}

	return Object.freeze({ help, session })
}

export function createUnavailablePinanoJsApi(message = "Pinano session APIs are unavailable in this context.") {
	return createPinanoJsApi({
		async getSession() {
			throw new Error(message)
		},
		async setSession() {
			throw new Error(message)
		},
	})
}

export const PINANO_JS_HELP = { GENERAL_HELP, SESSION_HELP }
