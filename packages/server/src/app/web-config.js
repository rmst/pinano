const plainObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {}

export function normalizeWebPasswordAuthConfig(value) {
	const raw = plainObject(value)
	if (Object.keys(raw).length === 0) return undefined
	if (raw.type !== undefined && raw.type !== "password") return undefined
	const users = {}
	for (const [username, password] of Object.entries(plainObject(raw.users))) {
		if (typeof username === "string" && username && typeof password === "string" && password) users[username] = password
	}
	if (Object.keys(users).length === 0) return undefined
	return { type: "password", users }
}

export function webPasswordAuthStatus(config) {
	if (config === false) return { type: "none" }
	return normalizeWebPasswordAuthConfig(config) ? { type: "password" } : undefined
}

export function webPasswordAuthConfigKey(config) {
	if (config === false) return "none"
	const normalized = normalizeWebPasswordAuthConfig(config)
	return normalized ? JSON.stringify(normalized) : ""
}
