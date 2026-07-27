const EXEC_GRAMMAR = String.raw`
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`

const EXEC_PREAMBLE = `Runs raw JavaScript in an isolated cell for orchestrating tools.

- Pass raw JavaScript source, not JSON, a quoted string, or a markdown code fence.
- Nested tools are methods on the global \`tools\` object and must be awaited, for example \`await tools.exec_command({ cmd: "git status" })\`.
- Function tools take an object argument. Freeform tools such as \`apply_patch\` take a string.
- Nested tools return a text string when they only produce text, or an object containing \`output\`, \`content\`, and tool-specific detail fields.
- Use nested tools for portable filesystem and process work. Node-backed cells expose only the orchestration API; qn-backed cells run directly in qn and may also expose its runtime APIs.
- An optional first-line pragma controls the initial yield and output budget: \`// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}\`.
- When evaluation completes, unawaited work is discarded.

Global helpers:
- \`text(value)\` appends text to the result.
- \`image(value, detail?)\` appends an image returned by a nested tool or a base64 \`data:\` URL. Detail, when supplied, must be \`auto\`, \`low\`, \`high\`, or \`original\`.
- \`store(key, value)\` and \`load(key)\` persist JSON-serializable values between cells in this agent.
- \`yield_control()\` yields accumulated output while the cell keeps running.
- \`exit()\` completes the cell successfully.
- \`setTimeout(callback, delayMs?)\` and \`clearTimeout(id)\` provide timers.
- \`ALL_TOOLS\` contains \`{ name, description }\` metadata for the nested tools.`

const WAIT_DESCRIPTION = `Waits on a running \`exec\` cell and returns new output or completion.

- Use \`wait\` only after \`exec\` returns a running cell ID.
- \`yield_time_ms\` controls how long to wait for more output. It defaults to 10000 ms.
- \`max_tokens\` limits this result's new output. It defaults to 10000 tokens.
- \`terminate: true\` stops the cell.
- Each call returns only output produced since the preceding \`exec\` or \`wait\` result.`

function identifierFor(name) {
	let result = ""
	for (const [index, char] of Array.from(name).entries()) {
		const valid = index === 0
			? /[A-Za-z_$]/.test(char)
			: /[A-Za-z0-9_$]/.test(char)
		result += valid ? char : "_"
	}
	return result || "_"
}

function literal(value) {
	if (typeof value === "string") return JSON.stringify(value)
	if (value === null || typeof value === "number" || typeof value === "boolean") return String(value)
	return "unknown"
}

function schemaType(schema, depth = 0) {
	if (!schema || typeof schema !== "object" || depth > 8) return "unknown"
	if (schema.const !== undefined) return literal(schema.const)
	if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum.map(literal).join(" | ")
	for (const key of ["anyOf", "oneOf"]) {
		if (Array.isArray(schema[key]) && schema[key].length > 0) {
			return schema[key].map((item) => schemaType(item, depth + 1)).join(" | ")
		}
	}
	if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
		return schema.allOf.map((item) => schemaType(item, depth + 1)).join(" & ")
	}
	if (Array.isArray(schema.type)) return schema.type.map((type) => schemaType({ ...schema, type }, depth + 1)).join(" | ")
	switch (schema.type) {
		case "string": return "string"
		case "number":
		case "integer": return "number"
		case "boolean": return "boolean"
		case "null": return "null"
		case "array": return `Array<${schemaType(schema.items, depth + 1)}>`
		case "object": {
			const required = new Set(Array.isArray(schema.required) ? schema.required : [])
			const properties = Object.entries(schema.properties ?? {}).map(([name, property]) => {
				const description = typeof property?.description === "string" && property.description.trim()
					? ` /** ${property.description.replaceAll("*/", "* /")} */`
					: ""
				return `${description} ${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${schemaType(property, depth + 1)};`
			})
			if (schema.additionalProperties !== false) {
				const additional = schema.additionalProperties && typeof schema.additionalProperties === "object"
					? schemaType(schema.additionalProperties, depth + 1)
					: "unknown"
				properties.push(`[key: string]: ${additional};`)
			}
			return `{${properties.length > 0 ? `\n  ${properties.join("\n  ")}\n` : ""}}`
		}
		default:
			if (schema.properties || schema.additionalProperties !== undefined) return schemaType({ ...schema, type: "object" }, depth + 1)
			if (schema.items) return schemaType({ ...schema, type: "array" }, depth + 1)
			return "unknown"
	}
}

function toolReference(tool) {
	const name = identifierFor(tool.name)
	const argumentName = tool.kind === "custom" ? "input" : "args"
	const inputType = tool.kind === "custom" ? "string" : schemaType(tool.parameters)
	const outputType = tool.codeMode?.outputSchema ? schemaType(tool.codeMode.outputSchema) : "CodeModeToolResult"
	return [
		`### \`tools.${name}\`${name === tool.name ? "" : ` (tool name: \`${tool.name}\`)`}`,
		tool.description?.trim() ?? "",
		"```ts",
		`declare const tools: { ${name}(${argumentName}: ${inputType}): Promise<${outputType}> }`,
		"```",
	].filter(Boolean).join("\n")
}

function assertDistinctToolIdentifiers(tools) {
	const seen = new Map()
	for (const tool of tools) {
		const identifier = identifierFor(tool.name)
		const existing = seen.get(identifier)
		if (seen.has(identifier)) throw new Error(`Code-mode tools "${existing}" and "${tool.name}" normalize to the same JavaScript identifier "${identifier}"`)
		seen.set(identifier, tool.name)
	}
}

export function parseExecSource(input) {
	if (typeof input !== "string" || !input.trim()) {
		throw new Error("exec expects non-empty raw JavaScript source")
	}
	const newline = input.indexOf("\n")
	const firstLine = newline === -1 ? input : input.slice(0, newline)
	const trimmed = firstLine.trimStart()
	if (!trimmed.startsWith("// @exec:")) {
		return { code: input, yieldTimeMs: undefined, maxOutputTokens: undefined }
	}
	if (newline === -1 || !input.slice(newline + 1).trim()) {
		throw new Error("exec pragma must be followed by JavaScript source")
	}
	let pragma
	try {
		pragma = JSON.parse(trimmed.slice("// @exec:".length).trim())
	} catch (error) {
		throw new Error(`exec pragma must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
	}
	if (!pragma || typeof pragma !== "object" || Array.isArray(pragma)) throw new Error("exec pragma must be a JSON object")
	const unknown = Object.keys(pragma).filter((key) => !["yield_time_ms", "max_output_tokens"].includes(key))
	if (unknown.length > 0) throw new Error(`exec pragma does not support ${unknown.map((key) => `\`${key}\``).join(", ")}`)
	for (const key of ["yield_time_ms", "max_output_tokens"]) {
		if (pragma[key] !== undefined && (!Number.isSafeInteger(pragma[key]) || pragma[key] < 0)) {
			throw new Error(`exec pragma field \`${key}\` must be a non-negative safe integer`)
		}
	}
	return {
		code: input.slice(newline + 1),
		yieldTimeMs: pragma.yield_time_ms,
		maxOutputTokens: pragma.max_output_tokens,
	}
}

export function createCodeModeToolDefinitions(tools) {
	assertDistinctToolIdentifiers(tools)
	const resultType = `type CodeModeToolResult =
	| string
	| {
		output?: string;
		content?: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string; detail?: "auto" | "low" | "high" | "original" }>;
		[key: string]: unknown;
	};`
	const description = [
		EXEC_PREAMBLE,
		resultType,
		...tools.map(toolReference),
	].join("\n\n")
	return [
		{
			kind: "custom",
			name: "exec",
			label: "exec",
			description,
			format: {
				type: "grammar",
				syntax: "lark",
				definition: EXEC_GRAMMAR,
			},
			executionMode: "sequential",
		},
		{
			name: "wait",
			label: "wait",
			description: WAIT_DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					cell_id: { type: "string", description: "Identifier returned by a running exec cell." },
					yield_time_ms: { type: "number", description: "How long to wait before yielding again. Defaults to 10000 ms." },
					max_tokens: { type: "number", description: "Approximate output token budget. Defaults to 10000 tokens." },
					terminate: { type: "boolean", description: "Stop the cell when true." },
				},
				required: ["cell_id"],
				additionalProperties: false,
			},
			executionMode: "sequential",
		},
	]
}

export function codeModeToolMetadata(tools) {
	assertDistinctToolIdentifiers(tools)
	return tools.map((tool) => ({
		name: tool.name,
		globalName: identifierFor(tool.name),
		description: tool.description ?? "",
		kind: tool.kind === "custom" ? "custom" : "function",
	}))
}
