const CONTRACT_ERROR_PREFIX = "CEREX_CONTRACT_"

/**
 * An error produced by contract negotiation, dispatch, or validation.
 */
export class ContractError extends Error {
	constructor(code, message, details = {}) {
		super(message)
		this.name = "ContractError"
		this.code = `${CONTRACT_ERROR_PREFIX}${code}`
		Object.assign(this, details)
	}
}

function assertNonEmptyString(value, label) {
	if (typeof value !== "string" || !value) throw new TypeError(`${label} must be a non-empty string`)
}

function assertWireValue(value, label, ancestors = new Set()) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${label} must contain JSON-safe numbers`)
		return
	}
	if (typeof value !== "object") throw new TypeError(`${label} contains unsupported ${typeof value} data`)
	if (ancestors.has(value)) throw new TypeError(`${label} contains a cycle`)
	ancestors.add(value)
	if (Array.isArray(value)) {
		const ownNames = Object.getOwnPropertyNames(value)
		let hasEveryIndex = true
		for (let index = 0; index < value.length; index++) {
			if (!Object.prototype.hasOwnProperty.call(value, index)) {
				hasEveryIndex = false
				break
			}
		}
		if (!hasEveryIndex || ownNames.length !== value.length + 1 || Object.getOwnPropertySymbols(value).length > 0) {
			throw new TypeError(`${label} must not contain sparse arrays or named array properties`)
		}
		for (let index = 0; index < value.length; index++) assertWireValue(value[index], `${label}[${index}]`, ancestors)
	} else {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must contain only plain objects`)
		const keys = Object.keys(value)
		if (Object.getOwnPropertyNames(value).length !== keys.length || Object.getOwnPropertySymbols(value).length > 0) {
			throw new TypeError(`${label} must contain only enumerable string properties`)
		}
		for (const key of keys) assertWireValue(value[key], `${label}.${key}`, ancestors)
	}
	ancestors.delete(value)
}

function validateValue(validate, value, phase, contract, operation) {
	try {
		assertWireValue(value, phase)
		validate(value)
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause)
		const error = new ContractError(
			"VIOLATION",
			`${contract.name}@${contract.version} ${operation} ${phase} is invalid: ${message}`,
			{ contract: contract.name, version: contract.version, operation, phase },
		)
		error.cause = cause
		throw error
	}
}

function operationDefinition(contract, operation) {
	assertNonEmptyString(operation, "Contract operation")
	const definition = contract.operations[operation]
	if (!definition) {
		throw new ContractError(
			"OPERATION_NOT_FOUND",
			`Unknown operation ${contract.name}@${contract.version} ${operation}`,
			{ contract: contract.name, version: contract.version, operation },
		)
	}
	return definition
}

function assertRequest(request) {
	if (!request || typeof request !== "object" || Array.isArray(request)) {
		throw new ContractError("INVALID_REQUEST", "Contract request must be an object")
	}
	if (typeof request.contract !== "string" || !request.contract) {
		throw new ContractError("INVALID_REQUEST", "Contract request name must be a non-empty string")
	}
	if (typeof request.operation !== "string" || !request.operation) {
		throw new ContractError("INVALID_REQUEST", "Contract request operation must be a non-empty string")
	}
	if (!Number.isSafeInteger(request.version) || request.version < 1) {
		throw new ContractError("INVALID_REQUEST", "Contract request version must be a positive integer")
	}
}

/**
 * Defines a versioned set of unary operations over JSON-safe values. Validators assert operation-specific parameter and result shapes and must not transform their values.
 */
export function defineContract({ name, version, operations }) {
	assertNonEmptyString(name, "Contract name")
	if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("Contract version must be a positive integer")
	if (!operations || typeof operations !== "object" || Array.isArray(operations)) {
		throw new TypeError("Contract operations must be an object")
	}
	const normalized = {}
	for (const [operation, definition] of Object.entries(operations)) {
		assertNonEmptyString(operation, "Contract operation")
		if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
			throw new TypeError(`Contract operation ${operation} must be an object`)
		}
		if (typeof definition.params !== "function" || typeof definition.result !== "function") {
			throw new TypeError(`Contract operation ${operation} must define params and result validators`)
		}
		normalized[operation] = Object.freeze({ params: definition.params, result: definition.result })
	}
	if (Object.keys(normalized).length === 0) throw new TypeError("Contract must define at least one operation")
	return Object.freeze({ name, version, operations: Object.freeze(normalized) })
}

/**
 * Binds a contract to a peer. A peer only needs to implement call(request, { signal }).
 */
export function createContractClient(contract, peer) {
	if (!peer || typeof peer.call !== "function") throw new TypeError("Contract peer must implement call")
	return Object.freeze({
		contract,
		async call(operation, params, options = {}) {
			const definition = operationDefinition(contract, operation)
			validateValue(definition.params, params, "params", contract, operation)
			const result = await peer.call({
				contract: contract.name,
				version: contract.version,
				operation,
				params,
			}, { signal: options.signal })
			validateValue(definition.result, result, "result", contract, operation)
			return result
		},
	})
}

/**
 * Binds a contract to its host-side implementation. Context is supplied by the peer, not by the contract client.
 */
export function createContractDispatcher(contract, implementation) {
	if (!implementation || typeof implementation !== "object" || Array.isArray(implementation)) {
		throw new TypeError("Contract implementation must be an object")
	}
	for (const operation of Object.keys(contract.operations)) {
		if (typeof implementation[operation] !== "function") {
			throw new TypeError(`Contract implementation is missing ${operation}`)
		}
	}
	for (const operation of Object.keys(implementation)) {
		if (!contract.operations[operation]) throw new TypeError(`Contract implementation has unknown operation ${operation}`)
	}
	return Object.freeze({
		contract,
		async call(request, context = {}) {
			assertRequest(request)
			if (request.contract !== contract.name) {
				throw new ContractError("NOT_FOUND", `Unsupported contract ${request.contract}`, { contract: request.contract })
			}
			if (request.version !== contract.version) {
				throw new ContractError(
					"VERSION_MISMATCH",
					`Unsupported ${contract.name} contract version ${request.version}; expected ${contract.version}`,
					{ contract: contract.name, version: request.version, expectedVersion: contract.version },
				)
			}
			const definition = operationDefinition(contract, request.operation)
			validateValue(definition.params, request.params, "params", contract, request.operation)
			const result = await implementation[request.operation](request.params, context)
			validateValue(definition.result, result, "result", contract, request.operation)
			return result
		},
	})
}

/**
 * Creates an in-process peer over one or more dispatchers. Calls remain direct; replacing this peer is the only transport-specific change required by clients or hosts.
 */
export function createDirectContractPeer(dispatchers, { context = {} } = {}) {
	if (!Array.isArray(dispatchers) || dispatchers.length === 0) {
		throw new TypeError("Direct contract peer requires at least one dispatcher")
	}
	const byName = new Map()
	for (const dispatcher of dispatchers) {
		const name = dispatcher?.contract?.name
		assertNonEmptyString(name, "Dispatcher contract name")
		if (typeof dispatcher.call !== "function") throw new TypeError(`Dispatcher for ${name} must implement call`)
		if (byName.has(name)) throw new TypeError(`Duplicate contract dispatcher ${name}`)
		byName.set(name, dispatcher)
	}
	return Object.freeze({
		async call(request, options = {}) {
			assertRequest(request)
			const dispatcher = byName.get(request.contract)
			if (!dispatcher) {
				throw new ContractError("NOT_FOUND", `Unsupported contract ${request.contract}`, { contract: request.contract })
			}
			return dispatcher.call(request, { ...context, signal: options.signal })
		},
	})
}
