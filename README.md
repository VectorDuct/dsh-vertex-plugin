# DSH Vertex AI Plugin (`dsh-vertex-plugin`)

**[简体中文](./README.zh-CN.md)**

> **VectorDuct Primitive: Direct Cloud Bridge** ([vectorduct.com](https://vectorduct.com/#stack))

A native Google Cloud Vertex AI provider plugin for DeepSeek Harness (DSH). Enables direct, tenant-isolated model inference against official Google Cloud Vertex AI endpoints using standard IAM service-account credentials (`BYOC`).

## Capabilities & Scope

- **Target Runtime**: Engineered for `DSH 0.2.2-rc.2` on `Node.js 24.9+` (Linux and Windows).
- **Gemini Protocol Support**: Supports multi-turn chat, Server-Sent Events (SSE) text streaming, thinking summaries, tool calls and results, thought-signature replay, and normalized image attachments through DSH's attachment service.
- **Model Catalog Discovery**: Paginated publisher model discovery with support for custom/pinned Gemini model IDs and regional endpoint overrides (`global`, `us-central1`, etc.).
- **Reasoning & Thinking Controls**: Maps model-specific reasoning parameters to `thinkingLevel` or explicit token budgets for supported Gemini 2.5+ series models.
- **Direct BYOC Architecture**: Each deployment uses its own Google Cloud project and IAM service-account JSON key. Requests route directly to Google's official OAuth 2.0 and Vertex AI endpoints without intermediate proxy relays or shared credential pools.

## Installation

Install DSH (`0.2.2-rc.2`) and `pnpm` following DSH's documentation.

### Install from Packaged Archive (`.tgz`)

Install via the DSH web interface (**Plugins → Add plugin → local package**) or via CLI:

```bash
dsh plugin --profile web add /absolute/path/dsh-vertex-json-0.1.0.tgz
dsh web --no-open
```

Windows PowerShell:

```powershell
dsh plugin --profile web add "C:\path\to\dsh-vertex-json-0.1.0.tgz"
dsh web --no-open
```

### Build from Source

```bash
npm ci
npm run build
npm pack
```

## Configuration & Usage

1. **Authorize Service-Account Credentials**:

    Open **Settings → Credentials** in DSH, select **Vertex AI (service-account JSON)**, and provide your Google Cloud IAM Service Account JSON key (via masked input or local host path) along with your GCP Project ID and region (defaults to the JSON's project ID and `global`).

2. **Configure Plugin Options**:

    Navigate to **Plugins → Installed plugins → Vertex AI (JSON)** to adjust optional project/region overrides, sampling parameters, output token ceilings, or thinking budgets. Click **Refresh model catalog** to discover available Gemini models.

3. **Run Inference**:

    Select **Vertex AI (JSON)** and a Gemini model in DSH's model selector. Ensure the Vertex AI API (`aiplatform.googleapis.com`) is enabled on your Google Cloud project with active billing and appropriate IAM permissions (`roles/aiplatform.user`).

### Multimodal Attachment Bounds
Images are normalized through DSH's attachment service with a limit of `4 MiB` per encoded image (pre-Base64) and `16 MiB` total Base64 image payload per request.

## Security & Credential Isolation

- **Official Google OAuth 2.0**: Authenticates strictly via `google-auth-library` using `type: service_account` RSA keys to mint short-lived access tokens with coalesced refresh. Custom token endpoint overrides inside imported JSON files are stripped.
- **Host-Scoped Credential Storage**: Service-account JSON records are stored in DSH's native host credential manager and are never written to plugin configuration files or exposed to browser clients in remote Web mode.
- **Sanitized Diagnostics**: Error outputs preserve upstream HTTP status codes and retry delays while omitting raw response bodies, bearer tokens, and prompt contents.

## Development & Testing

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## Uninstall

Remove the stored Vertex credential in **Settings → Credentials**, then uninstall the plugin:

```bash
dsh plugin --profile web remove dsh-vertex-json
```

## License

MIT License. Maintained by [VectorDuct](https://vectorduct.com).
