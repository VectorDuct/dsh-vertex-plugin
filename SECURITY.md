# Security Policy

## Supported Versions

| Version | Security fixes |
| --- | --- |
| 0.1.x | Supported; use the latest available patch |
| Other versions | Not supported |

## Reporting a Vulnerability

Report suspected vulnerabilities privately to [contact@vectorduct.com](mailto:contact@vectorduct.com) or [founders@vectorduct.com](mailto:founders@vectorduct.com). Do not open a public GitHub issue with vulnerability details or exploit instructions before coordinated disclosure.

We aim to acknowledge reports within 48 hours. This is an acknowledgment target, not a guaranteed resolution time. Include the affected version, host/runtime versions, expected and observed behavior, and a minimal synthetic reproduction. Never send live service-account keys, access tokens, private prompts, or customer data. Coordinate publication with the maintainers after assessment and remediation.

## Security Boundary

- Each deployment uses its own Google Cloud project and IAM service account. Model requests go to official Vertex AI endpoints; authentication uses Google's OAuth service through `google-auth-library`.
- Service-account records may persist in DSH's host credential manager. They must not be stored in ordinary plugin configuration or exposed to remote browser clients. The plugin does not provide a shared credential pool.
- Imported custom token endpoint overrides are removed. Diagnostics omit raw upstream response bodies, bearer tokens, and prompt content.
- The plugin has no external telemetry beacon. Required Google authentication, model discovery, and inference requests are functional network traffic.
- Operators remain responsible for host security, IAM permissions, key rotation, Google Cloud billing, and the data sent to the selected model. Protocol validation is not a guarantee of model-output safety.
