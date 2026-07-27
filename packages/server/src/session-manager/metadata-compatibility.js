const LEGACY_FIELD_NAMES = Object.freeze({
	pinanoAutomated: "automated",
	pinanoHidden: "hidden",
	pinanoCompactionMemento: "compactionMemento",
	pinanoCompactionSummary: "compactionSummary",
	pinanoRemoteCompaction: "remoteCompaction",
	pinanoRemoteCompactionRetained: "remoteCompactionRetained",
	pinanoEnvironmentContext: "environmentContext",
	pinanoSkillsContext: "skillsContext",
	pinanoMaintenance: "maintenance",
	pinanoMaintenancePlacement: "maintenancePlacement",
	pinanoMaintenanceAudit: "maintenanceAudit",
	pinanoCwdFallback: "cwdFallback",
	pinanoCwdFallbackNotice: "cwdFallbackNotice",
	pinanoProjectMaintenanceNotice: "projectMaintenanceNotice",
	pinanoSubSessionNotice: "subSessionNotice",
	pinanoSessionInfo: "sessionInfo",
	pinanoBranchNotice: "branchNotice",
})

function cloneWithDescriptors(value) {
	return Object.create(Object.getPrototypeOf(value), Object.getOwnPropertyDescriptors(value))
}

function cloneWithoutProperty(value, key) {
	const descriptors = Object.getOwnPropertyDescriptors(value)
	delete descriptors[key]
	return Object.create(Object.getPrototypeOf(value), descriptors)
}

function normalizeOwnProperty(value, key, normalize) {
	const descriptor = Object.getOwnPropertyDescriptor(value, key)
	if (!descriptor) return value
	if (Object.hasOwn(descriptor, "value")) {
		const normalizedValue = normalize(descriptor.value)
		if (normalizedValue === descriptor.value) return value
		const normalized = cloneWithoutProperty(value, key)
		Object.defineProperty(normalized, key, { ...descriptor, value: normalizedValue })
		return normalized
	}
	if (!descriptor.get) return value
	const normalized = cloneWithoutProperty(value, key)
	const get = descriptor.get
	Object.defineProperty(normalized, key, {
		...descriptor,
		get() {
			return normalize(get.call(this))
		},
	})
	return normalized
}

export function normalizeLegacyMetadata(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value
	let normalized = value
	for (const [legacy, current] of Object.entries(LEGACY_FIELD_NAMES)) {
		if (!Object.hasOwn(value, legacy)) continue
		if (normalized === value) normalized = cloneWithDescriptors(value)
		if (!Object.hasOwn(normalized, current)) normalized[current] = normalized[legacy]
		delete normalized[legacy]
	}
	return normalized
}

export function normalizeLegacyMessage(message) {
	return normalizeLegacyMetadata(message)
}

export function normalizeLegacyEntryData(data) {
	if (!data || typeof data !== "object" || Array.isArray(data)) return data
	let normalized = normalizeLegacyMetadata(data)
	normalized = normalizeOwnProperty(normalized, "message", normalizeLegacyMessage)
	normalized = normalizeOwnProperty(normalized, "displayMessage", normalizeLegacyMessage)
	normalized = normalizeOwnProperty(normalized, "replacementContext", (replacement) => {
		if (!replacement || typeof replacement !== "object" || !Array.isArray(replacement.messages)) return replacement
		return {
			...replacement,
			kind: replacement.kind === "pinano-messages" ? "messages" : replacement.kind,
			messages: replacement.messages.map(normalizeLegacyMessage),
		}
	})
	return normalized
}
