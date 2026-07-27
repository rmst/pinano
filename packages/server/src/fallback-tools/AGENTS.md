# Fallback tool guidelines

Fallback tools are small compatibility subsets, not full reimplementations. Prefer common, safe behavior over broad approximate compatibility.

When adding or changing a fallback:

- Print an honest `--version` that identifies the Cerex fallback.
- Reject unsupported options/features clearly; reject before network I/O or other side effects when practical.
- Do not silently approximate semantics that scripts may depend on.
- Use capability detection for runtime-dependent behavior instead of runtime-name checks.
- Add self-contained tests for supported behavior and unsupported-feature failures.
