# Contributing

Keep changes focused and explain the expected behavior and verification results in your pull request. Use synthetic credentials, prompts, and responses; never submit real keys or account data. Report vulnerabilities through [SECURITY.md](./SECURITY.md).

## Local Verification

Use Node.js 24.9 or newer and the DSH `0.2.2-rc.2` peer interfaces declared in `package.json`. From the repository root, run the same checks as CI:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

CI runs these checks on Linux and Windows with Node.js 24. Tests must remain synthetic and must not require live Google credentials or a billable model endpoint.

## Code Style and Boundaries

- Follow existing TypeScript types and compiler checks; do not bypass type safety to hide interface mismatches.
- Keep text files valid UTF-8 and follow surrounding formatting. Preserve both English and Chinese documentation when changing user-facing behavior.
- Reuse the existing `google-auth-library` and DSH host interfaces. Explain any proposed runtime dependency; this plugin is not dependency-free.
- Preserve host-scoped credential storage, official endpoint restrictions, sanitized errors, bounded attachments, and streaming/tool-call behavior. Add regression coverage when changing those paths.
- Do not include credentials in plugin options, browser state, diagnostics, fixtures, or packages. Do not add external telemetry.
