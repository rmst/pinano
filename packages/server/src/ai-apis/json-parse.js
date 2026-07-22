// JSON repair + parser for partial JSON streamed from LLM tool calls.
// Two pieces:
//   - repairJson: escape raw control chars and stray backslashes inside strings.
//   - completePartialJson: append the minimal suffix required to make a
//     truncated JSON document parseable (close strings, drop trailing
//     keys/commas, balance brackets).

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"])

function isControlCharacter(char) {
	const cp = char.codePointAt(0)
	return cp !== undefined && cp >= 0x00 && cp <= 0x1f
}

function escapeControlCharacter(char) {
	switch (char) {
		case "\b":
			return "\\b"
		case "\f":
			return "\\f"
		case "\n":
			return "\\n"
		case "\r":
			return "\\r"
		case "\t":
			return "\\t"
		default:
			return `\\u${char.codePointAt(0).toString(16).padStart(4, "0")}`
	}
}

export function repairJson(json) {
	let repaired = ""
	let inString = false

	for (let i = 0; i < json.length; i++) {
		const char = json[i]

		if (!inString) {
			repaired += char
			if (char === '"') inString = true
			continue
		}

		if (char === '"') {
			repaired += char
			inString = false
			continue
		}

		if (char === "\\") {
			const nextChar = json[i + 1]
			if (nextChar === undefined) {
				repaired += "\\\\"
				continue
			}
			if (nextChar === "u") {
				const digits = json.slice(i + 2, i + 6)
				if (/^[0-9a-fA-F]{4}$/.test(digits)) {
					repaired += `\\u${digits}`
					i += 5
					continue
				}
			}
			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`
				i += 1
				continue
			}
			repaired += "\\\\"
			continue
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char
	}

	return repaired
}

export function parseJsonWithRepair(json) {
	try {
		return JSON.parse(json)
	} catch (error) {
		const repaired = repairJson(json)
		if (repaired !== json) return JSON.parse(repaired)
		throw error
	}
}

// Walk the (possibly truncated) JSON and produce a parseable completion
// by snapshotting "safely closeable" positions and falling back to the
// last one when the input ends mid-token.
//
// A position is safely closeable iff:
//   - we're not inside a string, AND
//   - we're not in the middle of a primitive token (number / true / false / null), AND
//   - the innermost open container is in a state where appending its
//     closing bracket produces valid JSON (just opened, or just past a value).
//
// We append `}` / `]` for each frame still open at that snapshot.

const FRESH = "fresh" // empty object or array
const AWAITING_KEY = "awaiting-key" // object: after `,`, expecting next key
const AWAITING_COLON = "awaiting-colon" // object: just saw key, need `:`
const AWAITING_VALUE = "awaiting-value" // object after `:` / array after `,`
const COMMA_OR_END = "comma-or-end" // either: just consumed a value

function isCloseable(state) {
	return state === FRESH || state === COMMA_OR_END
}

function valueAccepted(frame) {
	if (!frame) return
	frame.state = COMMA_OR_END
}

function completePartialJson(input) {
	const stack = []
	let i = 0
	let inString = false
	let stringIsKey = false
	let lastSafeEnd = 0
	let lastSafeStack = []

	const markSafe = () => {
		const top = stack[stack.length - 1]
		if (top && !isCloseable(top.state)) return
		lastSafeEnd = i
		lastSafeStack = stack.map((f) => f.kind)
	}

	const enterString = () => {
		const top = stack[stack.length - 1]
		stringIsKey =
			top?.kind === "object" && (top.state === FRESH || top.state === AWAITING_KEY)
	}

	markSafe()

	while (i < input.length) {
		const ch = input[i]

		if (inString) {
			if (ch === "\\") {
				i += 2
				continue
			}
			if (ch === '"') {
				inString = false
				i++
				const top = stack[stack.length - 1]
				if (stringIsKey) {
					if (top) top.state = AWAITING_COLON
				} else {
					valueAccepted(top)
					markSafe()
				}
				continue
			}
			i++
			continue
		}

		if (ch === '"') {
			inString = true
			enterString()
			i++
			continue
		}

		if (ch === "{") {
			stack.push({ kind: "object", state: FRESH })
			i++
			markSafe()
			continue
		}
		if (ch === "[") {
			stack.push({ kind: "array", state: FRESH })
			i++
			markSafe()
			continue
		}

		if (ch === "}" || ch === "]") {
			stack.pop()
			i++
			valueAccepted(stack[stack.length - 1])
			markSafe()
			continue
		}

		if (ch === ":") {
			const top = stack[stack.length - 1]
			if (top) top.state = AWAITING_VALUE
			i++
			continue
		}

		if (ch === ",") {
			const top = stack[stack.length - 1]
			if (top) top.state = top.kind === "object" ? AWAITING_KEY : AWAITING_VALUE
			i++
			continue
		}

		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			i++
			continue
		}

		// Primitive: number / true / false / null.
		const start = i
		while (i < input.length) {
			const c = input[i]
			if (c === "," || c === "}" || c === "]" || c === " " || c === "\t" || c === "\n" || c === "\r") break
			i++
		}
		const tok = input.slice(start, i)
		try {
			JSON.parse(tok)
			valueAccepted(stack[stack.length - 1])
			markSafe()
		} catch {
			break
		}
	}

	// Strategy 1 (preferred when in a value-position string): close the
	// string in place so we keep the partial value text.
	if (inString && !stringIsKey) {
		let out = `${input}"`
		for (let k = stack.length - 1; k >= 0; k--) {
			out += stack[k].kind === "object" ? "}" : "]"
		}
		try {
			JSON.parse(out)
			return out
		} catch {
			// Fall through to rollback.
		}
	}

	// Strategy 2 (rollback): truncate to the last safely-closeable position
	// and emit closing brackets.
	let out = input.slice(0, lastSafeEnd)
	for (let k = lastSafeStack.length - 1; k >= 0; k--) {
		out += lastSafeStack[k] === "object" ? "}" : "]"
	}
	return out
}

/**
 * Parse possibly-incomplete JSON streamed from a tool call. Always returns
 * an object — falls back to `{}` when nothing parseable can be recovered.
 */
export function parseStreamingJson(partialJson) {
	if (!partialJson || partialJson.trim() === "") return {}

	try {
		return parseJsonWithRepair(partialJson)
	} catch {
		try {
			const completed = completePartialJson(partialJson)
			if (completed) return JSON.parse(completed) ?? {}
			return {}
		} catch {
			try {
				const completed = completePartialJson(repairJson(partialJson))
				if (completed) return JSON.parse(completed) ?? {}
				return {}
			} catch {
				return {}
			}
		}
	}
}
