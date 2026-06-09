const SEATBELT_BASE_POLICY = String.raw`(version 1)

; Base policy adapted from Codex's Seatbelt sandbox profile.
(deny default)

; Child processes inherit the policy of their parent.
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))

; Process metadata about processes in this same sandbox.
(allow process-info* (target same-sandbox))

(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.model")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "net.routetable."))

; Java CPU detection can issue a sysctl-write that is conceptually read-only.
(allow sysctl-write
  (sysctl-name "kern.grade_cputype"))

(allow iokit-open
  (iokit-registry-entry-class "RootDomainUserClient"))

(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.PowerManagement.control"))

; Python multiprocessing and common native compute runtimes.
(allow ipc-posix-sem)
(allow ipc-posix-shm-read-data
  ipc-posix-shm-write-create
  ipc-posix-shm-write-unlink
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))

; PTYs and existing terminal handles.
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))

; Read-only user preferences.
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))
(allow mach-lookup
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (local-name "com.apple.cfprefsd.agent"))
(allow user-preference-read)`

const SEATBELT_PLATFORM_DEFAULTS = String.raw`; macOS platform defaults for ordinary command-line tool startup.
(allow file-read* file-test-existence
  (subpath "/Library/Apple")
  (subpath "/Library/Filesystems/NetFSPlugins")
  (subpath "/Library/Preferences/Logging")
  (subpath "/private/var/db/DarwinDirectory/local/recordStore.data")
  (subpath "/private/var/db/timezone")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/Library/Preferences")
  (subpath "/var/db")
  (subpath "/private/var/db"))

(allow file-map-executable
  (subpath "/Library/Apple/System/Library/Frameworks")
  (subpath "/Library/Apple/System/Library/PrivateFrameworks")
  (subpath "/Library/Apple/usr/lib")
  (subpath "/Applications")
  (subpath "/Library/Developer")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/System/Library/Extensions")
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/OpenSSL")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/System/Library/SubFrameworks")
  (subpath "/System/Cryptexes")
  (subpath "/System/iOSSupport/System/Library/Frameworks")
  (subpath "/System/iOSSupport/System/Library/PrivateFrameworks")
  (subpath "/System/iOSSupport/System/Library/SubFrameworks")
  (subpath "/opt/homebrew")
  (subpath "/usr/bin")
  (subpath "/usr/lib")
  (subpath "/usr/libexec")
  (subpath "/usr/local")
  (subpath "/usr/sbin")
  (subpath "/var/run/com.apple.security.cryptexd")
  (subpath "/private/var/run/com.apple.security.cryptexd"))

(allow file-read* file-test-existence
  (subpath "/Library/Apple/System/Library/Frameworks")
  (subpath "/Library/Apple/System/Library/PrivateFrameworks")
  (subpath "/Library/Apple/usr/lib")
  (subpath "/Library/Developer")
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/OpenSSL")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/System/Library/SubFrameworks")
  (subpath "/System/Cryptexes")
  (subpath "/System/iOSSupport/System/Library/Frameworks")
  (subpath "/System/iOSSupport/System/Library/PrivateFrameworks")
  (subpath "/System/iOSSupport/System/Library/SubFrameworks")
  (subpath "/var/run/com.apple.security.cryptexd")
  (subpath "/private/var/run/com.apple.security.cryptexd")
  (subpath "/usr/lib"))

(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall
  (require-all
    (mac-policy-name "Sandbox")
    (mac-syscall-number 67)))

(allow file-read-metadata file-test-existence
  (literal "/etc")
  (literal "/tmp")
  (literal "/var")
  (literal "/private/etc/localtime"))

(allow file-read-metadata file-test-existence
  (path-ancestors "/System/Volumes/Data/private"))

(allow file-read* file-test-existence
  (literal "/"))

(allow system-fsctl (fsctl-command FSIOC_CAS_BSDFLAGS))

(allow file-read* file-test-existence
  (literal "/dev/autofs_nowait")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/private/etc/master.passwd")
  (literal "/private/etc/passwd")
  (literal "/private/etc/protocols")
  (literal "/private/etc/services"))

(allow file-read* file-test-existence file-write-data
  (literal "/dev/null")
  (literal "/dev/zero"))

(allow file-read-data file-test-existence file-write-data
  (subpath "/dev/fd"))

(allow file-read* file-test-existence file-write-data file-ioctl
  (literal "/dev/dtracehelper"))

; Scratch space for compilers, package managers, shells, and test runners.
(allow file-read* file-test-existence file-write* (subpath "/tmp"))
(allow file-read* file-write* (subpath "/private/tmp"))
(allow file-read* file-write* (subpath "/var/tmp"))
(allow file-read* file-write* (subpath "/private/var/tmp"))

(allow file-read* (subpath "/etc"))
(allow file-read* (subpath "/private/etc"))

(allow file-read* file-test-existence
  (literal "/System/Library/CoreServices")
  (literal "/System/Library/CoreServices/.SystemVersionPlatform.plist")
  (literal "/System/Library/CoreServices/SystemVersion.plist"))

(allow file-read-metadata (subpath "/var"))
(allow file-read-metadata (subpath "/private/var"))

(allow iokit-open
  (iokit-registry-entry-class "RootDomainUserClient"))

(allow mach-lookup
  (global-name "com.apple.analyticsd")
  (global-name "com.apple.analyticsd.messagetracer")
  (global-name "com.apple.appsleep")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.dt.automationmode.reader")
  (global-name "com.apple.espd")
  (global-name "com.apple.logd")
  (global-name "com.apple.logd.events")
  (global-name "com.apple.runningboard")
  (global-name "com.apple.secinitd")
  (global-name "com.apple.system.DirectoryService.libinfo_v1")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.xpc.activity.unmanaged")
  (local-name "com.apple.cfprefsd.agent"))

(allow network-outbound (literal "/private/var/run/syslog"))

(allow ipc-posix-shm-read*
  (ipc-posix-name "apple.shm.notification_center"))

(allow file-read*
  (literal "/private/var/db/eligibilityd/eligibility.plist"))

(allow mach-lookup
  (global-name "com.apple.audio.audiohald")
  (global-name "com.apple.audio.AudioComponentRegistrar")
  (global-name "com.apple.PowerManagement.control"))

(allow file-read-data (subpath "/bin"))
(allow file-read-metadata (subpath "/bin"))
(allow file-read-data (subpath "/sbin"))
(allow file-read-metadata (subpath "/sbin"))
(allow file-read-data (subpath "/usr/bin"))
(allow file-read-metadata (subpath "/usr/bin"))
(allow file-read-data (subpath "/usr/sbin"))
(allow file-read-metadata (subpath "/usr/sbin"))
(allow file-read-data (subpath "/usr/libexec"))
(allow file-read-metadata (subpath "/usr/libexec"))
(allow file-read-data (subpath "/System/Cryptexes"))
(allow file-read-metadata (subpath "/System/Cryptexes"))
(allow file-read-data (subpath "/var/run/com.apple.security.cryptexd"))
(allow file-read-metadata (subpath "/var/run/com.apple.security.cryptexd"))
(allow file-read-data (subpath "/private/var/run/com.apple.security.cryptexd"))
(allow file-read-metadata (subpath "/private/var/run/com.apple.security.cryptexd"))

(allow file-read* (subpath "/Library/Preferences"))
(allow file-read* (subpath "/Library/Developer"))
(allow file-read* (subpath "/opt/homebrew"))
(allow file-read* (subpath "/usr/local"))
(allow file-read* (subpath "/Applications"))
(allow file-read* (subpath "/System/Cryptexes"))
(allow file-read* (subpath "/var/run/com.apple.security.cryptexd"))
(allow file-read* (subpath "/private/var/run/com.apple.security.cryptexd"))

(allow file-read* (regex "^/dev/fd/(0|1|2)$"))
(allow file-write* (regex "^/dev/fd/(1|2)$"))
(allow file-read* file-write* (literal "/dev/null"))
(allow file-read* file-write* (literal "/dev/tty"))
(allow file-read-metadata (literal "/dev"))
(allow file-read-metadata (regex "^/dev/.*$"))
(allow file-read-metadata (literal "/dev/stdin"))
(allow file-read-metadata (literal "/dev/stdout"))
(allow file-read-metadata (literal "/dev/stderr"))
(allow file-read-metadata (regex "^/dev/tty[^/]*$"))
(allow file-read-metadata (regex "^/dev/pty[^/]*$"))
(allow file-read* file-write* (regex "^/dev/ttys[0-9]+$"))
(allow file-read* file-write* (literal "/dev/ptmx"))
(allow file-ioctl (regex "^/dev/ttys[0-9]+$"))

(allow file-read-metadata (literal "/System/Volumes") (vnode-type DIRECTORY))
(allow file-read-metadata (literal "/System/Volumes/Data") (vnode-type DIRECTORY))
(allow file-read-metadata (literal "/System/Volumes/Data/Users") (vnode-type DIRECTORY))

(allow file-read* (extension "com.apple.app-sandbox.read"))
(allow file-read* file-write* (extension "com.apple.app-sandbox.read-write"))`

const SEATBELT_FULL_NETWORK_POLICY = String.raw`; Full network access, plus platform services needed for TLS and network configuration.
(allow network-outbound)
(allow network-inbound)
(allow network-bind)

(allow system-socket
  (require-all
    (socket-domain AF_SYSTEM)
    (socket-protocol 2)))

(allow mach-lookup
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd"))

(allow sysctl-read
  (sysctl-name-regex #"^net.routetable"))`

function buildSeatbeltReadPolicy(roots) {
	const params = []
	const components = roots.map((root, index) => {
		const key = `READABLE_ROOT_${index}`
		params.push([key, root])
		return `(subpath (param "${key}"))`
	})
	return {
		params,
		policy: components.length === 0 ? "" : `; allow read-only file operations\n(allow file-read* file-test-existence\n${components.join("\n")}\n)`,
	}
}

function buildSeatbeltWritePolicy(roots) {
	const params = []
	const components = roots.map((root, index) => {
		const key = `WRITABLE_ROOT_${index}`
		params.push([key, root])
		return `(subpath (param "${key}"))`
	})
	return {
		params,
		policy: components.length === 0 ? "" : `(allow file-write*\n${components.join(" ")}\n)`,
	}
}

export function createSeatbeltSandboxArgs({ command, writableRoots, readableRoots = writableRoots, network = true }) {
	const writeRoots = [...new Set(writableRoots)]
	const readRoots = [...new Set([...readableRoots, ...writeRoots])]
	const read = buildSeatbeltReadPolicy(readRoots)
	const write = buildSeatbeltWritePolicy(writeRoots)
	const policy = [
		SEATBELT_BASE_POLICY,
		read.policy,
		write.policy,
		network ? SEATBELT_FULL_NETWORK_POLICY : "",
		SEATBELT_PLATFORM_DEFAULTS,
	].filter(Boolean).join("\n\n")
	return [
		"-p", policy,
		...write.params.map(([key, value]) => `-D${key}=${value}`),
		...read.params.map(([key, value]) => `-D${key}=${value}`),
		"--",
		...command,
	]
}
