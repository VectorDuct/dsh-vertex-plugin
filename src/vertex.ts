import { createPrivateKey } from "node:crypto";
import { JWT } from "google-auth-library";

export interface ServiceAccount {
  type: "service_account";
  project_id: string;
  client_email: string;
  private_key: string;
}
export interface VertexModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}
export class VertexError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(
      (
        {
          INVALID_CREDENTIALS: "Invalid Vertex service account JSON.",
          INVALID_CONFIG: "Invalid Vertex project, location, or model.",
          AUTH: "Vertex authentication failed.",
          HTTP: "Vertex API request failed.",
          NETWORK: "Vertex network request failed.",
          TIMEOUT: "Vertex request timed out.",
          INVALID_RESPONSE: "Invalid or oversized Vertex API response.",
        } as Record<string, string>
      )[code] ?? "Vertex operation failed.",
    );
    this.name = "VertexError";
  }
}
const PROJECT = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const LOCATION = /^(?:global|[a-z]+(?:-[a-z]+)+[0-9])$/;
const MODEL = /^gemini-[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const LIMIT = 1024 * 1024;
function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseServiceAccount(json: string): ServiceAccount {
  try {
    if (json.length > 128 * 1024) throw Error();
    const value: unknown = JSON.parse(json);
    if (
      !record(value) ||
      value.type !== "service_account" ||
      !PROJECT.test(value.project_id) ||
      typeof value.client_email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(
        value.client_email,
      ) ||
      typeof value.private_key !== "string"
    )
      throw Error();
    const key = createPrivateKey(value.private_key);
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw Error();
    return {
      type: "service_account",
      project_id: value.project_id,
      client_email: value.client_email,
      private_key: value.private_key,
    };
  } catch {
    throw new VertexError("INVALID_CREDENTIALS");
  }
}
function aborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
async function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  aborted(signal);
  if (!signal) return promise;
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        listener = () => reject(signal.reason);
        signal.addEventListener("abort", listener, { once: true });
      }),
    ]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}
function safeError(error: unknown, signal?: AbortSignal): never {
  aborted(signal);
  if (error instanceof VertexError) throw error;
  throw new VertexError("NETWORK");
}
export interface VertexConnectionOptions {
  serviceAccount: ServiceAccount;
  project?: string;
  location: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  accessToken?: (signal?: AbortSignal) => Promise<string>;
}
export class VertexConnection {
  private readonly project: string;
  private readonly location: string;
  private readonly base: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetchImpl: typeof fetch;
  private readonly token: (signal?: AbortSignal) => Promise<string>;
  constructor(options: VertexConnectionOptions) {
    const account = parseServiceAccount(JSON.stringify(options.serviceAccount));
    this.project = options.project ?? account.project_id;
    this.location = options.location;
    if (!PROJECT.test(this.project) || !LOCATION.test(this.location))
      throw new VertexError("INVALID_CONFIG");
    this.base = `https://${this.location === "global" ? "" : `${this.location}-`}aiplatform.googleapis.com`;
    this.headers = Object.freeze({ ...options.headers });
    this.fetchImpl = options.fetchImpl ?? fetch;
    // Construct explicitly: never trust token_uri, universe_domain or external-account URLs from imported JSON.
    const auth = new JWT({
      email: account.client_email,
      key: account.private_key,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    let pendingToken: Promise<string> | undefined;
    this.token =
      options.accessToken ??
      (async (signal) => {
        aborted(signal);
        // Coalesce token acquisition only; each consumer keeps its own abort signal.
        // The SDK still owns token caching and expiration-based refresh.
        pendingToken ??= Promise.resolve()
          .then(async () => {
            try {
              const result = await auth.getAccessToken();
              if (!result.token) throw new VertexError("AUTH");
              return result.token;
            } catch {
              throw new VertexError("AUTH");
            }
          })
          .finally(() => {
            pendingToken = undefined;
          });
        return await abortable(pendingToken, signal);
      });
  }
  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      aborted(signal);
      const authDeadline = AbortSignal.timeout(120_000);
      let token: string;
      try {
        token = await abortable(
          this.token(signal),
          signal ? AbortSignal.any([signal, authDeadline]) : authDeadline,
        );
      } catch (error) {
        if (authDeadline.aborted && !signal?.aborted)
          throw new VertexError("TIMEOUT");
        throw error;
      }
      const headers = new Headers(this.headers);
      headers.set("authorization", `Bearer ${token}`);
      if (init.body) headers.set("content-type", "application/json");
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new VertexError("TIMEOUT")),
        120_000,
      );
      timer.unref();
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.base}${path}`, {
          ...init,
          headers,
          signal: signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal,
          redirect: "error",
        });
      } catch (error) {
        if (controller.signal.aborted) throw new VertexError("TIMEOUT");
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        const retry = response.headers.get("retry-after");
        const delay = retry
          ? /^\d+(?:\.\d+)?$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - Date.now()
          : NaN;
        await response.body?.cancel().catch(() => {});
        throw new VertexError(
          "HTTP",
          response.status,
          Number.isFinite(delay) ? Math.max(0, delay) : undefined,
        );
      }
      return response;
    } catch (error) {
      safeError(error, signal);
    }
  }
  async listModels(signal?: AbortSignal): Promise<VertexModel[]> {
    const models = new Map<string, VertexModel>();
    const seen = new Set<string>();
    let pageToken = "";
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({
        pageSize: "100",
        ...(pageToken ? { pageToken } : {}),
      });
      const response = await this.request(
        `/v1beta1/publishers/google/models?${query}`,
        {},
        signal,
      );
      let data: unknown;
      try {
        let text = "";
        for await (const chunk of chunks(response, signal)) {
          text += chunk;
          if (text.length > LIMIT) throw new VertexError("INVALID_RESPONSE");
        }
        data = JSON.parse(text);
      } catch (error) {
        safeError(
          error instanceof SyntaxError
            ? new VertexError("INVALID_RESPONSE")
            : error,
          signal,
        );
      }
      if (
        !record(data) ||
        (data.publisherModels !== undefined &&
          !Array.isArray(data.publisherModels))
      )
        throw new VertexError("INVALID_RESPONSE");
      for (const item of data.publisherModels ?? []) {
        if (!record(item) || typeof item.name !== "string") continue;
        const match =
          /^publishers\/google\/models\/(gemini-[a-zA-Z0-9._-]+)$/.exec(
            item.name,
          );
        if (
          !match ||
          !match[1] ||
          !MODEL.test(match[1]) ||
          /(?:embedding|image|vision-only|audio|live|tts|robotics|computer-use)/i.test(
            match[1],
          )
        )
          continue;
        models.set(match[1], {
          id: match[1],
          name:
            typeof item.displayName === "string" ? item.displayName : match[1],
        });
      }
      if (!data.nextPageToken) return [...models.values()];
      if (
        typeof data.nextPageToken !== "string" ||
        data.nextPageToken.length > 4096 ||
        seen.has(data.nextPageToken)
      )
        throw new VertexError("INVALID_RESPONSE");
      pageToken = data.nextPageToken;
      seen.add(pageToken);
    }
    throw new VertexError("INVALID_RESPONSE");
  }
  async *stream(
    model: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncIterable<Record<string, any>> {
    if (!MODEL.test(model)) throw new VertexError("INVALID_CONFIG");
    const response = await this.request(
      `/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${model}:streamGenerateContent?alt=sse`,
      { method: "POST", body: JSON.stringify(body) },
      signal,
    );
    let pending = "",
      lines: string[] = [],
      size = 0;
    const event = (): Record<string, any> | undefined => {
      const data = lines.join("\n");
      lines = [];
      size = 0;
      if (!data || data === "[DONE]") return;
      try {
        const value: unknown = JSON.parse(data);
        if (!record(value)) throw Error();
        if (value.error) throw new VertexError("INVALID_RESPONSE");
        return value;
      } catch {
        throw new VertexError("INVALID_RESPONSE");
      }
    };
    const line = (value: string): Record<string, any> | undefined => {
      size += value.length;
      if (size > LIMIT) throw new VertexError("INVALID_RESPONSE");
      if (!value) return event();
      if (value.startsWith("data:"))
        lines.push(value.slice(5).replace(/^ /, ""));
    };
    try {
      for await (const chunk of chunks(response, signal)) {
        pending += chunk;
        let index: number;
        while ((index = pending.indexOf("\n")) !== -1) {
          const value = pending.slice(0, index).replace(/\r$/, "");
          pending = pending.slice(index + 1);
          const parsed = line(value);
          if (parsed) yield parsed;
        }
        if (pending.length + size > LIMIT)
          throw new VertexError("INVALID_RESPONSE");
      }
      if (pending) {
        const parsed = line(pending.replace(/\r$/, ""));
        if (parsed) yield parsed;
      }
      const parsed = event();
      if (parsed) yield parsed;
    } catch (error) {
      safeError(error, signal);
    }
  }
}
async function* chunks(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!response.body) throw new VertexError("INVALID_RESPONSE");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const idle = AbortSignal.timeout(120_000);
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await abortable(
          reader.read(),
          signal ? AbortSignal.any([signal, idle]) : idle,
        );
      } catch (error) {
        if (idle.aborted && !signal?.aborted) throw new VertexError("TIMEOUT");
        throw error;
      }
      if (result.done) break;
      yield decoder.decode(result.value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
