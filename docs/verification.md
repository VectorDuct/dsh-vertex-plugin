# Development verification

Target runtime: DSH 0.2.2-rc.2 and Node.js 24.9+.

Run from the repository root:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The automated suite covers configuration, model discovery, protocol conversion, attachments, streaming, service-account validation, token refresh and sanitized errors. Tests use synthetic RSA keys and mocked authentication/HTTP responses. The repository workflow runs on Linux and Windows.
