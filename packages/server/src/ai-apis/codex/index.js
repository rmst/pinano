// Codex (ChatGPT subscription) entry point.
//
// Usage:
//
//   import { loginCodex, refreshCodex, streamCodex, completeCodex } from "./ai-apis/codex/index.js"
//
//   const credentials = await loginCodex({
//     onAuth: ({ url }) => console.log("Open in your browser:", url),
//   })
//   // Persist credentials somewhere (file, secret manager, etc).
//
//   const model = {
//     id: "gpt-5.5",
//     wireModel: "gpt-5.5",
//     provider: "openai-codex",
//     baseUrl: "https://chatgpt.com/backend-api",
//     reasoning: true,
//     input: ["text"],
//   }
//   const reply = await completeCodex(model, { messages: [...] }, { apiKey: credentials.access })
//
//   // Later, when access expires:
//   const refreshed = await refreshCodex(credentials.refresh)

export { streamCodex, completeCodex } from "./codex.js"
export {
	loginCodex,
	refreshCodex,
	buildAuthorizationUrl,
	configureOAuthEndpoints,
	resetOAuthEndpoints,
	_internal,
} from "./oauth.js"
export { generatePKCE } from "./pkce.js"
export {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
	shortHash,
} from "./responses-shared.js"
