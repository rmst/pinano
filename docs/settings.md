# Settings

Pinano reads settings from three layers, in order:

1. Built-in defaults.
2. `$PINANO_HOME/default-settings.json`, owned by the launcher or deployment.
3. `$PINANO_HOME/settings.json`, owned by the user and written by Pinano settings flows.

`default-settings.json` and `settings.json` have the same schema. Pinano never writes `default-settings.json`; it only writes `settings.json`. Put declarative install, launcher, or deployment defaults in `default-settings.json`, and let user choices accumulate in `settings.json`.

## Shape

```json
{
	"defaultModel": "llamacpp/local",
	"providers": {
		"llamacpp": {
			"baseUrl": "http://127.0.0.1:8080/v1",
			"apiKey": "local",
			"models": [
				{ "id": "local" }
			]
		}
	},
	"service": {
		"modelIoLog": false
	},
	"updateCheck": true,
	"thinkingLevel": "high"
}
```

Model refs are `provider/model-id`. The first slash separates the provider from the model id; the model id may contain additional slashes.

## Providers

`providers` is keyed by provider id. Supported provider ids are `openai`, `openai-codex`, `llamacpp`, `moonshot`, and `deepseek`.

Provider-level fields apply to all models under that provider:

- `baseUrl`: API base URL.
- `apiKey`: fallback API key when no credential exists under `$PINANO_HOME/auth/<provider>.json`.
- `headers`: extra HTTP headers.
- `compat`: OpenAI-compatible transport feature flags.
- `transport`: `chat` or `responses`.
- `models`: custom or declared model entries, each with an `id`.
- `modelOverrides`: registry model overrides keyed by model id.

Model entries may set `displayName`, `extends`, `baseUrl`, `wireModel`, `contextWindow`, `maxTokens`, `reasoning`, `input`, `cost`, `headers`, `compat`, `transport`, `maintenanceModelRef`, `toolProfile`, and `tags`.

## Service

The `service` object configures the local background service:

- `worker`: default worker launcher spec.
- `modelIoLog`: enable model I/O diagnostics.
- `modelIoLogDb`: custom diagnostics SQLite path.
- `diagnostics`: service trace/probe options.
- `token`: fixed local service capability token.

## Update Check

`updateCheck` controls the notice-only GitHub release check shown in the session overview. It defaults to `true` for ordinary installs. When enabled, Pinano checks the public package metadata at most once per local Pinano day, where the day starts at 04:00, and briefly shows a yellow overview notice if a newer version is available. Set it to `false` in `default-settings.json` for managed deployments or in `settings.json` for a user preference.

## Credentials

Pinano resolves provider credentials from `$PINANO_HOME/auth/<provider>.json` first, then from `providers.<provider>.apiKey`. API keys in settings are useful for declarative deployments and local launcher defaults.

## llama.cpp

Start a llama.cpp OpenAI-compatible server, then declare it:

```json
{
	"defaultModel": "llamacpp/local",
	"providers": {
		"llamacpp": {
			"baseUrl": "http://127.0.0.1:8080/v1",
			"apiKey": "local",
			"models": [
				{ "id": "local" }
			]
		}
	}
}
```

Pinano detects llama.cpp's served context window when the server exposes it. Set `contextWindow` on the model entry only when you need to override the detected value. Use the actual model id exposed by the server if it requires one. For a remote OpenAI-compatible endpoint, change `baseUrl` and `apiKey`.
