import { legacyProductEnvName, productEnvName, readProductEnv } from "./product.js"

export const INTERNAL_API_BASE_URL_ENV = productEnvName("INTERNAL_API_BASE_URL")
export const INTERNAL_API_TOKEN_ENV = productEnvName("INTERNAL_API_TOKEN")
export const PREVIEW_ACCESS_TOKEN_ENV = productEnvName("PREVIEW_ACCESS_TOKEN")
export const SESSION_ID_ENV = productEnvName("SESSION")

export const LEGACY_INTERNAL_API_BASE_URL_ENV = legacyProductEnvName("INTERNAL_API_BASE_URL")
export const LEGACY_INTERNAL_API_TOKEN_ENV = legacyProductEnvName("INTERNAL_API_TOKEN")
export const LEGACY_PREVIEW_ACCESS_TOKEN_ENV = legacyProductEnvName("PREVIEW_ACCESS_TOKEN")
export const LEGACY_SESSION_ID_ENV = legacyProductEnvName("SESSION")

export const internalApiBaseUrlFromEnv = (env) => readProductEnv(env, "INTERNAL_API_BASE_URL")
export const internalApiTokenFromEnv = (env) => readProductEnv(env, "INTERNAL_API_TOKEN")
export const previewAccessTokenFromEnv = (env) => readProductEnv(env, "PREVIEW_ACCESS_TOKEN")
export const sessionIdFromEnv = (env) => readProductEnv(env, "SESSION")
