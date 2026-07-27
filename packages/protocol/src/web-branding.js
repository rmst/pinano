import { PRODUCT_NAME } from "./product.js"

export const WEB_PRODUCT_NAME = PRODUCT_NAME
export const WEB_PRODUCT_SHORT_NAME = PRODUCT_NAME
export const WEB_PRODUCT_DESCRIPTION = "Interactive AI coding assistant"
export const WEB_BROWSER_UI_NAME = `${WEB_PRODUCT_NAME} Web`
export const WEB_PANEL_LABEL = WEB_PRODUCT_NAME
export const WEB_APP_THEME_COLOR = "#151515"
export const WEB_APP_BACKGROUND_COLOR = "#151515"
export const WEB_APP_ICON_PATH = "/assets/brand/cerex-logo.png"
export const WEB_APP_ICON_VERSION = "cerex-4"
export const WEB_APP_ICON_HREF = `${WEB_APP_ICON_PATH}?v=${WEB_APP_ICON_VERSION}`
export const WEB_APP_PWA_ICON_PATH = "/assets/brand/cerex-logo-mark-cc16.png"
export const WEB_APP_PWA_ICON_SIZES = "1516x1516"
export const WEB_APP_PWA_ICON_VERSION = "cc16-1"
export const WEB_APP_PWA_ICON_HREF = `${WEB_APP_PWA_ICON_PATH}?v=${WEB_APP_PWA_ICON_VERSION}`
export const WEB_APP_FAVICON_PATH = "/assets/brand/cerex-favicon.png"
export const WEB_APP_FAVICON_SIZES = "512x512"
export const WEB_APP_FAVICON_VERSION = "favicon-2"
export const WEB_APP_FAVICON_HREF = `${WEB_APP_FAVICON_PATH}?v=${WEB_APP_FAVICON_VERSION}`
export const WEB_APP_TOUCH_ICON_HREF = WEB_APP_PWA_ICON_HREF
export const WEB_APP_MACOS_STATUS_ICON_PATH = "/assets/brand/cerex-macos-status-icon.png"
export const WEB_PUBLIC_ICON_ASSET_PATHS = [
	WEB_APP_ICON_PATH,
	WEB_APP_PWA_ICON_PATH,
	WEB_APP_FAVICON_PATH,
	"/favicon.ico",
	"/icon.svg",
	"/icon-maskable.svg",
]

export function webManifest() {
	return {
		id: "/",
		name: WEB_PRODUCT_NAME,
		short_name: WEB_PRODUCT_SHORT_NAME,
		description: WEB_PRODUCT_DESCRIPTION,
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: WEB_APP_BACKGROUND_COLOR,
		theme_color: WEB_APP_THEME_COLOR,
		icons: [
			{
				src: WEB_APP_PWA_ICON_HREF,
				sizes: WEB_APP_PWA_ICON_SIZES,
				type: "image/png",
				purpose: "any",
			},
		],
	}
}
