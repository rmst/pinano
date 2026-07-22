export function serviceHostForListen(host) {
	return typeof host === "string" && host ? host : "127.0.0.1"
}

export function serviceHostForConnect(host) {
	if (host === "0.0.0.0") return "127.0.0.1"
	if (host === "::") return "::1"
	return serviceHostForListen(host)
}
