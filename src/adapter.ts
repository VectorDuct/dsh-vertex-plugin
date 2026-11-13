import { randomUUID } from "node:crypto";
import {
  LlmAdapter,
  LlmError,
  offloadedImageText,
  ReasoningEffortId,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReplayEnvelope,
  RequestMessage,
  StreamChunk,
  TokenUsage,
  BuiltinLlmFailureCode,
} from "@deepseek-ai/dsh-llm";
type ImageAttachmentRef = Extract<
  ContentBlock,
  { type: "image" }
>["attachment"];
import { VertexError } from "./vertex.js";
import type { VertexConnection } from "./vertex.js";

export interface VertexAdapterConfig {
  provider?: string;
  displayName?: string;
  models?: Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
  }>;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  thinkingBudget?: number;
  thinkingLevel?: string;
  includeThoughts?: boolean;
}
type Transport = Pick<VertexConnection, "listModels" | "stream">;
interface AdapterOptions {
  connection: () => Promise<Transport>;
  config: () => VertexAdapterConfig;
  image?: (
    ref: ImageAttachmentRef,
    signal?: AbortSignal,
  ) => Promise<{ data: string; mimeType: string }>;
}
type Part = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  inlineData?: { mimeType: string; data: string };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
    id?: string;
  };
};
type NativeContent = { role: "user" | "model"; parts: Part[] };
interface ReplayBlock {
  parts: Part[];
}
interface Segment {
  index: number;
  block: ContentBlock;
  parts: Part[];
}
const isRecord = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function fail(
  message: string,
  code: BuiltinLlmFailureCode = "MALFORMED_RESPONSE",
): never {
  throw new LlmError(message, code);
}
const legacyThinking = (id: string) => /^gemini-(?:1[.-]|2(?:\.0)?-)/.test(id);
const budgetThinking = (id: string) => /^gemini-2\.5(?:-|$)/.test(id);
// Source: Google Cloud Vertex thinking reference, checked 2026-11-12.
// Unknown model families keep provider defaults instead of invented capabilities.
function thinkingLevels(id: string): readonly string[] {
  if (budgetThinking(id)) return ["minimal", "low", "medium", "high"];
  if (/^gemini-3(?:\.0)?-pro(?:-|$)/.test(id)) return ["low", "high"];
  if (/^gemini-(?:3\.1-pro|3\.[78]-flash|4[.-])/.test(id))
    return ["low", "medium", "high"];
  if (/^gemini-3(?:\.[1356])?-(?:flash|flash-lite)(?:-|$)/.test(id))
    return ["minimal", "low", "medium", "high"];
  return [];
}
const supported = (id: string) =>
  /^gemini-[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(id) &&
  !/(?:embedding|image|audio|live|tts|robotics|computer-use)/i.test(id);
const validNumber = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
function args(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw Error();
    return parsed;
  } catch {
    return fail("Invalid JSON tool arguments.", "INVALID_REQUEST");
  }
}
function safeFailure(error: unknown, signal?: AbortSignal): never {
  signal?.throwIfAborted();
  if (error instanceof LlmError) throw error;
  if (error instanceof VertexError) {
    const status = error.status;
    const code =
      error.code === "AUTH"
        ? "MISSING_CREDENTIAL"
        : error.code === "TIMEOUT"
          ? "TIMEOUT"
          : status === 401
            ? "MISSING_CREDENTIAL"
            : status === 403
              ? "HTTP_403"
              : status === 429
                ? "RATE_LIMIT"
                : status && status >= 400 && status < 500
                  ? "INVALID_REQUEST"
                  : error.code === "INVALID_RESPONSE"
                    ? "MALFORMED_RESPONSE"
                    : error.code === "INVALID_CONFIG"
                      ? "INVALID_REQUEST"
                      : "TRANSPORT";
    throw new LlmError(error.message, code, {
      ...(status === undefined ? {} : { status }),
      ...(error.retryAfterMs && error.retryAfterMs > 0
        ? { providerRetryAfterMs: error.retryAfterMs }
        : {}),
    });
  }
  throw new LlmError(
    "Vertex request failed. Check credentials, region and connection.",
    "TRANSPORT",
  );
}
/** Only allow known native metadata back onto the wire, bound to durable block content. */
function replay(
  message: RequestMessage,
  model: string,
  provider: string,
): Part[] | undefined {
  if (
    message.role !== "assistant" ||
    message.source.provider !== provider ||
    message.source.model !== model
  )
    return;
  const raw = message.source.replayState;
  if (raw === undefined) return;
  if (
    !isRecord(raw) ||
    !isRecord(raw.response) ||
    raw.response.kind !== "vertex-json"
  )
    return;
  const reject = (): never =>
    fail(
      "Vertex assistant replay no longer matches its recorded content.",
      "INVALID_REPLAY_STATE",
    );
  if (
    raw.response.version !== 1 ||
    raw.response.model !== model ||
    raw.response.provider !== provider ||
    !Array.isArray(raw.blocks) ||
    raw.blocks.length !== message.content.length
  )
    reject();
  const result: Part[] = [];
  for (let i = 0; i < message.content.length; i++) {
    const block = message.content[i]!;
    const entry = raw.blocks[i];
    if (
      !isRecord(entry) ||
      !Array.isArray(entry.parts) ||
      entry.parts.length > 100000
    )
      reject();
    const parts: Part[] = [];
    for (const part of entry.parts) {
      if (!isRecord(part)) reject();
      const keys = Object.keys(part);
      if (
        keys.some(
          (k) =>
            !["text", "thought", "thoughtSignature", "functionCall"].includes(
              k,
            ),
        )
      )
        reject();
      if (
        part.thoughtSignature !== undefined &&
        (typeof part.thoughtSignature !== "string" ||
          part.thoughtSignature.length > 1024 * 1024)
      )
        reject();
      if (block.type === "text" || block.type === "reasoning") {
        if (
          typeof part.text !== "string" ||
          Boolean(part.thought) !== (block.type === "reasoning") ||
          part.functionCall !== undefined
        )
          reject();
        parts.push({
          text: part.text,
          ...(block.type === "reasoning" ? { thought: true } : {}),
          ...(part.thoughtSignature
            ? { thoughtSignature: part.thoughtSignature }
            : {}),
        });
      } else if (block.type === "tool-call") {
        const call = part.functionCall;
        if (
          !isRecord(call) ||
          call.name !== block.name ||
          !isRecord(call.args) ||
          part.text !== undefined ||
          part.thought !== undefined ||
          Object.keys(call).some((k) => !["name", "args", "id"].includes(k)) ||
          (call.id !== undefined && typeof call.id !== "string")
        )
          reject();
        if (JSON.stringify(call.args) !== JSON.stringify(args(block.arguments)))
          reject();
        parts.push({
          functionCall: {
            name: call.name,
            args: call.args,
            ...(call.id ? { id: call.id } : {}),
          },
          ...(part.thoughtSignature
            ? { thoughtSignature: part.thoughtSignature }
            : {}),
        });
      } else reject();
    }
    if (
      (block.type === "text" || block.type === "reasoning") &&
      parts.map((p) => p.text ?? "").join("") !== block.text
    )
      reject();
    if (block.type === "tool-call" && parts.length !== 1) reject();
    result.push(...parts);
  }
  return result;
}
/** Translate history without rewriting frozen DSH inputs or inventing thought signatures. */
export async function buildRequest(
  options: GenerateOptions,
  config: VertexAdapterConfig,
  image?: AdapterOptions["image"],
): Promise<Record<string, unknown>> {
  const contents: NativeContent[] = [];
  const system: string[] = [];
  if (options.system) system.push(options.system);
  let imageBytes = 0;
  const calls = new Map<string, { name: string; nativeId?: string }>();
  for (const message of options.messages) {
    options.signal?.throwIfAborted();
    if (message.role === "system") {
      if (contents.length)
        fail(
          "A later system message requires DSH prompt consolidation.",
          "UNSUPPORTED_CONTENT",
        );
      for (const block of message.content) {
        if (block.type !== "text")
          fail("Unsupported system content.", "UNSUPPORTED_CONTENT");
        system.push(block.text);
      }
      continue;
    }
    const native = replay(message, options.model, options.provider);
    if (message.role === "assistant") {
      let index = 0;
      for (const block of message.content)
        if (block.type === "tool-call") {
          const part = native?.filter((p) => p.functionCall)[index++];
          calls.set(block.id, {
            name: block.name,
            ...(part?.functionCall?.id
              ? { nativeId: part.functionCall.id }
              : {}),
          });
        }
    }
    let parts: Part[] = [];
    if (native) parts = native;
    else
      for (const block of message.content) {
        if (block.type === "text") {
          if (block.text) parts.push({ text: block.text });
        } else if (block.type === "reasoning") {
          /* Unsigned reasoning from another provider/model is not replayed. */
        } else if (block.type === "tool-call" && message.role === "assistant")
          parts.push({
            functionCall: { name: block.name, args: args(block.arguments) },
          });
        else if (
          block.type === "image" &&
          (message.role === "user" || message.role === "tool")
        ) {
          if (block.offloaded) {
            parts.push({
              text: offloadedImageText(block.attachment, undefined),
            });
            continue;
          }
          if (!image)
            fail(
              "Image attachments are unavailable on this DSH host.",
              "UNSUPPORTED_CONTENT",
            );
          const data = await image(block.attachment, options.signal);
          if (!/^image\/(?:png|jpeg|webp|gif)$/.test(data.mimeType))
            fail("Unsupported image type.", "UNSUPPORTED_CONTENT");
          imageBytes += data.data.length;
          if (
            data.data.length > 6 * 1024 * 1024 ||
            imageBytes > 16 * 1024 * 1024
          )
            fail(
              "Vertex image request exceeds the local byte limit.",
              "UNSUPPORTED_CONTENT",
            );
          parts.push(
            {
              text: `Image ${block.attachment.attachmentId} (${block.attachment.width}x${block.attachment.height})`,
            },
            { inlineData: data },
          );
        } else if (
          (block.type === "tool-addition" || block.type === "tool-removal") &&
          message.role === "developer"
        ) {
          /* Current complete tools arrive in options.tools. */
        } else
          fail("Unsupported Vertex message content.", "UNSUPPORTED_CONTENT");
      }
    if (message.role === "tool") {
      const call = calls.get(message.toolCallId);
      if (!call)
        fail(
          "Tool response has no matching assistant call.",
          "INVALID_REQUEST",
        );
      const output = parts
        .filter((p) => p.text !== undefined)
        .map((p) => p.text)
        .join("");
      const images = parts.filter((p) => p.inlineData);
      parts = [
        {
          functionResponse: {
            name: call.name,
            ...(call.nativeId ? { id: call.nativeId } : {}),
            response: message.isError ? { error: output } : { output },
          },
        },
        ...images,
      ];
    }
    if (!parts.length) continue;
    const role = message.role === "assistant" ? "model" : "user";
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  if (!contents.length)
    fail("A Vertex request needs conversation content.", "INVALID_REQUEST");
  const generationConfig: Record<string, unknown> = { candidateCount: 1 };
  const max =
    options.maxTokens ??
    config.maxOutputTokens ??
    config.models?.find((m) => m.id === options.model)?.maxTokens;
  if (max !== undefined) generationConfig.maxOutputTokens = max;
  const temperature = options.temperature ?? config.temperature;
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (config.topP !== undefined) generationConfig.topP = config.topP;
  if (options.stop?.length) generationConfig.stopSequences = [...options.stop];
  const thinking: Record<string, unknown> = {};
  const effort =
    options.reasoningEffort === undefined
      ? config.thinkingLevel
      : String(options.reasoningEffort);
  if (effort !== undefined) {
    const level = effort.toLowerCase();
    if (!thinkingLevels(options.model).includes(level))
      fail(
        "Unsupported Vertex thinking level for this model.",
        "UNSUPPORTED_REASONING_EFFORT",
      );
    if (budgetThinking(options.model)) {
      const cap = max ?? 32768,
        pro = options.model.includes("-pro");
      const ratio = level === "low" ? 0.15 : level === "medium" ? 0.25 : 0.5;
      thinking.thinkingBudget =
        level === "minimal"
          ? pro
            ? 128
            : 0
          : Math.min(
              pro ? 32768 : 24576,
              Math.max(pro ? 128 : 512, Math.floor(cap * ratio)),
            );
    } else thinking.thinkingLevel = level.toUpperCase();
  } else if (config.thinkingBudget !== undefined) {
    if (!budgetThinking(options.model))
      fail(
        "Numeric thinking budgets are supported only for Gemini 2.5.",
        "UNSUPPORTED_OPTION",
      );
    thinking.thinkingBudget = config.thinkingBudget;
  }
  if (config.includeThoughts !== undefined)
    thinking.includeThoughts = config.includeThoughts;
  if (legacyThinking(options.model) && Object.keys(thinking).length)
    fail(
      "Thinking settings are unavailable for this model.",
      "UNSUPPORTED_OPTION",
    );
  if (thinking.thinkingBudget === 0 && thinking.includeThoughts === true)
    fail(
      "Include thoughts requires a nonzero thinking budget.",
      "UNSUPPORTED_OPTION",
    );
  if (Object.keys(thinking).length) generationConfig.thinkingConfig = thinking;
  const tools = options.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.parameters,
  }));
  return {
    contents,
    generationConfig,
    ...(system.length
      ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } }
      : {}),
    ...(tools?.length ? { tools: [{ functionDeclarations: tools }] } : {}),
  };
}

export class VertexAdapter extends LlmAdapter {
  private generation = 0;
  private cached?: {
    connection: Transport;
    signature: string;
    at: number;
    models: readonly LlmModelInfo[];
  };
  constructor(private readonly options: AdapterOptions) {
    super();
  }
  override providerInfo(provider: string) {
    return {
      id: provider,
      name: this.options.config().displayName ?? "Vertex AI (JSON)",
    };
  }
  invalidate(): void {
    this.generation++;
    this.cached = undefined;
  }
  private async discover(
    signal?: AbortSignal,
  ): Promise<readonly LlmModelInfo[]> {
    const generation = this.generation;
    const config = structuredClone(this.options.config());
    const provider = config.provider ?? "vertex-json";
    const connection = await this.options.connection();
    signal?.throwIfAborted();
    const signature = JSON.stringify(config.models ?? []);
    if (
      this.cached?.connection === connection &&
      this.cached.signature === signature &&
      Date.now() - this.cached.at < 300000
    )
      return this.cached.models;
    let discovered;
    try {
      discovered = await connection.listModels(signal);
    } catch (e) {
      safeFailure(e, signal);
    }
    const combined = new Map(
      discovered.map((m) => [m.id, { id: m.id, name: m.name }]),
    );
    for (const model of config.models ?? []) {
      if (!supported(model.id))
        fail("Manual model is outside this Gemini adapter.", "INVALID_REQUEST");
      combined.set(model.id, { id: model.id, name: model.name ?? model.id });
    }
    const models = [...combined.values()].map((m) => ({
      ...m,
      provider,
      inputModalities: this.options.image
        ? (["text", "image"] as const)
        : (["text"] as const),
      badge: {
        text: { en: "Unverified", zh: "未验证调用权限" },
        tone: "warning" as const,
      },
    }));
    // A credential update during I/O cannot install stale catalog state.
    if (
      generation === this.generation &&
      (await this.options.connection()) === connection
    )
      this.cached = { connection, signature, at: Date.now(), models };
    return models;
  }
  async refreshModels(signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    this.invalidate();
    return this.discover(signal);
  }
  override async listModels(
    _provider: string,
  ): Promise<readonly LlmModelInfo[]> {
    try {
      return await this.discover();
    } catch (error) {
      if (error instanceof LlmError && error.code === "MISSING_CREDENTIAL")
        return [];
      throw error;
    }
  }
  private modelInfo(
    provider: string,
    model: string,
    config: VertexAdapterConfig,
  ): LlmResolvedModelInfo {
    if (!supported(model))
      fail(
        "Only Gemini text/tool models are supported by this adapter.",
        "INVALID_REQUEST",
      );
    const manual = config.models?.find((m) => m.id === model);
    return {
      provider,
      id: model,
      name: manual?.name ?? model,
      inputModalities: this.options.image ? ["text", "image"] : ["text"],
      ...(manual?.contextWindow
        ? { context: { contextWindow: manual.contextWindow } }
        : {}),
      ...(manual?.maxTokens || config.maxOutputTokens
        ? { defaultMaxTokens: manual?.maxTokens ?? config.maxOutputTokens }
        : {}),
      ...(!thinkingLevels(model).length
        ? {}
        : {
            reasoning: {
              efforts: thinkingLevels(model).map((id) => ({
                id: ReasoningEffortId(id),
                name: id[0]!.toUpperCase() + id.slice(1),
              })),
            },
          }),
    };
  }
  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    return this.modelInfo(
      provider,
      model,
      structuredClone(this.options.config()),
    );
  }
  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted();
    const config = structuredClone(this.options.config());
    let connection: Transport;
    try {
      connection = await this.options.connection();
    } catch (e) {
      safeFailure(e, signal);
    }
    signal?.throwIfAborted();
    return {
      model: this.modelInfo(provider, model, config),
      stream: (options) => this.run(connection, options, config),
    };
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prepared = await this.prepareCall(
      options.provider,
      options.model,
      options.signal,
    );
    yield* prepared.stream(options);
  }
  private async *run(
    connection: Transport,
    options: GenerateOptions,
    config: VertexAdapterConfig,
  ): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    try {
      const body = await buildRequest(options, config, this.options.image);
      const segments: Segment[] = [];
      let active: Segment | undefined;
      let finish: string | undefined;
      let usage: TokenUsage | undefined;
      let count = 0;
      let tools = false;
      const callIds = new Set<string>();
      for await (const event of connection.stream(
        options.model,
        body,
        options.signal,
      )) {
        options.signal?.throwIfAborted();
        if (event.promptFeedback?.blockReason)
          fail("Vertex blocked this request.", "UNSUPPORTED_CONTENT");
        if (event.error) fail("Vertex returned an error in its stream.");
        if (event.candidates !== undefined && !Array.isArray(event.candidates))
          fail("Malformed Vertex candidates.");
        if (event.candidates?.length > 1)
          fail("Vertex returned more than one candidate.");
        const candidate = event.candidates?.[0];
        if (
          candidate &&
          (!isRecord(candidate) ||
            (candidate.index !== undefined && candidate.index !== 0))
        )
          fail("Malformed Vertex candidate.");
        const parts = candidate?.content?.parts;
        if (parts !== undefined && !Array.isArray(parts))
          fail("Malformed Vertex content.");
        for (const raw of parts ?? []) {
          if (finish) fail("Vertex sent content after the finish marker.");
          count += JSON.stringify(raw).length;
          if (count > 32 * 1024 * 1024)
            fail("Vertex output exceeds the local response limit.");
          if (
            !isRecord(raw) ||
            Object.keys(raw).some(
              (k) =>
                ![
                  "text",
                  "thought",
                  "thoughtSignature",
                  "functionCall",
                ].includes(k),
            )
          )
            fail("Unsupported Vertex response part.", "UNSUPPORTED_CONTENT");
          if (
            raw.thoughtSignature !== undefined &&
            (typeof raw.thoughtSignature !== "string" ||
              raw.thoughtSignature.length > 1024 * 1024)
          )
            fail("Invalid Vertex thought signature.");
          if (raw.thought !== undefined && typeof raw.thought !== "boolean")
            fail("Invalid Vertex thought marker.");
          let block: ContentBlock;
          let part: Part;
          if (raw.functionCall !== undefined) {
            const call = raw.functionCall;
            if (
              raw.text !== undefined ||
              !isRecord(call) ||
              typeof call.name !== "string" ||
              !call.name ||
              !isRecord(call.args) ||
              (call.id !== undefined && typeof call.id !== "string")
            )
              fail("Malformed Vertex function call.");
            const id = call.id || `vertex-${randomUUID()}`;
            if (callIds.has(id))
              fail("Vertex returned duplicate tool call identifiers.");
            callIds.add(id);
            block = {
              type: "tool-call",
              id: ToolCallId(id),
              name: call.name,
              arguments: JSON.stringify(call.args),
            };
            part = {
              functionCall: {
                name: call.name,
                args: structuredClone(call.args),
                ...(call.id ? { id: call.id } : {}),
              },
              ...(raw.thoughtSignature
                ? { thoughtSignature: raw.thoughtSignature }
                : {}),
            };
            tools = true;
          } else if (typeof raw.text === "string") {
            block = {
              type: raw.thought ? "reasoning" : "text",
              text: raw.text,
            };
            part = {
              text: raw.text,
              ...(raw.thought ? { thought: true } : {}),
              ...(raw.thoughtSignature
                ? { thoughtSignature: raw.thoughtSignature }
                : {}),
            };
          } else if (raw.thoughtSignature && active) {
            const previous = active.parts.at(-1)!;
            if (
              previous.thoughtSignature &&
              previous.thoughtSignature !== raw.thoughtSignature
            )
              fail("Conflicting Vertex thought signatures.");
            previous.thoughtSignature = raw.thoughtSignature;
            continue;
          } else fail("Malformed Vertex response part.");
          const merge =
            active &&
            (block.type === "text" || block.type === "reasoning") &&
            active.block.type === block.type;
          if (!merge) {
            if (active)
              yield {
                type: "block-end",
                index: active.index,
                block: active.block,
              };
            active = { index: segments.length, block, parts: [part] };
            segments.push(active);
            yield {
              type: "block-start",
              index: active.index,
              blockType: block.type,
            };
          } else {
            active!.parts.push(part);
            if (
              (active!.block.type === "text" ||
                active!.block.type === "reasoning") &&
              (block.type === "text" || block.type === "reasoning")
            )
              active!.block.text += block.text;
          }
          if (block.type === "tool-call")
            yield {
              type: "tool-call-delta",
              index: active!.index,
              id: block.id,
              name: block.name,
              argumentsDelta: block.arguments,
            };
          else if (block.type === "text" || block.type === "reasoning")
            yield {
              type: block.type === "text" ? "text-delta" : "reasoning-delta",
              index: active!.index,
              text: block.text,
            };
        }
        if (candidate?.finishReason) {
          if (finish) fail("Duplicate Vertex finish marker.");
          finish = String(candidate.finishReason);
        }
        const meta = event.usageMetadata;
        if (meta !== undefined) {
          if (!isRecord(meta)) fail("Malformed Vertex token usage.");
          const input = meta.promptTokenCount ?? 0,
            output = meta.candidatesTokenCount ?? 0,
            thought = meta.thoughtsTokenCount ?? 0,
            cached = meta.cachedContentTokenCount ?? 0;
          if (
            ![input, output, thought, cached].every(validNumber) ||
            cached > input
          )
            fail("Malformed Vertex token usage.");
          usage = {
            inputTokens: input - cached,
            outputTokens: output + thought,
            ...(meta.cachedContentTokenCount === undefined
              ? {}
              : { cacheReadTokens: cached }),
            ...(meta.thoughtsTokenCount === undefined
              ? {}
              : { reasoningTokens: thought }),
            ...(validNumber(meta.totalTokenCount)
              ? { totalTokens: meta.totalTokenCount }
              : {}),
          };
        }
      }
      if (!finish) fail("Vertex stream ended before its finish marker.");
      if (!["STOP", "MAX_TOKENS"].includes(finish))
        fail(
          "Vertex ended the response with a safety or generation error.",
          "UNSUPPORTED_CONTENT",
        );
      if (!segments.length) fail("Vertex returned no generated content.");
      if (active)
        yield { type: "block-end", index: active.index, block: active.block };
      if (usage) yield { type: "usage", usage };
      const replayState: ReplayEnvelope = {
        response: {
          kind: "vertex-json",
          version: 1,
          provider: options.provider,
          model: options.model,
        },
        blocks: segments.map((s) => ({ parts: s.parts }) satisfies ReplayBlock),
      };
      yield {
        type: "finish",
        reason: {
          kind:
            finish === "MAX_TOKENS"
              ? "max-tokens"
              : tools
                ? "tool-calls"
                : "stop",
        },
        replayState,
      };
    } catch (e) {
      safeFailure(e, options.signal);
    }
  }
}
