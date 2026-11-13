# Delivery verification

This source copy excludes deployment state, credentials, internal review notes and host-specific development paths. Runtime source and tests retain the original plugin implementation.

Compatibility target: DSH 0.2.2-rc.2 and Node 24.9+. The included workflow is configuration, not a claim of a hosted Windows/Linux CI result.

The delivery preparation runs typecheck, offline tests and a build using existing local dependencies, then creates a plugin package. Tests generate temporary synthetic RSA keys and mock external authentication/HTTP calls. No live Google credentials, authentication or model generation are used. Actual credential permissions, billing and model access remain unverified.

On 2026-11-13, Node 24.22.3 typecheck, all 36 offline tests, compilation and package creation passed for this delivery copy. The dependency lockfile contains no local file/link dependencies. No cloud authentication or generation was performed.
