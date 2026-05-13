// Tiny JSON Schema validator. Supports the subset typically used for LLM
// tool definitions: type, properties, required, items, enum, const,
// minimum/maximum, minLength/maxLength, pattern, anyOf/oneOf/allOf,
// additionalProperties, format (recognized but not enforced).

function typeOf(value) {
	if (value === null) return "null"
	if (Array.isArray(value)) return "array"
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
	return typeof value
}

function matchesType(value, type) {
	const actual = typeOf(value)
	if (type === "number") return actual === "number" || actual === "integer"
	if (type === "integer") return actual === "integer"
	return actual === type
}

function validate(value, schema, path, errors) {
	if (!schema || typeof schema !== "object") return

	if (Array.isArray(schema.allOf)) {
		for (const sub of schema.allOf) validate(value, sub, path, errors)
	}
	if (Array.isArray(schema.anyOf)) {
		const subErrors = []
		const ok = schema.anyOf.some((sub) => {
			const local = []
			validate(value, sub, path, local)
			if (local.length === 0) return true
			subErrors.push(local)
			return false
		})
		if (!ok) errors.push({ path, message: `did not match any of anyOf` })
	}
	if (Array.isArray(schema.oneOf)) {
		let matches = 0
		for (const sub of schema.oneOf) {
			const local = []
			validate(value, sub, path, local)
			if (local.length === 0) matches++
		}
		if (matches !== 1) errors.push({ path, message: `expected to match exactly one of oneOf, matched ${matches}` })
	}

	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type]
		if (!types.some((t) => matchesType(value, t))) {
			errors.push({ path, message: `expected ${types.join(" | ")}, got ${typeOf(value)}` })
			return
		}
	}

	if (schema.const !== undefined && value !== schema.const) {
		errors.push({ path, message: `expected const ${JSON.stringify(schema.const)}` })
	}

	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		errors.push({ path, message: `expected one of ${JSON.stringify(schema.enum)}` })
	}

	const t = typeOf(value)

	if (t === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength) {
			errors.push({ path, message: `string shorter than minLength ${schema.minLength}` })
		}
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
			errors.push({ path, message: `string longer than maxLength ${schema.maxLength}` })
		}
		if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
			errors.push({ path, message: `string does not match pattern ${schema.pattern}` })
		}
	}

	if (t === "number" || t === "integer") {
		if (typeof schema.minimum === "number" && value < schema.minimum) {
			errors.push({ path, message: `number less than minimum ${schema.minimum}` })
		}
		if (typeof schema.maximum === "number" && value > schema.maximum) {
			errors.push({ path, message: `number greater than maximum ${schema.maximum}` })
		}
	}

	if (t === "array") {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			errors.push({ path, message: `array shorter than minItems ${schema.minItems}` })
		}
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
			errors.push({ path, message: `array longer than maxItems ${schema.maxItems}` })
		}
		if (schema.items) {
			if (Array.isArray(schema.items)) {
				for (let i = 0; i < value.length; i++) {
					const sub = schema.items[i]
					if (sub) validate(value[i], sub, `${path}[${i}]`, errors)
				}
			} else {
				for (let i = 0; i < value.length; i++) {
					validate(value[i], schema.items, `${path}[${i}]`, errors)
				}
			}
		}
	}

	if (t === "object") {
		const props = schema.properties || {}
		const required = Array.isArray(schema.required) ? schema.required : []
		for (const key of required) {
			if (!(key in value)) errors.push({ path: path ? `${path}.${key}` : key, message: `missing required property` })
		}
		for (const [key, sub] of Object.entries(props)) {
			if (key in value) validate(value[key], sub, path ? `${path}.${key}` : key, errors)
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(value)) {
				if (!(key in props)) {
					errors.push({ path: path ? `${path}.${key}` : key, message: `unexpected additional property` })
				}
			}
		} else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
			for (const [key, val] of Object.entries(value)) {
				if (!(key in props)) validate(val, schema.additionalProperties, path ? `${path}.${key}` : key, errors)
			}
		}
	}
}

/**
 * Validate `value` against a JSON Schema. Returns `{ ok: true, value }`
 * when valid, or `{ ok: false, errors }` otherwise.
 */
export function validateValue(value, schema) {
	const errors = []
	validate(value, schema, "", errors)
	if (errors.length === 0) return { ok: true, value }
	return { ok: false, errors }
}

/**
 * Find a tool by name and validate the call arguments.
 * Throws on unknown tool or validation failure.
 */
export function validateToolCall(tools, toolCall) {
	const tool = tools.find((t) => t.name === toolCall.name)
	if (!tool) throw new Error(`Tool "${toolCall.name}" not found`)
	return validateToolArguments(tool, toolCall)
}

export function validateToolArguments(tool, toolCall) {
	const result = validateValue(toolCall.arguments, tool.parameters)
	if (result.ok) return toolCall.arguments
	const summary = result.errors.map((e) => `  - ${e.path || "root"}: ${e.message}`).join("\n")
	throw new Error(
		`Validation failed for tool "${toolCall.name}":\n${summary}\n\nReceived arguments:\n${JSON.stringify(
			toolCall.arguments,
			null,
			2,
		)}`,
	)
}
