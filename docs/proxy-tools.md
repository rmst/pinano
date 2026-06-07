# Proxy Tools

Pinano can provide selected command-line tools inside a tool environment as proxy executables. A proxy executable runs in the worker environment, sends an internal request through that worker's authenticated bridge, and lets the owning Pinano service decide what host-side action is allowed.

This is an internal mechanism, not a stable plugin API. Route names, generated wrapper details, and request shapes may change while the design settles.

## Boundary

Proxy tools keep the sandbox boundary in the service, where Pinano has trusted session and environment context. The sandboxed program supplies ordinary process facts such as argv and cwd, but it does not get to declare its own permissions. The service uses the worker context already associated with the tool worker to interpret paths, environment identity, and sandbox policy.

The proxy executable is only a transport shim. It should not decide whether a request is safe. Host-side policy belongs in the service handler for that proxy tool.

## Current Docker Proxy

The current built-in proxy tool is `docker`. It is available in normal tool subprocess environments when the worker internal bridge is available.

The Docker proxy is deliberately not a passthrough to host Docker. It accepts a small command surface and rejects unknown Docker commands and unknown Docker options before invoking the host Docker CLI. Supported command families currently include container creation, listing, logs, stop, remove, inspect, and exec.

For `docker run`, the proxy parses Docker options first, rewrites allowed bind mounts from worker-visible paths to host paths, injects `--rm` and Pinano ownership labels, and then passes the image name and container command tail through as data. Bind mounts must map through the worker's effective writable or read-only mounts; read-only sandbox paths cannot become writable Docker binds. Detached `docker run` containers and detached `docker exec` processes are unavailable by default.

For commands that target existing containers, the proxy verifies container ownership before running the requested command. Ownership is label-based: containers must be marked as Pinano Docker proxy containers for the current session, and for the current environment when that context is available. Listing commands add matching ownership filters. User-supplied filters are rejected where filter composition could widen the result.

The Docker proxy is intended for narrow sandbox-compatible workflows. It should grow by adding explicit command and option handling, not by adding raw passthrough.

## Non-Goals

Proxy tools do not replace the worker JSON-RPC transport. They are a way for programs running inside the worker environment to ask the service for tightly scoped actions.

Proxy tools do not expose general host access. A proxy handler must enforce the selected environment's sandbox policy and should treat every proxy request as untrusted input.

Proxy tools are not yet configurable addon packages. The current implementation establishes the shape for built-in proxies; future addon support should preserve the same split between a small in-environment executable and a service-side policy handler.
