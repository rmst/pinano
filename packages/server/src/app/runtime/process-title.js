/**
 * @typedef {"cli" | "service" | "supervisor" | "tui" | "web"} ProcessTitleRole
 * @typedef {{
 *   help?: boolean,
 *   version?: boolean,
 *   web?: boolean,
 *   serviceRun?: boolean,
 *   serviceForeground?: boolean,
 *   sessionCommand?: string,
 *   command?: string,
 * }} ProcessTitleArgs
 * @typedef {{ env?: Record<string, string | undefined>, process?: { title: string } }} ProcessTitleOptions
 */

const DEFAULT_ROLE_SUFFIXES = {
	cli: "",
	service: "",
	supervisor: "",
	tui: "",
	web: "",
}

const DEFAULT_ROLE_PREFIXES = {
	cli: "",
	service: "service ",
	supervisor: "supervisor ",
	tui: "tui ",
	web: "web ",
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

// Launchers own the base CEREX_PROCESS_TITLE. Role defaults are prefixes so truncated process-name views still show the role; env vars such as CEREX_PROCESS_TITLE_SERVICE_SUFFIX can override this without changing how services are spawned.
function roleEnvKey(role, part) {
	return `CEREX_PROCESS_TITLE_${role.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_${part}`
}

function envValue(env, key) {
	return hasOwn(env, key) ? env[key] ?? "" : undefined
}

/**
 * @param {ProcessTitleArgs} args
 * @returns {ProcessTitleRole}
 */
export function processTitleRoleForArgs(args) {
	if (args.help || args.version) return "cli"
	if (args.serviceRun || (args.command === "service-start" && args.serviceForeground)) return "service"
	if (args.sessionCommand || args.command?.startsWith?.("service-")) return "cli"
	if (args.web) return "web"
	return "tui"
}

/**
 * @param {ProcessTitleRole} role
 * @param {Record<string, string | undefined>} [env]
 */
export function processTitleForRole(role, env = process.env) {
	const base = env.CEREX_PROCESS_TITLE
	if (!base) return ""
	const prefix = envValue(env, roleEnvKey(role, "PREFIX")) ?? DEFAULT_ROLE_PREFIXES[role] ?? ""
	const suffix = envValue(env, roleEnvKey(role, "SUFFIX")) ?? DEFAULT_ROLE_SUFFIXES[role] ?? ""
	return `${prefix}${base}${suffix}`
}

/**
 * @param {ProcessTitleRole} role
 * @param {ProcessTitleOptions} [options]
 */
export function applyProcessTitleRole(role, options = {}) {
	const title = processTitleForRole(role, options.env ?? process.env)
	if (title) (options.process ?? process).title = title
	return title
}

/**
 * @param {ProcessTitleArgs} args
 * @param {ProcessTitleOptions} [options]
 */
export function applyProcessTitleForArgs(args, options) {
	return applyProcessTitleRole(processTitleRoleForArgs(args), options)
}
