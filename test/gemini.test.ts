import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
  GeminiProvider,
  selectProvider,
} from "../src/providers.js";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import { DeviceRegistry, newDeviceToken } from "../src/security.js";
import { PLAN_JSON_SCHEMA, geminiPlanSchema } from "../src/schema.js";

const KEY = "gemini-test-key-do-not-leak";
const PLAN = {
  steps: [{ type: "open_app", app: "instagram" }],
  clarification: null,
  note: "",
  say: "Ανοίγω το Instagram.",
};

function geminiResponse(text: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "hidden thought" }, { text }] } }],
      ...extra,
    }),
  );
}

function provider(fetchImpl: typeof fetch, opts?: { baseUrl?: string; model?: string }) {
  return new GeminiProvider({
    baseUrl: opts?.baseUrl ?? DEFAULT_GEMINI_BASE_URL,
    apiKey: KEY,
    model: opts?.model ?? DEFAULT_GEMINI_MODEL,
    fetch: fetchImpl,
  });
}

const request = { transcript: "Άνοιξε το Instagram", locale: "el-GR", history: [], clientVersion: "2.0.0-rc1" };

describe("Gemini provider", () => {
  it("retries once without thinkingConfig when the model rejects it (HTTP 400)", async () => {
    const bodies: any[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      bodies.push(payload);
      if (payload.generationConfig.thinkingConfig) return new Response("{}", { status: 400 });
      return geminiResponse(JSON.stringify(PLAN));
    }) as unknown as typeof fetch;
    const out = await provider(fakeFetch).plan(request, new AbortController().signal);
    expect(out).toEqual(PLAN);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].generationConfig.thinkingConfig).toBeDefined();
    expect(bodies[1].generationConfig.thinkingConfig).toBeUndefined();
  });

  it("sends the plan schema and the key only in the header", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return geminiResponse(JSON.stringify(PLAN));
    }) as unknown as typeof fetch;
    const out = await provider(fakeFetch).plan(request, new AbortController().signal);

    expect(out).toEqual(PLAN);
    expect(sent!.url).toBe(`${DEFAULT_GEMINI_BASE_URL}/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
    expect(sent!.url).not.toContain(KEY);
    expect(sent!.url).not.toContain("?");
    const headers = sent!.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(KEY);
    expect(headers.authorization).toBeUndefined();
    const payload = JSON.parse(String(sent!.init.body));
    expect(payload.systemInstruction.parts[0].text).toBe(SYSTEM_PROMPT);
    expect(payload.contents[0].parts[0].text).toContain("Άνοιξε το Instagram");
    expect(payload.tools).toBeUndefined();
    expect(payload.generationConfig.responseMimeType).toBe("application/json");
    expect(payload.generationConfig.temperature).toBeUndefined();
    expect(payload.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(payload.generationConfig.responseFormat.text.schema).toEqual(geminiPlanSchema());
    expect(JSON.stringify(payload)).not.toContain(KEY);
  });

  it.each([500, 429])("reports HTTP %s without the response body or the key", async (status) => {
    const secret = "upstream-secret-body";
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { message: secret, key: KEY } }), { status })) as unknown as typeof fetch;
    await expect(provider(fakeFetch).plan(request, new AbortController().signal)).rejects.toSatisfy((error: Error) => {
      expect(error).toMatchObject({ kind: "upstream", message: `status ${status}` });
      expect(error.message).not.toContain(secret);
      expect(String(error)).not.toContain(KEY);
      return true;
    });
  });

  it("treats a blocked or truncated reply as an invalid plan", async () => {
    const blocked = (async () =>
      new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }))) as unknown as typeof fetch;
    await expect(provider(blocked).plan(request, new AbortController().signal)).rejects.toMatchObject({
      kind: "invalid",
      message: "blocked",
    });
    const truncated = (async () =>
      new Response(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{" }] } }] }))) as unknown as typeof fetch;
    await expect(provider(truncated).plan(request, new AbortController().signal)).rejects.toMatchObject({
      kind: "invalid",
      message: "finish MAX_TOKENS",
    });
  });

  it("maps an aborted request to a timeout", async () => {
    const controller = new AbortController();
    const fakeFetch = (async () => {
      controller.abort();
      throw new Error("aborted");
    }) as unknown as typeof fetch;
    await expect(provider(fakeFetch).plan(request, controller.signal)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("refuses to start without a key, and never puts a key in the URL", () => {
    expect(() => selectProvider({ PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
    expect(() => selectProvider({ PROVIDER: "gemini", GEMINI_API_KEY: "   " })).toThrow(/GEMINI_API_KEY/);
    expect(() => new GeminiProvider({ baseUrl: DEFAULT_GEMINI_BASE_URL, apiKey: "  ", model: DEFAULT_GEMINI_MODEL })).toThrow(
      /GEMINI_API_KEY/,
    );
    const leaked = "query-key-must-not-appear";
    expect(() => selectProvider({ PROVIDER: "gemini", GEMINI_API_KEY: KEY, GEMINI_BASE_URL: `https://example.test/?key=${leaked}` })).toThrow(
      /must not contain a query/,
    );
    try {
      selectProvider({ PROVIDER: "gemini", GEMINI_API_KEY: KEY, GEMINI_BASE_URL: `https://example.test/?key=${leaked}` });
    } catch (e) {
      expect(String(e)).not.toContain(leaked);
      expect(String(e)).not.toContain(KEY);
    }
  });

  it("keeps mock and OpenAI selection unchanged", () => {
    expect(selectProvider({}).name).toBe("mock");
    expect(selectProvider({ LLM_API_KEY: "sk" }).name).toBe("openai-compatible");
    expect(selectProvider({ PROVIDER: "gemini", GEMINI_API_KEY: KEY }).name).toBe("gemini");
    expect(selectProvider({ PROVIDER: "gemini", GEMINI_API_KEY: KEY, LLM_API_KEY: " sk " }).name).toBe("openai-compatible");
    expect(() => selectProvider({ PROVIDER: "openai" })).toThrow(/LLM_API_KEY/);
  });
});

describe("Gemini schema compatibility", () => {
  const supported = new Set([
    "type",
    "format",
    "title",
    "description",
    "enum",
    "items",
    "prefixItems",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
    "anyOf",
    "oneOf",
    "properties",
    "additionalProperties",
    "required",
    "$id",
    "$defs",
    "$ref",
    "$anchor",
    "propertyOrdering",
  ]);

  function keywords(node: unknown, found = new Set<string>()): Set<string> {
    if (Array.isArray(node)) {
      for (const item of node) keywords(item, found);
      return found;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        found.add(key);
        if (key === "properties" && value && typeof value === "object") {
          for (const child of Object.values(value)) keywords(child, found);
        } else {
          keywords(value, found);
        }
      }
    }
    return found;
  }

  it("uses only keywords Gemini documents, and writes null as a type union", () => {
    for (const schema of [PLAN_JSON_SCHEMA, geminiPlanSchema()]) {
      for (const key of keywords(schema)) expect(supported.has(key), key).toBe(true);
    }
    const adapted = geminiPlanSchema();
    expect(adapted.properties.clarification.type).toEqual(["object", "null"]);
    expect("anyOf" in adapted.properties.clarification).toBe(false);
    expect(PLAN_JSON_SCHEMA.properties.clarification.anyOf[0]).toEqual({ type: "null" });
  });
});

describe("Gemini plan through the app", () => {
  it("rejects a schema-invalid model reply without leaking it", async () => {
    const device = newDeviceToken();
    const fakeFetch = (async () =>
      geminiResponse(JSON.stringify({ steps: [{ type: "shell", command: "rm -rf /" }] }))) as unknown as typeof fetch;
    const app = createApp({
      devices: new DeviceRegistry(`phone:${device.hash}`),
      provider: provider(fakeFetch),
    });
    const res = await app.request("/v1/plan", {
      method: "POST",
      headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" },
      body: JSON.stringify({ transcript: "κάνε κάτι", clientVersion: "2.0.0-rc1" }),
    });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json).toEqual({ error: { code: "invalid_plan", message: expect.any(String) } });
    expect(JSON.stringify(json)).not.toContain("shell");
    expect(JSON.stringify(json)).not.toContain(KEY);
  });
});
