# DSH Vertex JSON

A native Vertex AI provider for DeepSeek Harness. Each user supplies their own Google Cloud project and service-account JSON. Requests go directly to Google's official OAuth and Vertex endpoints. This plugin does not run a proxy API, share credentials, or impersonate SillyTavern.

## Compatibility and scope

- Target: **DSH 0.2.2-rc.2**, Node **24.9+**, Linux and Windows. DSH interfaces are pre-stable; other versions are not claimed compatible.
- Gemini chat, text streaming, thinking summaries, tool calls/results and thought-signature replay; normalized image input through DSH's attachment service.
- Google publisher model discovery with pagination and manual Gemini IDs. A listed model is **not verified permission to call it**. Project billing, enabled APIs, IAM, model availability and region still apply.
- Third-party Model Garden publishers, self-deployed endpoints, image/audio/video generation, embeddings, Live API, arbitrary base URLs and Express API keys are outside this version.
- No default safety overrides, account rotation, automatic fallback to another model/project, or generation probes.

## Install

Install DSH and pnpm following DSH's official instructions. Choose the same DSH version on both computers. You do not need a full DSH source build to install the plugin.

The packed distribution contains compiled JavaScript and the browser module. Copy `dsh-vertex-json-0.1.0.tgz` to the target computer, then install through **Plugins → Add plugin → local package**, or from a terminal:

```sh
dsh plugin --profile web add /absolute/path/dsh-vertex-json-0.1.0.tgz
dsh web --no-open
```

Windows PowerShell:

```powershell
dsh plugin --profile web add "C:\Users\YourName\Downloads\dsh-vertex-json-0.1.0.tgz"
dsh web --no-open
```

Restart DSH when replacing an already-loaded package. Package installation alone does not verify generation.

For a source checkout, run `npm ci` and `npm run build`, then `npm pack`. Install the resulting archive rather than linking a checkout with its development dependencies. Native DSH peer dependencies must match the host version.

## Connect

1. Open **Settings → Credentials**, locate **Vertex AI (service-account JSON)** and authorize it. This native DSH flow offers masked JSON paste or a JSON file path on the **DSH host**. Do not paste a private key into an agent conversation.
2. Enter the project and region. Blank values use the JSON's project and `global`. JSON validation is local; saving does not contact Google and does not prove the credential works.
3. Open **Plugins → Installed plugins → Vertex AI (JSON)**, then its `vertex-json` configuration row. Adjust project/region overrides, sampling, output limits or thinking settings. Leave values blank to inherit defaults. Use **Refresh model catalog** for discovery without generation.
4. Select **Vertex AI (JSON)** and a Gemini model in DSH's model picker. An actual prompt invokes billable inference. Discovery badges remain conservative and do not claim generation has been tested.
5. To use an unlisted supported model, add its ID (for example, the exact ID published for your project/region) under Additional Gemini model IDs, save, and refresh. An authentication or catalog error remains an error; manual IDs do not conceal a failed refresh.

Thinking levels are restricted to the published capabilities of known models and map to `thinkingLevel` for newer Gemini models or token budgets for Gemini 2.5. Unknown model families keep provider defaults and do not advertise guessed thinking controls. Numeric thinking budgets are only offered for Gemini 2.5. Earlier non-thinking models do not advertise thinking controls. Explicit token budgets and levels are alternative controls; level selection takes priority. Do not request thought summaries with a zero budget. Keep defaults when uncertain rather than disabling safety or guessing a capacity.

Per-model `contextWindow` and `maxTokens` may be set in the native advanced configuration schema under `models`. The compact form preserves those fields when editing model IDs. Capacity is not invented from a model name. Confirm capacities against Google's model documentation before overriding.

Images are normalized/read through DSH rather than opening arbitrary paths. Limits are 4 MiB per encoded image before base64 and 16 MiB total base64 image payload per request. Unknown/unsupported attachment providers and media types fail explicitly. Output is text, thinking or tool calls; generated image/audio output is not supported.

## Security and credential ownership

- Import supports only `type: service_account` with a valid RSA private key. Imported token endpoints and other credential redirection fields are discarded. Official authentication uses `google-auth-library`, with short-lived tokens and coalesced refresh.
- JSON is stored as a **native DSH credential record**, never plugin configuration. DSH's default local credential store is not advertised as encrypted; protect the DSH host account, storage and backups. Same-user arbitrary code can potentially access same-user credentials. Keeping credentials outside the agent workspace is useful but not a security boundary.
- In remote Web mode, credentials are stored on the **DSH host**, not on the browser computer. Use a loopback listener with SSH forwarding or an appropriately authenticated private entry. Do not publish an unauthenticated DSH server.
- Removing the credential through DSH forgets it locally; it does not revoke the service-account key at Google. Uninstalling a plugin may leave its native credential record; remove it separately. Revoke compromised keys through Google Cloud IAM.
- Errors omit upstream response bodies, JSON, tokens and prompts. Google status codes and retry delays are preserved. DSH's own history/tool logging and operating-system protections remain separate responsibilities.
- OAuth as a protocol is not prohibited: service accounts use official OAuth tokens. This plugin does not reuse consumer Antigravity/Gemini CLI subscription logins or private product backends.
- This is independent software, without Google approval or an account-suspension guarantee. Applicable Google Cloud terms, content rules, region, billing and IAM requirements still apply.

## Development and verification

```sh
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Tests use temporary generated RSA keys, mocked token/HTTP responses and real DSH Cordis/Authorization/LLM classes. No real private keys or cloud generations are required. The workflow in `.github/workflows/test.yml` defines Linux and Windows checks; a checked-in workflow is not evidence that Windows has run.

See [verification](docs/verification.md) for commands actually run and limitations. No live Google authentication or model generation has been performed during initial development.

## Uninstall

Remove the Vertex credential in Settings → Credentials if you no longer need it, then remove the plugin through Plugins or run:

```sh
dsh plugin --profile web remove dsh-vertex-json
```

Remove it from each profile where it was installed. No cleanup command removes Google resources or unrelated DSH plugins.

## License

MIT. Implemented independently against public Google APIs and DSH's extension contracts; no Luker/SillyTavern AGPL implementation code is bundled. The connection workflow is inspired by their Vertex Full mode.
