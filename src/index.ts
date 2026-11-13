import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-authorization";
import type {} from "@deepseek-ai/dsh-attachment";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { attributionHeaders, LlmError } from "@deepseek-ai/dsh-llm";
import { VertexAdapter } from "./adapter.js";
import { Config, options } from "./config.js";
import { parseServiceAccount, VertexConnection } from "./vertex.js";

export { Config } from "./config.js";
export { VertexAdapter } from "./adapter.js";
export const name = "vertex-json";
export const inject = ["llm", "credentials", "authorization"];
export const RECORD_KEY = credentialKey(name, "default");
declare module "@deepseek-ai/cordis" {
  interface Events {
    "loader/volatile-update"(): void;
  }
}
const PROVIDER = "vertex-json";
const MAX_JSON_BYTES = 1024 * 1024;

/** Read only a bounded regular host-local file; errors never disclose path or content. */
async function readJsonFile(
  path: string,
  signal: AbortSignal,
): Promise<string> {
  if (!isAbsolute(path))
    throw new Error("Use an absolute path on the computer running DSH.");
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    signal.throwIfAborted();
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error();
    const bytes = Buffer.alloc(MAX_JSON_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_JSON_BYTES) throw new Error();
    signal.throwIfAborted();
    return bytes.subarray(0, bytesRead).toString("utf8");
  } catch {
    if (signal.aborted) signal.throwIfAborted();
    throw new Error(
      "Cannot read service-account JSON. Choose a readable regular file smaller than 1 MiB on the DSH host.",
    );
  } finally {
    await file?.close();
  }
}

/** Native Credentials and Models integration; no agent tool accepts credentials. */
export function apply(ctx: Context, config: Config): void {
  let cached: { signature: string; connection: VertexConnection } | undefined;
  const connection = async (): Promise<VertexConnection> => {
    const record = await ctx.credentials.readRecord(RECORD_KEY);
    if (
      record?.kind !== "grant" ||
      typeof record.payload !== "object" ||
      record.payload === null
    ) {
      throw new LlmError(
        "Import your service-account JSON in Settings > Credentials first.",
        "MISSING_CREDENTIAL",
      );
    }
    const payload = record.payload as Record<string, unknown>;
    const current = options(config);
    try {
      const serviceAccount = parseServiceAccount(
        JSON.stringify(payload.serviceAccount),
      );
      const project =
        current.project?.trim() ||
        String(payload.project ?? serviceAccount.project_id);
      const location =
        current.location?.trim() || String(payload.location ?? "global");
      const signature = JSON.stringify({ serviceAccount, project, location });
      if (cached?.signature !== signature)
        cached = {
          signature,
          connection: new VertexConnection({
            serviceAccount,
            project,
            location,
            headers: attributionHeaders(),
          }),
        };
      return cached.connection;
    } catch {
      throw new LlmError(
        "Stored Vertex credentials or project/region settings are invalid. Import the JSON again or correct settings.",
        "INVALID_CREDENTIAL",
      );
    }
  };
  const adapter = new VertexAdapter({
    connection,
    image: async (ref, signal) => {
      const attachments = ctx.get("attachments");
      if (!attachments)
        throw new LlmError(
          "Image attachments are unavailable on this DSH host.",
          "UNSUPPORTED_CONTENT",
        );
      try {
        const image = await attachments.readImageRequest(
          ref,
          { width: ref.width, height: ref.height, maxBytes: 4 * 1024 * 1024 },
          signal,
        );
        if (image.data.byteLength > 4 * 1024 * 1024)
          throw new LlmError(
            "Image exceeds the local Vertex byte limit.",
            "UNSUPPORTED_CONTENT",
          );
        return {
          data: Buffer.from(image.data).toString("base64"),
          mimeType: image.mediaType,
        };
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof LlmError) throw error;
        throw new LlmError(
          "Cannot read the normalized image attachment.",
          "UNSUPPORTED_CONTENT",
        );
      }
    },
    config: () => ({
      ...options(config),
      provider: PROVIDER,
      displayName: "Vertex AI (JSON)",
    }),
  });
  const invalidate = (): void => {
    cached = undefined;
    adapter.invalidate();
    ctx.emit("llm/models-updated", PROVIDER);
  };
  ctx.llm.registerAdapter([PROVIDER], adapter);
  const settingsNs =
    (ctx.fiber as typeof ctx.fiber & { entry?: { options: { id?: string } } })
      .entry?.options.id ?? name;
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: "Vertex AI (JSON)",
      settingsNs,
      settingsPath: [],
      declared: false,
      nativeAuth: { env: [], oauth: false },
    },
  ]);
  ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
    if (request.provider !== undefined && request.provider !== PROVIDER)
      throw new Error("Unknown Vertex provider.");
    if (request.baseURL || request.apiKey || request.api)
      throw new Error(
        "Vertex discovery uses your stored credentials and official endpoint.",
      );
    signal?.throwIfAborted();
    const models = await adapter.refreshModels(signal);
    signal?.throwIfAborted();
    ctx.emit("llm/models-updated", PROVIDER);
    return models.map(({ id, name }) => ({ id, name }));
  });
  ctx.authorization.registerFlow({
    key: RECORD_KEY,
    label: "Vertex AI (service-account JSON)",
    methods: [
      { id: "json", label: "Paste JSON securely" },
      { id: "file", label: "Import file from DSH host" },
    ],
    async run(session) {
      session.notify({
        message:
          "Credentials are stored on the computer running DSH. Import validates locally and makes no Google API request.",
      });
      const answer = await session.prompt(
        session.method === "file"
          ? {
              kind: "text",
              message:
                "Absolute JSON file path on the DSH host (not the browser computer)",
            }
          : { kind: "secret", message: "Paste the service-account JSON" },
      );
      const json =
        session.method === "file"
          ? await readJsonFile(answer.trim(), session.signal)
          : answer;
      if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES)
        throw new Error("Service-account JSON must be smaller than 1 MiB.");
      let serviceAccount;
      try {
        serviceAccount = parseServiceAccount(json);
      } catch {
        throw new Error(
          "Invalid service-account JSON. Check the account type, project, email and private key.",
        );
      }
      const project =
        (
          await session.prompt({
            kind: "text",
            message: `Project ID (blank: ${serviceAccount.project_id})`,
          })
        ).trim() || serviceAccount.project_id;
      const location =
        (
          await session.prompt({
            kind: "text",
            message: "Vertex region (blank: global)",
          })
        ).trim() || "global";
      // Constructor validates routing locally without exchanging tokens or probing Google.
      try {
        new VertexConnection({
          serviceAccount,
          project,
          location,
          headers: attributionHeaders(),
        });
      } catch {
        throw new Error("Invalid Google Cloud project ID or Vertex region.");
      }
      await session.commit({
        kind: "grant",
        payload: { serviceAccount, project, location },
      });
    },
  });
  ctx.on("credentials/record-updated", (key) => {
    if (key === RECORD_KEY) invalidate();
  });
  // Volatile values are read per request; invalidate discovery on settings changes.
  ctx.on("loader/volatile-update", invalidate);
  ctx.effect(() => () => {
    cached = undefined;
    adapter.invalidate();
  });
}
