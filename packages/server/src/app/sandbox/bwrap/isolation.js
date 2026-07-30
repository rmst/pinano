/**
 * Bubblewrap's mount namespace is not sufficient on its own when Cerex is launched as uid 0. Explicitly entering a user namespace prevents inherited capabilities from applying to the caller's namespace, and dropping all capabilities keeps them out of the worker payload as well.
 */
export function bubblewrapIsolationArgs() {
	return [
		"--new-session",
		"--die-with-parent",
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--cap-drop", "ALL",
	]
}

const bubblewrapSecurityProbeScript = [
	"for path in /proc/sys/kernel/core_pattern /proc/sys/kernel/modprobe /proc/sys/vm/dirty_ratio /proc/sys/net/ipv4/ip_forward; do if [ -w \"$path\" ]; then echo \"bwrap security probe: $path is writable\" >&2; exit 1; fi; done",
	"if ! read -r namespace_uid parent_uid namespace_length < /proc/self/uid_map; then echo 'bwrap security probe: cannot inspect the worker user namespace' >&2; exit 1; fi",
	"if [ \"$namespace_uid:$parent_uid:$namespace_length\" = 0:0:4294967295 ]; then echo 'bwrap security probe: worker is in the initial user namespace' >&2; exit 1; fi",
	"capabilities=0",
	"no_new_privs=",
	"while IFS=: read -r key value; do",
	"\tset -- $value",
	"\tcase $key in",
	"\t\tCapInh|CapPrm|CapEff|CapBnd|CapAmb) case $1 in *[!0]*) capabilities=1 ;; esac ;;",
	"\t\tNoNewPrivs) no_new_privs=$1 ;;",
	"\tesac",
	"done < /proc/self/status",
	"if [ \"$capabilities\" != 0 ] || [ \"$no_new_privs\" != 1 ]; then echo 'bwrap security probe: worker privileges were not dropped' >&2; exit 1; fi",
].join("\n")

/** Fail closed unless Bubblewrap established the isolation properties the worker relies on. */
export const bubblewrapSecurityProbeCommand = [
	"/bin/sh",
	"-c",
	bubblewrapSecurityProbeScript,
]

/** Use the worker's real mount and isolation shape whenever validating Bubblewrap support. */
export function bubblewrapSecurityProbeArgs() {
	return [
		...bubblewrapIsolationArgs(),
		"--ro-bind", "/", "/",
		"--dev", "/dev",
		"--proc", "/proc",
		"--tmpfs", "/tmp",
		"--chdir", "/",
		"--",
		...bubblewrapSecurityProbeCommand,
	]
}
