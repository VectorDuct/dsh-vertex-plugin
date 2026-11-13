# Vertex AI (JSON)

Use your own Google Cloud service account for Gemini conversations in DSH.

Supports model discovery, streamed replies, thinking summaries, images and tool calls. Each user supplies their own project and credential.

1. Import the JSON in **Settings → Credentials → Vertex AI**.
2. Open this plugin’s **vertex-json** component to set the project, region and generation options, then refresh the model catalog.
3. Select **Vertex AI (JSON)** in your conversation’s model picker.

Credentials stay on the computer running DSH. Model discovery does not verify generation permission; actual prompts use your Google Cloud billing. This plugin is independent software and does not guarantee account or model access.

Requires DSH **0.2.2-rc.2**. Supports Gemini text/tool models and image input; other publishers and image/audio generation are outside this version.
