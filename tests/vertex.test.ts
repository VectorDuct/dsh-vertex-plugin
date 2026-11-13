import test from "node:test";
import { JWT } from "google-auth-library";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  parseServiceAccount,
  VertexConnection,
  VertexError,
} from "../src/vertex.js";
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const raw = {
  type: "service_account",
  project_id: "test-project",
  client_email: "agent@test-project.iam.gserviceaccount.com",
  private_key: privateKey,
};
const account = () => parseServiceAccount(JSON.stringify(raw));
const connection = (fetchImpl: typeof fetch, extras = {}) =>
  new VertexConnection({
    serviceAccount: account(),
    location: "us-central1",
    accessToken: async () => "test-token",
    fetchImpl,
    ...extras,
  });
test("credential parser allowlists fields and rejects malformed credentials without disclosure", () => {
  assert.deepEqual(account(), {
    project_id: raw.project_id,
    client_email: raw.client_email,
    private_key: privateKey,
    type: "service_account",
  });
  assert.equal(
    "token_uri" in
      parseServiceAccount(
        JSON.stringify({ ...raw, token_uri: "https://evil.invalid" }),
      ),
    false,
  );
  for (const input of [
    "secret-string",
    JSON.stringify({ ...raw, type: "authorized_user" }),
    JSON.stringify({ ...raw, private_key: "private-secret" }),
  ]) {
    assert.throws(
      () => parseServiceAccount(input),
      (e) => e instanceof VertexError && !e.message.includes("secret"),
    );
  }
});
test("catalog uses official host, paginates and excludes non-generative Gemini variants", async () => {
  const urls: string[] = [];
  const c = connection(async (input, init) => {
    urls.push(String(input));
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer test-token",
    );
    return Response.json(
      urls.length === 1
        ? {
            publisherModels: [
              {
                name: "publishers/google/models/gemini-2.5-pro",
                displayName: "Gemini Pro",
              },
              { name: "publishers/google/models/gemini-embedding-001" },
              { name: "publishers/google/models/gemini-2.5-flash-image" },
            ],
            nextPageToken: "next token",
          }
        : {
            publisherModels: [
              { name: "publishers/google/models/gemini-3-flash-preview" },
              { name: "publishers/google/models/imagen-3" },
            ],
          },
    );
  });
  assert.deepEqual(
    (await c.listModels()).map((m) => m.id),
    ["gemini-2.5-pro", "gemini-3-flash-preview"],
  );
  assert.equal(
    new URL(urls[0]).hostname,
    "us-central1-aiplatform.googleapis.com",
  );
  assert.equal(new URL(urls[1]).searchParams.get("pageToken"), "next token");
});
test("catalog rejects pagination cycles", async () => {
  const c = connection(async () =>
    Response.json({ publisherModels: [], nextPageToken: "same" }),
  );
  await assert.rejects(
    c.listModels(),
    (e) => e instanceof VertexError && e.code === "INVALID_RESPONSE",
  );
});
test("rejects path injection and credential endpoint redirection before networking", async () => {
  const fail: typeof fetch = async () => {
    throw Error("network must not run");
  };
  assert.throws(
    () => connection(fail, { location: "evil.invalid/../../" }),
    VertexError,
  );
  assert.throws(() => connection(fail, { project: "../bad" }), VertexError);
  await assert.rejects(async () => {
    for await (const _ of connection(fail).stream("../evil", {})) {
    }
  }, VertexError);
});
test("stream decodes split UTF8, CRLF, multiline data and EOF without leaking or retrying", async () => {
  const bytes = new TextEncoder().encode(
    'data: {"text":\r\ndata: "你好"}\r\n\r\ndata: {"done":true}',
  );
  let calls = 0;
  const c = connection(async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(
      url.pathname,
      "/v1/projects/test-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:streamGenerateContent",
    );
    assert.equal(url.searchParams.get("alt"), "sse");
    assert.equal(init?.method, "POST");
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const b of bytes) controller.enqueue(Uint8Array.of(b));
          controller.close();
        },
      }),
    );
  });
  const result = [];
  for await (const event of c.stream("gemini-2.5-pro", { contents: [] }))
    result.push(event);
  assert.deepEqual(result, [{ text: "你好" }, { done: true }]);
  assert.equal(calls, 1);
});
test("HTTP errors are safe and expose only status and retry metadata", async () => {
  let calls = 0;
  const c = connection(async () => {
    calls++;
    return new Response("private key and user prompt", {
      status: 429,
      headers: { "retry-after": "3" },
    });
  });
  await assert.rejects(
    async () => {
      for await (const _ of c.stream("gemini-2.5-pro", {})) {
      }
    },
    (e) =>
      e instanceof VertexError &&
      e.status === 429 &&
      e.retryAfterMs === 3000 &&
      !e.message.includes("private"),
  );
  assert.equal(calls, 1);
});
test("consumer cancellation cancels response stream", async () => {
  let cancelled = false;
  const c = connection(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"ok":true}\n\n'),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  for await (const _ of c.stream("gemini-2.5-pro", {})) break;
  assert.equal(cancelled, true);
});
test("oversized SSE frame is rejected safely", async () => {
  const c = connection(
    async () => new Response("data: " + "x".repeat(2 * 1024 * 1024)),
  );
  await assert.rejects(
    async () => {
      for await (const _ of c.stream("gemini-2.5-pro", {})) {
      }
    },
    (e) => e instanceof VertexError && e.code === "INVALID_RESPONSE",
  );
});
test("abort cancels a blocked SSE read and does not emit raw upstream errors", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const c = connection(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const stream = c
    .stream("gemini-2.5-pro", {}, controller.signal)
    [Symbol.asyncIterator]();
  const pending = stream.next();
  setTimeout(
    () => controller.abort(new DOMException("Cancelled", "AbortError")),
    5,
  );
  await assert.rejects(
    pending,
    (e) => e instanceof DOMException && e.name === "AbortError",
  );
  assert.equal(cancelled, true);
});
test("connection snapshots project and headers without forwarding imported credential fields", async () => {
  const headers = { "x-goog-api-client": "dsh-vertex-json/0.1" };
  const serviceAccount = account();
  const c = new VertexConnection({
    serviceAccount,
    location: "global",
    headers,
    accessToken: async () => "token",
    fetchImpl: async (input, init) => {
      assert.equal(
        new URL(String(input)).hostname,
        "aiplatform.googleapis.com",
      );
      assert.equal(
        new Headers(init?.headers).get("x-goog-api-client"),
        "dsh-vertex-json/0.1",
      );
      assert.equal(init?.redirect, "error");
      assert.equal(String(input).includes("/projects/test-project/"), true);
      return new Response("data: {}\n\n");
    },
  });
  serviceAccount.project_id = "mutated-project";
  headers["x-goog-api-client"] = "mutated";
  for await (const _ of c.stream("gemini-2.5-pro", {})) {
  }
});
test("malformed successful catalog is a safe invalid-response error", async () => {
  await assert.rejects(
    connection(async () => new Response("not-json-secret")).listModels(),
    (e) => e instanceof VertexError && e.code === "INVALID_RESPONSE",
  );
});

test("default JWT token refresh is coalesced and a failed refresh is safely reset", async (t) => {
  let calls = 0;
  let release: () => void = () => {};
  let fail = true;
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(JWT.prototype, "getAccessToken", async () => {
    calls++;
    await gate;
    if (fail) throw Error("private upstream credential details");
    return { token: "official-library-token" };
  });
  const c = new VertexConnection({
    serviceAccount: account(),
    location: "global",
    fetchImpl: async () => Response.json({ publisherModels: [] }),
  });
  const first = c.listModels();
  const second = c.listModels();
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  const failed = await Promise.allSettled([first, second]);
  for (const result of failed) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof VertexError);
      assert.equal(result.reason.code, "AUTH");
      assert.equal(result.reason.message.includes("private"), false);
    }
  }
  fail = false;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const third = c.listModels();
  const fourth = c.listModels();
  await Promise.resolve();
  assert.equal(calls, 2);
  release();
  assert.deepEqual(await Promise.all([third, fourth]), [[], []]);
});
test("preserves DSH attribution on catalog and generation with safe auth and no redirects", async () => {
  const seen: string[] = [];
  const headers = {
    "user-agent": "DSH/0.2.2-rc.2",
    "x-goog-api-client": "dsh-vertex-json/0.1.0",
    authorization: "Bearer must-not-use",
  };
  const c = connection(
    async (input, init) => {
      const actual = new Headers(init?.headers);
      assert.equal(actual.get("user-agent"), headers["user-agent"]);
      assert.equal(
        actual.get("x-goog-api-client"),
        headers["x-goog-api-client"],
      );
      assert.equal(actual.get("authorization"), "Bearer test-token");
      assert.equal(init?.redirect, "error");
      seen.push(String(input));
      return String(input).includes(":streamGenerateContent")
        ? new Response("data: {}\n\n")
        : Response.json({ publisherModels: [] });
    },
    { headers },
  );
  await c.listModels();
  for await (const _ of c.stream("gemini-2.5-pro", {})) {
  }
  assert.equal(seen.length, 2);
});
test("a synchronous SDK token error does not poison future authentication", async (t) => {
  let calls = 0;
  t.mock.method(JWT.prototype, "getAccessToken", () => {
    if (++calls === 1) throw Error("SDK failure");
    return Promise.resolve({ token: "fresh" });
  });
  const c = new VertexConnection({
    serviceAccount: account(),
    location: "global",
    fetchImpl: async () => Response.json({ publisherModels: [] }),
  });
  await assert.rejects(
    c.listModels(),
    (e) => e instanceof VertexError && e.code === "AUTH",
  );
  assert.deepEqual(await c.listModels(), []);
  assert.equal(calls, 2);
});
