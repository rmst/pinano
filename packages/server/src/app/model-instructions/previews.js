import { dedent } from "./dedent.js"

export function previewInstructions() {
	return dedent`
		Session previews:
		- Use \`pinano preview\` whenever you need to expose, inspect, or verify a web server, web app, docs server, or static HTML preview for the user.
		- It prints configured preview names, scopes, concrete URLs, source files, and log paths. Use the printed URLs; do not construct preview hostnames yourself.
		- Use \`pinano preview --help\` for preview module locations, runner environment variables, and hosted access notes.
		- Pinano starts each preview lazily on first request.`
}
