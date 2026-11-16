# Changelog

Notable changes are documented using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories. Release dates reflect publication of the corresponding version.

## [Unreleased]

## [0.1.0] - 2026-11-16

### Added

- Private vulnerability disclosure policy and contributor verification guide.
- EditorConfig settings for UTF-8, LF line endings, final newlines, and language-specific indentation.
- Direct Cloud Bridge: native Google Cloud Vertex AI service-account authentication and model access for DeepSeek Harness.
- Gemini multi-turn chat, SSE text streaming, thinking summaries, tool calls/results, and thought-signature replay.
- Paginated publisher model discovery, pinned model IDs, regional endpoint overrides, and model-specific reasoning controls.
- Image attachments normalized through DSH's attachment service, with a 4 MiB pre-Base64 limit per image and 16 MiB total Base64 payload per request.
- English and Chinese documentation, Linux/Windows verification, and npm package metadata.
- Runtime requirements: Node.js 24.9+ and DSH 0.2.2-rc.2; uses `google-auth-library` and the declared DSH peer interfaces.

- Compiled npm release package, SHA-256 checksum, and packaged governance documentation.

### Security

- Deployment-owned Google Cloud project and IAM service-account credentials; no shared credential pool or third-party inference relay.
- Host-scoped credential storage through DSH rather than ordinary plugin configuration or remote browser state.
- Official OAuth authentication with short-lived access tokens and removal of imported custom token endpoint overrides.
- Sanitized diagnostics exclude raw upstream response bodies, bearer tokens, and prompt content; no external telemetry beacon.
