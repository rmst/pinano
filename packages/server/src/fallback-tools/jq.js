#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const VERSION = "cerex-jq 0.1 jq-compatible JSON filter subset"

class JqError extends Error {
	constructor(message, exitCode = 2) {
		super(message)
		this.exitCode = exitCode
	}
}

const tokenNames = {
	"|": "pipe",
	",": "comma",
	":": "colon",
	"[": "left bracket",
	"]": "right bracket",
	"{": "left brace",
	"}": "right brace",
	"(": "left paren",
	"=": "assignment",
	"|=": "update assignment",
	"+=": "add assignment",
	"@": "format operator",
	")": "right paren",
}

function usage() {
	return `${VERSION}

Supported subset: ., field/index access, .[], pipes, comma, arrays,
objects, strings/numbers/booleans/null, variables from --arg/--argjson,
comparisons, //, and/or, if/then/else, as bindings, assignments, slices,
recursive descent, @csv/@tsv/@uri/@base64/@json, select(), map(), entries,
del(), sorting/grouping, string helpers, and common scalar/array/object
functions.

Options: -r/--raw-output, -c/--compact-output, -s/--slurp,
-n/--null-input, -R/--raw-input, -e/--exit-status, -S/--sort-keys,
--arg, --argjson, --version, --help.
Unsupported jq syntax and options fail clearly.
`
}

function parseArgs(args) {
	const config = {
		raw: false,
		compact: false,
		slurp: false,
		nullInput: false,
		rawInput: false,
		exitStatus: false,
		sortKeys: false,
		vars: {},
		filter: null,
		files: [],
	}
	let i = 0
	for (; i < args.length; i += 1) {
		const arg = args[i]
		if (arg === "--") {
			i += 1
			break
		}
		if (!arg.startsWith("-") || arg === "-") break
		if (arg === "--version") return { ...config, version: true }
		if (arg === "--help" || arg === "-h") return { ...config, help: true }
		if (arg === "--raw-output") config.raw = true
		else if (arg === "--compact-output") config.compact = true
		else if (arg === "--monochrome-output" || arg === "--color-output") {}
		else if (arg === "--slurp") config.slurp = true
		else if (arg === "--null-input") config.nullInput = true
		else if (arg === "--raw-input") config.rawInput = true
		else if (arg === "--exit-status") config.exitStatus = true
		else if (arg === "--sort-keys") config.sortKeys = true
		else if (arg === "--arg" || arg === "--argjson") {
			if (i + 2 >= args.length) throw new JqError(`option ${arg} requires two arguments`)
			const name = args[i + 1]
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new JqError(`invalid variable name: ${name}`)
			config.vars[name] = arg === "--arg" ? args[i + 2] : parseJson(args[i + 2], `${arg} ${name}`)
			i += 2
		} else if (arg.startsWith("--")) {
			throw new JqError(`unsupported option ${arg}`)
		} else {
			for (const flag of arg.slice(1)) {
				if (flag === "r") config.raw = true
				else if (flag === "c") config.compact = true
				else if (flag === "M" || flag === "C") {}
				else if (flag === "s") config.slurp = true
				else if (flag === "n") config.nullInput = true
				else if (flag === "R") config.rawInput = true
				else if (flag === "e") config.exitStatus = true
				else if (flag === "S") config.sortKeys = true
				else throw new JqError(`unsupported option -${flag}`)
			}
		}
	}
	if (i >= args.length) throw new JqError("missing filter")
	config.filter = args[i]
	config.files = args.slice(i + 1)
	return config
}

function parseJson(text, label = "JSON") {
	try {
		return JSON.parse(text)
	} catch (err) {
		throw new JqError(`${label}: invalid JSON: ${err.message}`, 4)
	}
}

class Lexer {
	constructor(text) {
		this.text = text
		this.index = 0
	}

	tokens() {
		const tokens = []
		while (true) {
			this.skipWhitespace()
			if (this.index >= this.text.length) break
			const start = this.index
			const char = this.text[this.index]
			const two = this.text.slice(this.index, this.index + 2)
			if (["==", "!=", "<=", ">=", "//", "..", "|=", "+="].includes(two)) {
				tokens.push({ type: two, value: two, start })
				this.index += 2
			} else if (/[0-9]/.test(char) || (char === "-" && /[0-9]/.test(this.text[this.index + 1] ?? "") && canStartNegativeNumber(tokens.at(-1)))) {
				tokens.push({ type: "number", value: this.readNumber(), start })
			} else if (".|,:[]{}()?<>+-*/%=@".includes(char)) {
				tokens.push({ type: char, value: char, start })
				this.index += 1
			} else if (char === "\"") {
				tokens.push({ type: "string", value: this.readString(), start })
			} else if (char === "$") {
				this.index += 1
				const name = this.readIdentifier()
				if (!name) throw new JqError(`expected variable name at column ${start + 1}`)
				tokens.push({ type: "var", value: name, start })
			} else if (/[A-Za-z_]/.test(char)) {
				const ident = this.readIdentifier()
				tokens.push({ type: "ident", value: ident, start })
			} else {
				throw new JqError(`unexpected character ${JSON.stringify(char)} at column ${start + 1}`)
			}
		}
		return tokens
	}

	skipWhitespace() {
		while (/\s/.test(this.text[this.index] ?? "")) this.index += 1
	}

	readString() {
		const start = this.index
		this.index += 1
		let escaped = false
		while (this.index < this.text.length) {
			const char = this.text[this.index]
			this.index += 1
			if (escaped) {
				escaped = false
			} else if (char === "\\") {
				escaped = true
			} else if (char === "\"") {
				return parseJson(this.text.slice(start, this.index), "string literal")
			}
		}
		throw new JqError(`unterminated string at column ${start + 1}`)
	}

	readIdentifier() {
		const start = this.index
		while (/[A-Za-z0-9_]/.test(this.text[this.index] ?? "")) this.index += 1
		return this.text.slice(start, this.index)
	}

	readNumber() {
		const start = this.index
		if (this.text[this.index] === "-") this.index += 1
		while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1
		if (this.text[this.index] === ".") {
			this.index += 1
			while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1
		}
		if (["e", "E"].includes(this.text[this.index])) {
			this.index += 1
			if (["+", "-"].includes(this.text[this.index])) this.index += 1
			while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1
		}
		const raw = this.text.slice(start, this.index)
		const value = Number(raw)
		if (!Number.isFinite(value)) throw new JqError(`invalid number at column ${start + 1}`)
		return value
	}
}

function canStartNegativeNumber(previous) {
	return !previous || ["|", ",", ":", "[", "(", "{", "==", "!=", "<", "<=", ">", ">=", "//", "+", "-", "*", "/", "%", "=", "|=", "+="].includes(previous.type)
}

class Parser {
	constructor(tokens) {
		this.tokens = tokens
		this.index = 0
	}

	parse() {
		const expression = this.parseComma()
		if (this.peek()) throw new JqError(`unexpected token ${this.describe(this.peek())}`)
		return expression
	}

	parseComma() {
		let node = this.parsePipe()
		while (this.match(",")) node = { type: "comma", left: node, right: this.parsePipe() }
		return node
	}

	parseAssignment() {
		const target = this.parseAlternative()
		if (this.match("=") || this.match("|=") || this.match("+=")) {
			const op = this.previous().type
			return { type: "assignment", op, target, value: this.parseAssignment() }
		}
		return target
	}

	parsePipe() {
		let node = this.parseAssignment()
		if (this.matchIdent("as")) {
			const token = this.consume("var", "expected variable after as")
			this.consume("|", "expected '|' after as binding")
			return { type: "bind", value: node, name: token.value, body: this.parsePipe() }
		}
		while (this.match("|")) node = { type: "pipe", left: node, right: this.parseAssignment() }
		return node
	}

	parseAlternative() {
		let node = this.parseOr()
		while (this.match("//")) node = { type: "alternative", left: node, right: this.parseOr() }
		return node
	}

	parseOr() {
		let node = this.parseAnd()
		while (this.matchIdent("or")) node = { type: "binary", op: "or", left: node, right: this.parseAnd() }
		return node
	}

	parseAnd() {
		let node = this.parseCompare()
		while (this.matchIdent("and")) node = { type: "binary", op: "and", left: node, right: this.parseCompare() }
		return node
	}

	parseCompare() {
		let node = this.parseAdd()
		while (["==", "!=", "<", "<=", ">", ">="].includes(this.peek()?.type)) {
			const op = this.next().type
			node = { type: "binary", op, left: node, right: this.parseAdd() }
		}
		return node
	}

	parseAdd() {
		let node = this.parseMultiply()
		while (this.match("+") || this.match("-")) {
			const op = this.previous().type
			node = { type: "binary", op, left: node, right: this.parseMultiply() }
		}
		return node
	}

	parseMultiply() {
		let node = this.parsePostfix()
		while (this.match("*") || this.match("/") || this.match("%")) {
			const op = this.previous().type
			node = { type: "binary", op, left: node, right: this.parsePostfix() }
		}
		return node
	}

	parsePostfix() {
		let node = this.parsePrimary()
		while (true) {
			if (this.match(".")) {
				node = this.parseDotSuffix(node)
			} else if (this.match("[")) {
				node = this.parseBracketSuffix(node)
			} else {
				return node
			}
		}
	}

	parsePrimary() {
		if (this.match("..")) return { type: "recursive" }
		if (this.match(".")) return this.parseDotSuffix({ type: "identity" })
		if (this.match("[")) return this.parseArray()
		if (this.match("{")) return this.parseObject()
		if (this.match("(")) {
			const node = this.parseComma()
			this.consume(")", "expected ')' after expression")
			return node
		}
		if (this.match("string")) return { type: "literal", value: this.previous().value }
		if (this.match("number")) return { type: "literal", value: this.previous().value }
		if (this.match("var")) return { type: "var", name: this.previous().value }
		if (this.match("@")) {
			const name = this.consume("ident", "expected format name after @").value
			return { type: "format", name }
		}
		if (this.matchIdent("true")) return { type: "literal", value: true }
		if (this.matchIdent("false")) return { type: "literal", value: false }
		if (this.matchIdent("null")) return { type: "literal", value: null }
		if (this.matchIdent("if")) return this.parseIfExpression()
		if (this.matchIdent("not")) return { type: "function", name: "not", args: [] }
		if (this.match("-")) return { type: "unary", op: "-", expr: this.parsePostfix() }
		if (this.match("ident")) {
			const name = this.previous().value
			if (this.match("(")) {
				const args = []
				if (!this.check(")")) {
					if (name === "del") {
						args.push(this.parseComma())
					} else {
						do args.push(this.parsePipe())
						while (this.match(","))
					}
				}
				this.consume(")", `expected ')' after ${name} arguments`)
				return { type: "function", name, args }
			}
			return { type: "function", name, args: [] }
		}
		throw new JqError(`expected expression${this.peek() ? ` before ${this.describe(this.peek())}` : ""}`)
	}

	parseIfExpression() {
		const start = this.index
		const thenIndex = this.findIfPart(start, "then")
		const elseIndex = this.findIfPart(thenIndex + 1, "else")
		const endIndex = this.findIfPart(elseIndex + 1, "end")
		const condition = this.parseSlice(start, thenIndex, "if condition")
		const thenBranch = this.parseSlice(thenIndex + 1, elseIndex, "then branch")
		const elseBranch = this.parseSlice(elseIndex + 1, endIndex, "else branch")
		this.index = endIndex + 1
		return { type: "if", condition, thenBranch, elseBranch }
	}

	findIfPart(start, name) {
		let depth = 0
		let ifDepth = 0
		for (let i = start; i < this.tokens.length; i += 1) {
			const token = this.tokens[i]
			if (["(", "[", "{"].includes(token.type)) depth += 1
			else if ([")", "]", "}"].includes(token.type)) depth -= 1
			if (depth !== 0 || token.type !== "ident") continue
			if (token.value === "if") ifDepth += 1
			else if (token.value === "end") {
				if (ifDepth === 0 && name === "end") return i
				ifDepth -= 1
			} else if (ifDepth === 0 && token.value === name) {
				return i
			}
		}
		throw new JqError(`expected ${name} in if expression`)
	}

	parseSlice(start, end, label) {
		if (end <= start) throw new JqError(`empty ${label}`)
		return new Parser(this.tokens.slice(start, end)).parse()
	}

	parseDotSuffix(base) {
		if (this.match("ident")) {
			const key = this.previous().value
			const optional = this.match("?")
			return { type: "field", base, key, optional }
		}
		if (this.match("[")) return this.parseBracketSuffix(base)
		return base
	}

	parseBracketSuffix(base) {
		if (this.match("]")) {
			const optional = this.match("?")
			return { type: "iterator", base, optional }
		}
		if (this.check(":") || (this.check("number") && this.tokens[this.index + 1]?.type === ":")) {
			const start = this.match("number") ? this.previous().value : null
			this.consume(":", "expected ':' in slice")
			const end = this.match("number") ? this.previous().value : null
			this.consume("]", "expected ']' after slice")
			const optional = this.match("?")
			return { type: "slice", base, start, end, optional }
		}
		const index = this.parseComma()
		this.consume("]", "expected ']' after index")
		const optional = this.match("?")
		return { type: "index", base, index, optional }
	}

	parseArray() {
		if (this.match("]")) return { type: "array", expr: null }
		const expr = this.parseComma()
		this.consume("]", "expected ']' after array expression")
		return { type: "array", expr }
	}

	parseObject() {
		const entries = []
		if (!this.check("}")) {
			do {
				if (this.match("ident")) {
					const key = this.previous().value
					const value = this.match(":") ? this.parsePipe() : { type: "field", base: { type: "identity" }, key, optional: false }
					entries.push({ key, value })
				} else if (this.match("string")) {
					const key = this.previous().value
					this.consume(":", "expected ':' after object key")
					entries.push({ key, value: this.parsePipe() })
				} else {
					throw new JqError(`expected object key before ${this.describe(this.peek())}`)
				}
			} while (this.match(","))
		}
		this.consume("}", "expected '}' after object")
		return { type: "object", entries }
	}

	match(...types) {
		if (!types.some((type) => this.check(type))) return false
		this.index += 1
		return true
	}

	matchIdent(value) {
		if (!this.check("ident") || this.peek().value !== value) return false
		this.index += 1
		return true
	}

	consume(type, message) {
		if (this.match(type)) return this.previous()
		throw new JqError(message)
	}

	check(type) {
		return this.peek()?.type === type
	}

	peek() {
		return this.tokens[this.index]
	}

	previous() {
		return this.tokens[this.index - 1]
	}

	next() {
		const token = this.peek()
		this.index += 1
		return token
	}

	describe(token) {
		if (!token) return "end of filter"
		return token.type === "ident" || token.type === "string" || token.type === "number" || token.type === "var"
			? `${token.type} ${JSON.stringify(token.value)}`
			: tokenNames[token.type] ?? JSON.stringify(token.type)
	}
}

function compile(filter) {
	const ast = new Parser(new Lexer(filter).tokens()).parse()
	validateAst(ast)
	return ast
}

const supportedFunctions = new Map([
	["select", 1],
	["map", 1],
	["length", 0],
	["keys", 0],
	["keys_unsorted", 0],
	["has", 1],
	["type", 0],
	["tostring", 0],
	["tonumber", 0],
	["not", 0],
	["empty", 0],
	["values", 0],
	["arrays", 0],
	["objects", 0],
	["strings", 0],
	["numbers", 0],
	["booleans", 0],
	["nulls", 0],
	["to_entries", 0],
	["from_entries", 0],
	["with_entries", 1],
	["add", 0],
	["join", 1],
	["split", 1],
	["contains", 1],
	["startswith", 1],
	["endswith", 1],
	["ltrimstr", 1],
	["rtrimstr", 1],
	["ascii_downcase", 0],
	["ascii_upcase", 0],
	["test", 1],
	["floor", 0],
	["ceil", 0],
	["round", 0],
	["sort", 0],
	["sort_by", 1],
	["unique", 0],
	["unique_by", 1],
	["group_by", 1],
	["reverse", 0],
	["first", 0],
	["last", 0],
	["min", 0],
	["max", 0],
	["min_by", 1],
	["max_by", 1],
	["flatten", 0],
	["del", 1],
])

function validateAst(node) {
	if (node.type === "format" && !["csv", "tsv", "uri", "base64", "json"].includes(node.name)) throw new JqError(`unsupported format @${node.name}`)
	if (node.type === "assignment") validateAssignmentTarget(node.target)
	if (node.type === "function") {
		if (!supportedFunctions.has(node.name)) throw new JqError(`unsupported function ${node.name}`)
		const arity = supportedFunctions.get(node.name)
		if (node.args.length !== arity) throw new JqError(`${node.name}() expects ${arity} argument${arity === 1 ? "" : "s"}`)
	}
	for (const child of astChildren(node)) validateAst(child)
}

function validateAssignmentTarget(node) {
	if (node.type === "identity") return
	if (node.type === "field" || node.type === "index" || node.type === "iterator") {
		validateAssignmentTarget(node.base)
		return
	}
	throw new JqError("assignments only support field, index, and iterator paths")
}

function astChildren(node) {
	if (node.type === "unary") return [node.expr]
	if (node.type === "field" || node.type === "iterator" || node.type === "slice") return [node.base]
	if (node.type === "index") return [node.base, node.index]
	if (["pipe", "comma", "alternative", "binary"].includes(node.type)) return [node.left, node.right]
	if (node.type === "assignment") return [node.target, node.value]
	if (node.type === "bind") return [node.value, node.body]
	if (node.type === "if") return [node.condition, node.thenBranch, node.elseBranch]
	if (node.type === "array") return node.expr ? [node.expr] : []
	if (node.type === "object") return node.entries.map((entry) => entry.value)
	if (node.type === "function") return node.args
	return []
}

function evaluate(node, input, context) {
	switch (node.type) {
		case "identity": return [input]
		case "literal": return [node.value]
		case "var": return [variableValue(node.name, context)]
		case "recursive": return recursiveValues(input)
		case "unary": return evaluateUnary(node, input, context)
		case "field": return evaluateField(node, input, context)
		case "index": return evaluateIndex(node, input, context)
		case "slice": return evaluateSlice(node, input, context)
		case "iterator": return evaluateIterator(node, input, context)
		case "pipe": return evaluate(node.left, input, context).flatMap((value) => evaluate(node.right, value, context))
		case "bind": return evaluate(node.value, input, context).flatMap((value) => evaluate(node.body, input, { ...context, vars: { ...context.vars, [node.name]: value } }))
		case "if": return evaluate(node.condition, input, context).some(truthy) ? evaluate(node.thenBranch, input, context) : evaluate(node.elseBranch, input, context)
		case "comma": return [...evaluate(node.left, input, context), ...evaluate(node.right, input, context)]
		case "alternative": return evaluateAlternative(node, input, context)
		case "binary": return evaluateBinary(node, input, context)
		case "array": return [node.expr ? evaluate(node.expr, input, context) : []]
		case "object": return [Object.fromEntries(node.entries.map((entry) => [entry.key, firstOrNull(evaluate(entry.value, input, context))]))]
		case "function": return evaluateFunction(node, input, context)
		case "assignment": return evaluateAssignment(node, input, context)
		case "format": return [formatFilter(node.name, input)]
		default: throw new JqError(`internal evaluator error: ${node.type}`, 5)
	}
}

function variableValue(name, context) {
	if (!Object.prototype.hasOwnProperty.call(context.vars, name)) throw new JqError(`undefined variable $${name}`)
	return context.vars[name]
}

function evaluateUnary(node, input, context) {
	const value = firstOrNull(evaluate(node.expr, input, context))
	if (node.op === "-") {
		if (typeof value !== "number") throw new JqError("unary - expects a number")
		return [-value]
	}
	throw new JqError(`unsupported unary operator ${node.op}`)
}

function evaluateField(node, input, context) {
	return evaluate(node.base, input, context).map((value) => {
		if (value == null) return null
		if (Array.isArray(value) || typeof value !== "object") {
			if (node.optional) return empty
			throw new JqError(`cannot index ${typeName(value)} with string ${JSON.stringify(node.key)}`, 5)
		}
		return Object.prototype.hasOwnProperty.call(value, node.key) ? value[node.key] : null
	}).filter((value) => value !== empty)
}

function evaluateIndex(node, input, context) {
	return evaluate(node.base, input, context).flatMap((value) => evaluate(node.index, value, context).map((index) => getIndex(value, index, node.optional)).filter((item) => item !== empty))
}

function evaluateSlice(node, input, context) {
	return evaluate(node.base, input, context).map((value) => getSlice(value, node.start, node.end, node.optional)).filter((item) => item !== empty)
}

function getSlice(value, start, end, optional) {
	if (!Array.isArray(value) && typeof value !== "string") {
		if (optional) return empty
		throw new JqError(`cannot slice ${typeName(value)}`, 5)
	}
	const length = value.length
	const normalize = (index, fallback) => index === null ? fallback : index < 0 ? Math.max(length + index, 0) : Math.min(index, length)
	return value.slice(normalize(start, 0), normalize(end, length))
}

function getIndex(value, index, optional) {
	if (Array.isArray(value) && typeof index === "number") return value.at(index) ?? null
	if (typeof value === "object" && value !== null && typeof index === "string") return Object.prototype.hasOwnProperty.call(value, index) ? value[index] : null
	if (typeof value === "string" && typeof index === "number") return value.at(index) ?? null
	if (optional) return empty
	throw new JqError(`cannot index ${typeName(value)} with ${typeName(index)}`, 5)
}

function recursiveValues(value) {
	const children = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : []
	return [value, ...children.flatMap(recursiveValues)]
}

function evaluateIterator(node, input, context) {
	return evaluate(node.base, input, context).flatMap((value) => {
		if (Array.isArray(value)) return value
		if (value && typeof value === "object") return Object.values(value)
		if (node.optional) return []
		throw new JqError(`cannot iterate over ${typeName(value)}`, 5)
	})
}

function evaluateAlternative(node, input, context) {
	const left = evaluate(node.left, input, context).filter((value) => value !== false && value !== null)
	return left.length > 0 ? left : evaluate(node.right, input, context)
}

function evaluateBinary(node, input, context) {
	if (node.op === "and" || node.op === "or") {
		const left = truthy(firstOrNull(evaluate(node.left, input, context)))
		return [node.op === "and" ? left && truthy(firstOrNull(evaluate(node.right, input, context))) : left || truthy(firstOrNull(evaluate(node.right, input, context)))]
	}
	const left = firstOrNull(evaluate(node.left, input, context))
	const right = firstOrNull(evaluate(node.right, input, context))
	if (node.op === "==") return [deepEqual(left, right)]
	if (node.op === "!=") return [!deepEqual(left, right)]
	if (["<", "<=", ">", ">="].includes(node.op)) return [compare(left, right, node.op)]
	if (node.op === "+") return [addValues(left, right)]
	if (["-", "*", "/", "%"].includes(node.op)) {
		if (typeof left !== "number" || typeof right !== "number") throw new JqError(`operator ${node.op} expects numbers`)
		if (node.op === "-") return [left - right]
		if (node.op === "*") return [left * right]
		if (node.op === "/") return [left / right]
		return [left % right]
	}
	throw new JqError(`unsupported operator ${node.op}`)
}

function evaluateFunction(node, input, context) {
	const arg = (index) => firstOrNull(evaluate(node.args[index], input, context))
	if (node.name === "select") {
		assertArity(node, 1)
		return evaluate(node.args[0], input, context).some(truthy) ? [input] : []
	}
	if (node.name === "map") {
		assertArity(node, 1)
		if (!Array.isArray(input)) throw new JqError("map() expects an array", 5)
		return [input.flatMap((value) => evaluate(node.args[0], value, context))]
	}
	if (node.name === "length") {
		assertArity(node, 0)
		if (Array.isArray(input) || typeof input === "string") return [input.length]
		if (input && typeof input === "object") return [Object.keys(input).length]
		if (input === null) return [0]
		throw new JqError(`length cannot be applied to ${typeName(input)}`, 5)
	}
	if (node.name === "keys") {
		assertArity(node, 0)
		return [keysOf(input, true)]
	}
	if (node.name === "has") {
		assertArity(node, 1)
		const key = arg(0)
		if (Array.isArray(input) && typeof key === "number") return [key >= 0 && key < input.length]
		if (input && typeof input === "object" && typeof key === "string") return [Object.prototype.hasOwnProperty.call(input, key)]
		return [false]
	}
	if (node.name === "type") {
		assertArity(node, 0)
		return [typeName(input)]
	}
	if (node.name === "tostring") {
		assertArity(node, 0)
		return [typeof input === "string" ? input : JSON.stringify(input)]
	}
	if (node.name === "tonumber") {
		assertArity(node, 0)
		const value = Number(input)
		if (!Number.isFinite(value)) throw new JqError(`cannot convert ${JSON.stringify(input)} to number`, 5)
		return [value]
	}
	if (node.name === "not") {
		assertArity(node, 0)
		return [!truthy(input)]
	}
	if (node.name === "empty") return []
	if (node.name === "values") return input == null ? [] : [input]
	if (node.name === "arrays") return Array.isArray(input) ? [input] : []
	if (node.name === "objects") return isPlainObject(input) ? [input] : []
	if (node.name === "strings") return typeof input === "string" ? [input] : []
	if (node.name === "numbers") return typeof input === "number" ? [input] : []
	if (node.name === "booleans") return typeof input === "boolean" ? [input] : []
	if (node.name === "nulls") return input === null ? [input] : []
	if (node.name === "keys_unsorted") return [keysOf(input, false)]
	if (node.name === "to_entries") return [toEntries(input)]
	if (node.name === "from_entries") return [fromEntries(input)]
	if (node.name === "with_entries") {
		if (!Array.isArray(toEntries(input))) throw new JqError("with_entries expects an object or array", 5)
		return [fromEntries(toEntries(input).flatMap((entry) => evaluate(node.args[0], entry, context)))]
	}
	if (node.name === "add") return [addArray(input)]
	if (node.name === "join") return [joinArray(input, arg(0))]
	if (node.name === "split") return [splitString(input, arg(0))]
	if (node.name === "contains") return [containsValue(input, arg(0))]
	if (node.name === "startswith") return [stringPredicate(input, arg(0), "startsWith")]
	if (node.name === "endswith") return [stringPredicate(input, arg(0), "endsWith")]
	if (node.name === "ltrimstr") return [trimString(input, arg(0), "start")]
	if (node.name === "rtrimstr") return [trimString(input, arg(0), "end")]
	if (node.name === "ascii_downcase") return [asciiCase(input, "lower")]
	if (node.name === "ascii_upcase") return [asciiCase(input, "upper")]
	if (node.name === "test") return [regexTest(input, arg(0))]
	if (node.name === "floor") return [numberFunction(input, Math.floor, "floor")]
	if (node.name === "ceil") return [numberFunction(input, Math.ceil, "ceil")]
	if (node.name === "round") return [numberFunction(input, Math.round, "round")]
	if (node.name === "sort") return [sortArray(input, (value) => value)]
	if (node.name === "sort_by") return [sortArray(input, (value) => firstOrNull(evaluate(node.args[0], value, context)))]
	if (node.name === "unique") return [uniqueArray(sortArray(input, (value) => value), (value) => value)]
	if (node.name === "unique_by") return [uniqueArray(sortArray(input, (value) => firstOrNull(evaluate(node.args[0], value, context))), (value) => firstOrNull(evaluate(node.args[0], value, context)))]
	if (node.name === "group_by") return [groupArray(sortArray(input, (value) => firstOrNull(evaluate(node.args[0], value, context))), (value) => firstOrNull(evaluate(node.args[0], value, context)))]
	if (node.name === "reverse") return [arrayInput(input, "reverse").toReversed ? arrayInput(input, "reverse").toReversed() : [...arrayInput(input, "reverse")].reverse()]
	if (node.name === "first") return [arrayInput(input, "first")[0] ?? null]
	if (node.name === "last") return [arrayInput(input, "last").at(-1) ?? null]
	if (node.name === "min") return [sortArray(input, (value) => value)[0] ?? null]
	if (node.name === "max") return [sortArray(input, (value) => value).at(-1) ?? null]
	if (node.name === "min_by") return [sortArray(input, (value) => firstOrNull(evaluate(node.args[0], value, context)))[0] ?? null]
	if (node.name === "max_by") return [sortArray(input, (value) => firstOrNull(evaluate(node.args[0], value, context))).at(-1) ?? null]
	if (node.name === "flatten") return [flattenArray(input)]
	if (node.name === "del") return [deletePaths(input, pathsFromAst(node.args[0]))]
	throw new JqError(`unsupported function ${node.name}`)
}

function evaluateAssignment(node, input, context) {
	const paths = concretePaths(node.target, input, context)
	const updateOne = (root, path) => {
		const current = getPath(root, path)
		if (node.op === "=") return firstOrNull(evaluate(node.value, input, context))
		if (node.op === "|=") return firstOrNull(evaluate(node.value, current, context))
		if (node.op === "+=") return addValues(current, firstOrNull(evaluate(node.value, current, context)))
		throw new JqError(`unsupported assignment operator ${node.op}`)
	}
	let result = structuredCloneCompat(input)
	if (paths.length === 0) return [result]
	for (const path of paths) {
		const next = updateOne(result, path)
		result = setPath(result, path, next)
	}
	return [result]
}

function concretePaths(node, input, context) {
	if (node.type === "identity") return [[]]
	if (node.type === "field") return concretePaths(node.base, input, context).map((path) => [...path, node.key])
	if (node.type === "index") {
		return concretePaths(node.base, input, context).flatMap((path) => {
			const baseValue = getPath(input, path)
			return evaluate(node.index, baseValue, context)
				.filter((key) => typeof key === "string" || typeof key === "number")
				.map((key) => [...path, key])
		})
	}
	if (node.type === "iterator") {
		return concretePaths(node.base, input, context).flatMap((path) => {
			const value = getPath(input, path)
			if (Array.isArray(value)) return value.map((_, index) => [...path, index])
			if (value && typeof value === "object") return Object.keys(value).map((key) => [...path, key])
			if (node.optional) return []
			throw new JqError(`cannot iterate over ${typeName(value)} in assignment path`, 5)
		})
	}
	throw new JqError("assignments only support field, index, and iterator paths", 2)
}

function getPath(value, path) {
	return path.reduce((current, key) => current == null ? null : current[key], value)
}

function setPath(root, path, value) {
	if (path.length === 0) return value
	const copy = root == null ? (typeof path[0] === "number" ? [] : {}) : root
	let current = copy
	for (let index = 0; index < path.length - 1; index += 1) {
		const key = path[index]
		const nextKey = path[index + 1]
		if (current[key] == null || typeof current[key] !== "object") current[key] = typeof nextKey === "number" ? [] : {}
		current = current[key]
	}
	current[path.at(-1)] = value
	return copy
}

function formatFilter(name, input) {
	if (name === "csv") return delimitedFormat(input, ",", csvCell)
	if (name === "tsv") return delimitedFormat(input, "\t", tsvCell)
	if (name === "uri") {
		if (typeof input !== "string") throw new JqError("@uri expects a string", 5)
		return encodeURIComponent(input)
	}
	if (name === "base64") {
		if (typeof input !== "string") throw new JqError("@base64 expects a string", 5)
		return Buffer.from(input).toString("base64")
	}
	if (name === "json") return JSON.stringify(input)
	throw new JqError(`unsupported format @${name}`)
}

function delimitedFormat(input, separator, cellFormat) {
	if (!Array.isArray(input)) throw new JqError(`@${separator === "," ? "csv" : "tsv"} expects an array`, 5)
	return input.map(cellFormat).join(separator)
}

function csvCell(value) {
	if (value == null) return ""
	const text = typeof value === "string" ? value : JSON.stringify(value)
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function tsvCell(value) {
	if (value == null) return ""
	const text = typeof value === "string" ? value : JSON.stringify(value)
	return text.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n").replaceAll("\r", "\\r")
}

function assertArity(node, arity) {
	if (node.args.length !== arity) throw new JqError(`${node.name}() expects ${arity} argument${arity === 1 ? "" : "s"}`)
}

function arrayInput(value, name) {
	if (!Array.isArray(value)) throw new JqError(`${name} expects an array`, 5)
	return value
}

function keysOf(value, sorted) {
	if (Array.isArray(value)) return value.map((_, index) => index)
	if (value && typeof value === "object") {
		const keys = Object.keys(value)
		return sorted ? keys.sort() : keys
	}
	throw new JqError(`keys cannot be applied to ${typeName(value)}`, 5)
}

function toEntries(value) {
	if (Array.isArray(value)) return value.map((item, index) => ({ key: index, value: item }))
	if (value && typeof value === "object") return Object.entries(value).map(([key, item]) => ({ key, value: item }))
	throw new JqError(`to_entries cannot be applied to ${typeName(value)}`, 5)
}

function fromEntries(value) {
	return Object.fromEntries(arrayInput(value, "from_entries").map((entry) => {
		if (!entry || typeof entry !== "object") throw new JqError("from_entries expects objects with key and value", 5)
		return [String(entry.key ?? entry.name), entry.value]
	}))
}

function addArray(value) {
	const array = arrayInput(value, "add")
	if (array.length === 0) return null
	return array.slice(1).reduce(addValues, array[0])
}

function joinArray(value, separator) {
	if (typeof separator !== "string") throw new JqError("join separator must be a string", 5)
	return arrayInput(value, "join").map((item) => item == null ? "" : typeof item === "string" ? item : JSON.stringify(item)).join(separator)
}

function splitString(value, separator) {
	if (typeof value !== "string" || typeof separator !== "string") throw new JqError("split expects string input and separator", 5)
	return value.split(separator)
}

function stringPredicate(value, prefix, method) {
	if (typeof value !== "string" || typeof prefix !== "string") throw new JqError(`${method} expects strings`, 5)
	return value[method](prefix)
}

function trimString(value, affix, side) {
	if (typeof value !== "string" || typeof affix !== "string") throw new JqError("trim string functions expect strings", 5)
	if (side === "start") return value.startsWith(affix) ? value.slice(affix.length) : value
	return value.endsWith(affix) ? value.slice(0, -affix.length) : value
}

function asciiCase(value, mode) {
	if (typeof value !== "string") throw new JqError("ascii case functions expect strings", 5)
	return value.replace(/[A-Z]/gi, (char) => mode === "lower" ? char.toLowerCase() : char.toUpperCase())
}

function regexTest(value, pattern) {
	if (typeof value !== "string" || typeof pattern !== "string") throw new JqError("test expects string input and pattern", 5)
	return new RegExp(pattern).test(value)
}

function numberFunction(value, fn, name) {
	if (typeof value !== "number") throw new JqError(`${name} expects a number`, 5)
	return fn(value)
}

function containsValue(value, needle) {
	if (typeof value === "string" && typeof needle === "string") return value.includes(needle)
	if (Array.isArray(value)) return Array.isArray(needle)
		? needle.every((item) => value.some((candidate) => deepEqual(candidate, item)))
		: value.some((candidate) => deepEqual(candidate, needle))
	if (isPlainObject(value) && isPlainObject(needle)) return Object.entries(needle).every(([key, item]) => containsValue(value[key], item))
	return deepEqual(value, needle)
}

function sortArray(value, keyFn) {
	return [...arrayInput(value, "sort")].sort((a, b) => compareSortKeys(keyFn(a), keyFn(b)))
}

function compareSortKeys(left, right) {
	const rank = (value) => value === null ? 0 : typeof value === "boolean" ? 1 : typeof value === "number" ? 2 : typeof value === "string" ? 3 : Array.isArray(value) ? 4 : 5
	const leftRank = rank(left)
	const rightRank = rank(right)
	if (leftRank !== rightRank) return leftRank - rightRank
	if (typeof left === "number" || typeof left === "string" || typeof left === "boolean") return left < right ? -1 : left > right ? 1 : 0
	return stableJson(left).localeCompare(stableJson(right))
}

function uniqueArray(value, keyFn) {
	const seen = new Set()
	return arrayInput(value, "unique").filter((item) => {
		const key = stableJson(keyFn(item))
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

function groupArray(value, keyFn) {
	const groups = []
	for (const item of arrayInput(value, "group_by")) {
		const key = stableJson(keyFn(item))
		const group = groups.at(-1)
		if (group && group.key === key) group.items.push(item)
		else groups.push({ key, items: [item] })
	}
	return groups.map((group) => group.items)
}

function flattenArray(value) {
	return arrayInput(value, "flatten").flat(Infinity)
}

function pathsFromAst(node) {
	if (node.type === "comma") return [...pathsFromAst(node.left), ...pathsFromAst(node.right)]
	const path = pathFromAst(node)
	return path.length === 0 ? [] : [path]
}

function pathFromAst(node) {
	if (node.type === "identity") return []
	if (node.type === "field") return [...pathFromAst(node.base), node.key]
	if (node.type === "index" && node.index.type === "literal" && ["string", "number"].includes(typeof node.index.value)) return [...pathFromAst(node.base), node.index.value]
	throw new JqError("del only supports simple field/index paths", 2)
}

function deletePaths(value, paths) {
	const copy = structuredCloneCompat(value)
	for (const path of paths) deletePath(copy, path)
	return copy
}

function deletePath(value, path) {
	if (path.length === 0 || value == null) return
	const [head, ...tail] = path
	if (tail.length === 0) {
		if (Array.isArray(value) && typeof head === "number") value.splice(head, 1)
		else if (typeof value === "object") delete value[head]
		return
	}
	deletePath(value[head], tail)
}

function structuredCloneCompat(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function addValues(left, right) {
	if (typeof left === "number" && typeof right === "number") return left + right
	if (typeof left === "string" && typeof right === "string") return left + right
	if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right]
	if (isPlainObject(left) && isPlainObject(right)) return { ...left, ...right }
	throw new JqError(`operator + cannot add ${typeName(left)} and ${typeName(right)}`, 5)
}

function compare(left, right, op) {
	if (typeof left !== typeof right || !(typeof left === "number" || typeof left === "string")) throw new JqError(`operator ${op} expects comparable numbers or strings`, 5)
	if (op === "<") return left < right
	if (op === "<=") return left <= right
	if (op === ">") return left > right
	return left >= right
}

function isPlainObject(value) {
	return value && typeof value === "object" && !Array.isArray(value)
}

const empty = Symbol("empty")

function firstOrNull(values) {
	return values.length === 0 ? null : values[0]
}

function truthy(value) {
	return value !== false && value !== null
}

function typeName(value) {
	if (value === null) return "null"
	if (Array.isArray(value)) return "array"
	return typeof value === "object" ? "object" : typeof value
}

function deepEqual(left, right) {
	return stableJson(left) === stableJson(right)
}

function stableJson(value) {
	return JSON.stringify(sortObjectKeys(value))
}

function sortObjectKeys(value) {
	if (Array.isArray(value)) return value.map(sortObjectKeys)
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]))
	return value
}

async function readInputs(config) {
	if (config.nullInput) return [null]
	const texts = config.files.length === 0 || config.files.includes("-")
		? [await readStdin(), ...await Promise.all(config.files.filter((file) => file !== "-").map((file) => readFile(file, "utf-8")))]
		: await Promise.all(config.files.map((file) => readFile(file, "utf-8")))
	if (config.rawInput) {
		const values = texts.flatMap(rawInputValues)
		return config.slurp ? [texts.join("")] : values
	}
	const values = texts.flatMap((text, index) => parseJsonStream(text, config.files[index] ?? "stdin"))
	return config.slurp ? [values] : values
}

function rawInputValues(text) {
	if (text === "") return []
	const lines = text.split(/\r?\n/)
	if (text.endsWith("\n")) lines.pop()
	return lines
}

async function readStdin() {
	const chunks = []
	return new Promise((resolvePromise, reject) => {
		process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
		process.stdin.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf-8")))
		process.stdin.on("error", reject)
		process.stdin.resume?.()
	})
}

function parseJsonStream(text, label) {
	const values = []
	let index = skipWhitespace(text, 0)
	while (index < text.length) {
		const end = jsonValueEnd(text, index)
		values.push(parseJson(text.slice(index, end), label))
		index = skipWhitespace(text, end)
	}
	return values
}

function skipWhitespace(text, index) {
	while (/\s/.test(text[index] ?? "")) index += 1
	return index
}

function jsonValueEnd(text, start) {
	const char = text[start]
	if (char === "{" || char === "[") return compoundJsonEnd(text, start)
	if (char === "\"") return stringEnd(text, start)
	const match = text.slice(start).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|^(?:true|false|null)/)
	if (!match) throw new JqError(`invalid JSON near column ${start + 1}`, 4)
	return start + match[0].length
}

function compoundJsonEnd(text, start) {
	const stack = []
	let index = start
	while (index < text.length) {
		const char = text[index]
		if (char === "\"") {
			index = stringEnd(text, index)
			continue
		}
		if (char === "{" || char === "[") stack.push(char)
		else if (char === "}" || char === "]") {
			const open = stack.pop()
			if ((char === "}" && open !== "{") || (char === "]" && open !== "[")) throw new JqError(`invalid JSON near column ${index + 1}`, 4)
			if (stack.length === 0) return index + 1
		}
		index += 1
	}
	throw new JqError("unterminated JSON input", 4)
}

function stringEnd(text, start) {
	let index = start + 1
	let escaped = false
	while (index < text.length) {
		const char = text[index]
		index += 1
		if (escaped) escaped = false
		else if (char === "\\") escaped = true
		else if (char === "\"") return index
	}
	throw new JqError(`unterminated string near column ${start + 1}`, 4)
}

function formatOutput(value, config) {
	if (config.raw && typeof value === "string") return `${value}\n`
	const output = config.sortKeys ? sortObjectKeys(value) : value
	return `${JSON.stringify(output, null, config.compact ? 0 : 2)}\n`
}

async function run(config) {
	const ast = compile(config.filter)
	const inputs = await readInputs(config)
	const outputs = inputs.flatMap((input) => evaluate(ast, input, { vars: config.vars }))
	for (const output of outputs) process.stdout.write(formatOutput(output, config))
	if (config.exitStatus) {
		if (outputs.length === 0) return 1
		return truthy(outputs.at(-1)) ? 0 : 1
	}
	return 0
}

async function main() {
	try {
		const config = parseArgs(process.argv.slice(2))
		if (config.version) {
			process.stdout.write(`${VERSION}\n`)
			return 0
		}
		if (config.help) {
			process.stdout.write(usage())
			return 0
		}
		return await run(config)
	} catch (err) {
		const code = err?.exitCode ?? 5
		process.stderr.write(`cerex jq fallback: ${err?.message || err}\n`)
		if (code === 2) process.stderr.write("This fallback only supports common jq JSON filtering. Install jq for full support.\n")
		return code
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	process.exitCode = await main()
}
