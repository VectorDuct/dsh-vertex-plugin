import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BlockAssembler,
  createToolResultMessage,
  createAssistantMessage,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { VertexAdapter } from "../src/adapter.js";

function fixture(events: Record<string, unknown>[]) {
  const calls: Array<{
    model: string;
    body: Record<string, any>;
    signal?: AbortSignal;
  }> = [];
  const transport = {
    listModels: async () => [{ id: "gemini-test", name: "Test" }],
    async *stream(
      model: string,
      body: Record<string, unknown>,
      signal?: AbortSignal,
    ) {
      calls.push({ model, body, signal });
      for (const e of events) {
        signal?.throwIfAborted();
        yield e;
      }
    },
  };
  const adapter = new VertexAdapter({
    connection: async () => transport,
    config: () => ({ provider: "vertex-json" }),
  });
  return { adapter, calls, transport };
}
const request = (): GenerateOptions => ({
  provider: "vertex-json",
  model: "gemini-test",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
});
async function collect(stream: AsyncIterable<StreamChunk>) {
  const a = [];
  for await (const c of stream) a.push(c);
  return a;
}
function assemble(chunks: StreamChunk[]) {
  const a = new BlockAssembler();
  for (const c of chunks) a.push(c);
  return a;
}

test("DSH real assembler receives reasoning, text, disjoint cache usage and one finish", async () => {
  const f = fixture([
    {
      candidates: [
        {
          content: {
            parts: [{ thought: true, text: "think" }, { text: "hel" }],
          },
        },
      ],
    },
    {
      candidates: [
        { content: { parts: [{ text: "lo" }] }, finishReason: "STOP" },
      ],
      usageMetadata: {
        promptTokenCount: 20,
        cachedContentTokenCount: 4,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 2,
        totalTokenCount: 27,
      },
    },
  ]);
  const req = request();
  Object.freeze(req.messages[0]!.content);
  Object.freeze(req.messages);
  Object.freeze(req);
  const chunks = await collect(f.adapter.stream(req));
  const a = assemble(chunks);
  assert.deepEqual(a.blocks(), [
    { type: "reasoning", text: "think" },
    { type: "text", text: "hello" },
  ]);
  assert.deepEqual(a.usage, {
    inputTokens: 16,
    cacheReadTokens: 4,
    outputTokens: 7,
    reasoningTokens: 2,
    totalTokens: 27,
  });
  assert.equal(chunks.filter((c) => c.type === "finish").length, 1);
  assert.equal(a.finish.kind, "stop");
});
test("signed tool invocation round trips through DSH history and tool response", async () => {
  const f = fixture([
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "read_file", args: { path: "a.txt" } },
                thoughtSignature: "signed",
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
  ]);
  const chunks = await collect(f.adapter.stream(request()));
  const a = assemble(chunks);
  assert.equal(a.finish.kind, "tool-calls");
  const assistant = a.message({
    provider: "vertex-json",
    model: "gemini-test",
    replayState: a.replayState,
  });
  const call = a.blocks().find((x) => x.type === "tool-call");
  assert.ok(call && call.type === "tool-call");
  const tool = createToolResultMessage({
    callId: call.id,
    isError: false,
    content: [{ type: "text", text: "file contents" }],
  });
  await collect(
    f.adapter.stream({
      ...request(),
      messages: [...request().messages, assistant, tool],
    }),
  );
  const parts = f.calls[1]!.body.contents[1].parts;
  assert.equal(parts[0].thoughtSignature, "signed");
  assert.equal(parts[0].functionCall.name, "read_file");
  assert.equal(
    f.calls[1]!.body.contents[2].parts[0].functionResponse.name,
    "read_file",
  );
  assert.deepEqual(
    f.calls[1]!.body.contents[2].parts[0].functionResponse.response,
    { output: "file contents" },
  );
});
test("rejects changed assistant content with recognized replay metadata", async () => {
  const f = fixture([
    {
      candidates: [
        {
          content: { parts: [{ text: "original", thoughtSignature: "sig" }] },
          finishReason: "STOP",
        },
      ],
    },
  ]);
  const a = assemble(await collect(f.adapter.stream(request())));
  const changed = createAssistantMessage({
    content: [{ type: "text", text: "changed" }],
    source: {
      provider: "vertex-json",
      model: "gemini-test",
      replayState: a.replayState,
    },
  });
  await assert.rejects(
    () => collect(f.adapter.stream({ ...request(), messages: [changed] })),
    { code: "INVALID_REPLAY_STATE" },
  );
});
test("does not accept truncated stream or blocked response as successful generation", async () => {
  for (const events of [
    [{ candidates: [{ content: { parts: [{ text: "half" }] } }] }],
    [{ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }],
  ]) {
    const f = fixture(events);
    await assert.rejects(() => collect(f.adapter.stream(request())));
  }
});
test("prepareCall freezes connection and config generation, defaults do not disable safety", async () => {
  let config = { provider: "vertex-json", temperature: 0.2 };
  let hits = 0;
  const f = fixture([
    {
      candidates: [
        { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
      ],
    },
  ]);
  const adapter = new VertexAdapter({
    connection: async () => {
      hits++;
      return f.transport;
    },
    config: () => config,
  });
  const prepared = await adapter.prepareCall("vertex-json", "gemini-test");
  config = { provider: "vertex-json", temperature: 0.9 };
  await collect(prepared.stream(request()));
  assert.equal(f.calls[0]!.body.generationConfig.temperature, 0.2);
  assert.equal(hits, 1);
  assert.equal(f.calls[0]!.body.safetySettings, undefined);
});
test("model list distinguishes unverified discovery and includes manual supported models", async () => {
  const f = fixture([]);
  const adapter = new VertexAdapter({
    connection: async () => f.transport,
    config: () => ({
      models: [{ id: "gemini-manual", contextWindow: 64000, maxTokens: 8000 }],
    }),
  });
  const models = await adapter.listModels("vertex-json");
  assert.deepEqual(
    models.map((x) => x.id),
    ["gemini-test", "gemini-manual"],
  );
  assert.match(JSON.stringify(models), /Unverified/);
  const info = await adapter.resolveModel("vertex-json", "gemini-manual");
  assert.equal(info.context?.contextWindow, 64000);
  assert.equal(info.defaultMaxTokens, 8000);
});
test("reasoning effort selects explicit thinking and preserves model defaults if omitted", async () => {
  const f = fixture([
    {
      candidates: [
        { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
      ],
    },
  ]);
  await collect(
    f.adapter.stream({
      ...request(),
      model: "gemini-3.6-flash",
      reasoningEffort: "high" as GenerateOptions["reasoningEffort"],
    }),
  );
  assert.equal(
    f.calls[0]!.body.generationConfig.thinkingConfig.thinkingLevel,
    "HIGH",
  );
});
test("cancellation aborts before provider dispatch and unsupported images fail explicitly", async () => {
  const f = fixture([]);
  const c = new AbortController();
  c.abort();
  await assert.rejects(() =>
    collect(f.adapter.stream({ ...request(), signal: c.signal })),
  );
  assert.equal(f.calls.length, 0);
});

test("signature-only frame binds to the tool call and replays without fabricated text", async () => {
  const f = fixture([
    {
      candidates: [
        { content: { parts: [{ functionCall: { name: "noop", args: {} } }] } },
      ],
    },
    {
      candidates: [
        {
          content: { parts: [{ thoughtSignature: "trailing-signature" }] },
          finishReason: "STOP",
        },
      ],
    },
  ]);
  const a = assemble(await collect(f.adapter.stream(request())));
  const assistant = a.message({
    provider: "vertex-json",
    model: "gemini-test",
    replayState: a.replayState,
  });
  await collect(
    f.adapter.stream({
      ...request(),
      messages: [...request().messages, assistant],
    }),
  );
  assert.deepEqual(f.calls[1]!.body.contents[1].parts, [
    {
      functionCall: { name: "noop", args: {} },
      thoughtSignature: "trailing-signature",
    },
  ]);
});
test("Gemini 2.5 uses token thinking budgets; pre-thinking models expose no efforts", async () => {
  const f = fixture([
    {
      candidates: [
        { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
      ],
    },
  ]);
  await collect(
    f.adapter.stream({
      ...request(),
      model: "gemini-2.5-flash",
      maxTokens: 8000,
      reasoningEffort: "high" as GenerateOptions["reasoningEffort"],
    }),
  );
  assert.equal(
    f.calls[0]!.body.generationConfig.thinkingConfig.thinkingBudget,
    4000,
  );
  assert.equal(
    f.calls[0]!.body.generationConfig.thinkingConfig.thinkingLevel,
    undefined,
  );
  const legacy = await f.adapter.resolveModel(
    "vertex-json",
    "gemini-2.0-flash",
  );
  assert.equal(legacy.reasoning, undefined);
});
test("caller abort prevents directory requests even when a cached catalog exists", async () => {
  const f = fixture([]);
  await f.adapter.listModels("vertex-json");
  const c = new AbortController();
  c.abort();
  await assert.rejects(() => f.adapter.refreshModels(c.signal));
});

test("duplicate provider call IDs are rejected before tools can be dispatched", async () => {
  const f = fixture([
    {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { id: "same", name: "a", args: {} } },
              { functionCall: { id: "same", name: "b", args: {} } },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
  ]);
  await assert.rejects(() => collect(f.adapter.stream(request())), {
    code: "MALFORMED_RESPONSE",
  });
});

test("normalized images are attached with identity, while offloaded images never read bytes", async () => {
  const { AttachmentId } = await import("@deepseek-ai/dsh-attachment");
  const ref = {
    attachmentId: AttachmentId("test-image"),
    mediaType: "image/png" as const,
    bytes: 3,
    width: 1,
    height: 1,
  };
  const f = fixture([
    {
      candidates: [
        { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
      ],
    },
  ]);
  let reads = 0;
  const adapter = new VertexAdapter({
    connection: async () => f.transport,
    config: () => ({}),
    image: async () => {
      reads++;
      return { data: "YWJj", mimeType: "image/png" };
    },
  });
  const req: GenerateOptions = {
    ...request(),
    messages: [{ role: "user", content: [{ type: "image", attachment: ref }] }],
  };
  await collect(adapter.stream(req));
  assert.equal(reads, 1);
  assert.equal(
    f.calls[0]!.body.contents[0].parts[1].inlineData.mimeType,
    "image/png",
  );
  await collect(
    adapter.stream({
      ...req,
      messages: [
        {
          role: "user",
          content: [{ type: "image", attachment: ref, offloaded: true }],
        },
      ],
    }),
  );
  assert.equal(reads, 1);
  assert.match(JSON.stringify(f.calls[1]!.body), /test-image/);
});
test("signature-only output participates in the local total response bound", async () => {
  const signature = "s".repeat(900000);
  const f = fixture([
    { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
    ...Array.from({ length: 40 }, () => ({
      candidates: [{ content: { parts: [{ thoughtSignature: signature }] } }],
    })),
    { candidates: [{ finishReason: "STOP" }] },
  ]);
  await assert.rejects(
    () => collect(f.adapter.stream(request())),
    /response limit/,
  );
});

test("only supported thinking levels are advertised and sent for known model families", async () => {
  const f = fixture([
    {
      candidates: [
        { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
      ],
    },
  ]);
  for (const model of [
    "gemini-3.1-pro-preview",
    "gemini-3.8-flash",
    "gemini-4-carbon",
  ]) {
    const info = await f.adapter.resolveModel("vertex-json", model);
    assert.deepEqual(
      info.reasoning?.efforts.map((x) => String(x.id)),
      ["low", "medium", "high"],
    );
    await assert.rejects(
      () =>
        collect(
          f.adapter.stream({
            ...request(),
            model,
            reasoningEffort: "minimal" as GenerateOptions["reasoningEffort"],
          }),
        ),
      { code: "UNSUPPORTED_REASONING_EFFORT" },
    );
  }
  assert.deepEqual(
    (
      await f.adapter.resolveModel("vertex-json", "gemini-3-pro-preview")
    ).reasoning?.efforts.map((x) => String(x.id)),
    ["low", "high"],
  );
  const adapter = new VertexAdapter({
    connection: async () => f.transport,
    config: () => ({ thinkingBudget: 1024 }),
  });
  await assert.rejects(
    () => collect(adapter.stream({ ...request(), model: "gemini-4-carbon" })),
    { code: "UNSUPPORTED_OPTION" },
  );
});
