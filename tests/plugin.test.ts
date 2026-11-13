import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { VertexConnection } from "../src/vertex.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Authorization from "@deepseek-ai/dsh-authorization";
import { CredentialProvider } from "@deepseek-ai/dsh-credentials";
import LlmService from "@deepseek-ai/dsh-llm";
import * as plugin from "../src/index.js";

class MemoryCredentials extends CredentialProvider {
  records = new Map();
  async resolve() {
    return undefined;
  }
  async describe() {
    return { configured: false, writable: true };
  }
  async set() {}
  async unset() {}
  async readRecord(key) {
    return this.records.get(key);
  }
  async describeRecord(key) {
    return { configured: this.records.has(key), writable: true };
  }
  async listRecords() {
    return [...this.records].map(([key, record]) => ({
      key,
      kind: record.kind,
    }));
  }
  async modifyRecord(key, mutate) {
    const next = await mutate(this.records.get(key));
    if (next !== undefined) {
      this.records.set(key, next);
      this.ctx.emit("credentials/record-updated", key);
    }
    return next;
  }
  async deleteRecord(key) {
    this.records.delete(key);
    this.ctx.emit("credentials/record-updated", key);
  }
}
function account() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    type: "service_account",
    project_id: "example-project",
    client_email: "tester@example-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}
async function harness(config = {}) {
  const ctx = new Context();
  const services = [
    ctx.plugin(MemoryCredentials),
    ctx.plugin(Authorization),
    ctx.plugin(LlmService),
  ];
  await Promise.all(services.map((x) => x.await()));
  const fiber = ctx.plugin(plugin, config);
  await fiber.await();
  return {
    ctx,
    fiber,
    cleanup: async () => {
      await fiber.dispose();
      for (const service of services.reverse()) await service.dispose();
    },
  };
}
test("native secret import commits only credential record, registers models directory, and reload disposes flow", async () => {
  const { ctx, fiber, cleanup } = await harness();
  try {
    const secret = account(),
      prompts = [];
    const answers = [JSON.stringify(secret), "", "global"];
    await ctx.authorization.begin({
      key: plugin.RECORD_KEY,
      method: "json",
      interaction: {
        notify() {},
        async prompt(prompt) {
          prompts.push(prompt);
          return answers.shift()!;
        },
      },
    });
    assert.equal(prompts[0].kind, "secret");
    const record = await ctx.credentials.readRecord(plugin.RECORD_KEY);
    assert.equal(record.kind, "grant");
    assert.deepEqual(record.payload, {
      serviceAccount: secret,
      project: "example-project",
      location: "global",
    });
    assert.ok(
      ctx.llm
        .listConfigurableProviders()
        .some((x) => x.provider === "vertex-json"),
    );
    await fiber.dispose();
    assert.equal(ctx.authorization.describe(plugin.RECORD_KEY), undefined);
    assert.equal(ctx.llm.listProviders().includes("vertex-json"), false);
    const replacement = ctx.plugin(plugin, {});
    await replacement.await();
    assert.ok(ctx.authorization.describe(plugin.RECORD_KEY));
    await replacement.dispose();
    assert.equal(ctx.authorization.describe(plugin.RECORD_KEY), undefined);
  } finally {
    await cleanup();
  }
});
test("invalid import returns a safe error and never replaces existing credential", async () => {
  const { ctx, cleanup } = await harness();
  try {
    const privateMarker = "SECRET-DO-NOT-REPORT";
    const prior = {
      kind: "grant",
      payload: {
        serviceAccount: account(),
        project: "example-project",
        location: "global",
      },
    };
    await ctx.credentials.modifyRecord(plugin.RECORD_KEY, async () => prior);
    await assert.rejects(
      ctx.authorization.begin({
        key: plugin.RECORD_KEY,
        method: "json",
        interaction: {
          notify() {},
          async prompt() {
            return privateMarker;
          },
        },
      }),
      (error) => !String(error).includes(privateMarker),
    );
    assert.deepEqual(
      await ctx.credentials.readRecord(plugin.RECORD_KEY),
      prior,
    );
  } finally {
    await cleanup();
  }
});

test("host file import is bounded and commits canonical JSON without retaining path", async () => {
  const { ctx, cleanup } = await harness();
  const dir = await mkdtemp(join(tmpdir(), "dsh-vertex-import-"));
  try {
    const secret = account(),
      path = join(dir, "service.json");
    await writeFile(path, JSON.stringify(secret), { mode: 0o600 });
    const answers = [path, "billing-project", "us-central1"];
    await ctx.authorization.begin({
      key: plugin.RECORD_KEY,
      method: "file",
      interaction: {
        notify() {},
        async prompt() {
          return answers.shift()!;
        },
      },
    });
    assert.deepEqual(await ctx.credentials.readRecord(plugin.RECORD_KEY), {
      kind: "grant",
      payload: {
        serviceAccount: secret,
        project: "billing-project",
        location: "us-central1",
      },
    });
    await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(
      ctx.authorization.begin({
        key: plugin.RECORD_KEY,
        method: "file",
        interaction: {
          notify() {},
          async prompt() {
            return path;
          },
        },
      }),
      /smaller than 1 MiB/,
    );
  } finally {
    await cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting credentials clears cached discovered and manual model advertisements", async (t) => {
  const { ctx, cleanup } = await harness({
    models: [{ id: "gemini-2.5-flash" }],
  });
  t.mock.method(VertexConnection.prototype, "listModels", async () => [
    { id: "gemini-2.5-pro", name: "Test Pro" },
  ]);
  try {
    assert.deepEqual(await ctx.llm.listModels("vertex-json"), []);
    await ctx.credentials.modifyRecord(plugin.RECORD_KEY, async () => ({
      kind: "grant",
      payload: {
        serviceAccount: account(),
        project: "example-project",
        location: "global",
      },
    }));
    assert.deepEqual(
      (await ctx.llm.listModels("vertex-json")).map((model) => model.id).sort(),
      ["gemini-2.5-flash", "gemini-2.5-pro"],
    );
    await ctx.credentials.deleteRecord(plugin.RECORD_KEY);
    assert.deepEqual(await ctx.llm.listModels("vertex-json"), []);
  } finally {
    await cleanup();
  }
});
test("native model discovery forwards cancellation to the official transport", async (t) => {
  const { ctx, cleanup } = await harness();
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const controller = new AbortController();
  t.mock.method(VertexConnection.prototype, "listModels", async (signal) => {
    assert.equal(signal, controller.signal);
    started();
    await new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
    return [];
  });
  try {
    await ctx.credentials.modifyRecord(plugin.RECORD_KEY, async () => ({
      kind: "grant",
      payload: {
        serviceAccount: account(),
        project: "example-project",
        location: "global",
      },
    }));
    const discovery = ctx.llm.discoverModels(
      "vertex-json",
      { provider: "vertex-json" },
      controller.signal,
    );
    await waiting;
    controller.abort();
    await assert.rejects(discovery);
  } finally {
    await cleanup();
  }
});
test("lazy native client registers the row form and refreshes through the existing remote seam", async () => {
  let bundle, render, dictionary;
  runInNewContext(
    await readFile(new URL("../src/client.js", import.meta.url), "utf8"),
    {
      window: {
        __ModuleLoader__: {
          load(value) {
            bundle = value;
          },
        },
      },
    },
  );
  assert.equal(bundle.id, "dsh-vertex-json");
  const updates = [];
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children,
    }),
    useState: (initial) => [
      typeof initial === "function" ? initial() : initial,
      (value) => updates.push(value),
    ],
    useEffect() {},
  };
  const client = bundle.factory((id) => {
    assert.equal(id, "react");
    return React;
  });
  const calls = [];
  client.apply({
    effect: (fn) => fn(),
    locale: {
      register(ns, dict) {
        assert.equal(ns, "vertexJson");
        dictionary = dict.en;
      },
    },
    slots: {
      inject(_name, fn) {
        fn();
      },
      register(spec, component) {
        assert.equal(spec.key, "dsh-vertex-json#vertex-json");
        render = component;
      },
    },
    remote: {
      llm: {
        async discoverModels(...args) {
          calls.push(args);
          return { ok: true, value: [{ id: "gemini-2.5-flash" }] };
        },
      },
    },
  });
  const t = (key) => dictionary[key];
  assert.equal(render({ t, view: "summary" }), dictionary.summary);
  const mutations = [];
  const page = render({
    t,
    view: "page",
    form: {
      state: { status: "ready", value: {}, revision: 9, writable: true },
      async mutate(...args) {
        mutations.push(args);
        return true;
      },
    },
  });
  const tree = page.type(page.props);
  const walk = (node) =>
    node && typeof node === "object"
      ? [node, ...node.children.flatMap(walk)]
      : [];
  const elements = walk(tree);
  assert.equal(
    elements
      .filter((node) => node.type === "input")
      .some((node) => String(node.props.id).includes("secret")),
    false,
  );
  await elements
    .find((node) => node.type === "button" && node.props.type === "button")
    .props.onClick();
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([["vertex-json", { provider: "vertex-json" }]]),
  );
  assert.ok(
    updates.some((value) => typeof value === "string" && value.includes("1")),
  );
  await tree.props.onSubmit({ preventDefault() {} });
  assert.equal(mutations[0][1], 9);
  assert.ok(mutations[0][0].every((op) => op.path[0] !== "serviceAccount"));
});

test("installed Host adapter streams through the real DSH LLM runtime without a network call", async () => {
  const { ctx, cleanup } = await harness();
  const { VertexConnection } = await import("../src/vertex.js");
  const previous = VertexConnection.prototype.stream;
  let observed;
  VertexConnection.prototype.stream = async function* (model, body, signal) {
    observed = { model, body };
    signal?.throwIfAborted();
    yield {
      candidates: [
        {
          content: { parts: [{ text: "offline runtime reply" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 4,
        totalTokenCount: 7,
      },
    };
  };
  try {
    const answers = [JSON.stringify(account()), "", "global"];
    await ctx.authorization.begin({
      key: plugin.RECORD_KEY,
      method: "json",
      interaction: {
        notify() {},
        async prompt() {
          return answers.shift()!;
        },
      },
    });
    const events = [];
    for await (const event of ctx.llm.stream({
      provider: "vertex-json",
      model: "gemini-3.8-flash",
      messages: [
        { role: "user", content: [{ type: "text", text: "offline only" }] },
      ],
    }))
      events.push(event);
    assert.equal(events.at(-1)?.type, "finish");
    assert.equal(events.at(-1)?.reason.kind, "stop");
    assert.ok(
      events.some(
        (e) =>
          e.type === "block-end" &&
          e.block.type === "text" &&
          e.block.text === "offline runtime reply",
      ),
    );
    assert.equal(observed.model, "gemini-3.8-flash");
    assert.equal(observed.body.contents[0].parts[0].text, "offline only");
  } finally {
    VertexConnection.prototype.stream = previous;
    await cleanup();
  }
});
