import { dedent } from "./dedent.js"

export function previewInstructions() {
	return dedent`
		Session previews:
		- \`cerex preview\` lists configured previews and concrete URLs for web apps and static sites; use those URLs rather than constructing hostnames.
		- Project static sites use \`.cerex/docs/\` or declarative \`*.preview.json\` files.
		- \`cerex preview --help\` describes definitions, static routing, runner environment, and access.`
}
