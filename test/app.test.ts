import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MockProvider, OpenAICompatibleProvider, ProviderError, type PlanProvider } from "../src/providers.js";
import { DeviceRegistry, RateLimiter, clientIpForRateLimit, newDeviceToken, sha256Hex } from "../src/security.js";
import { PLAN_JSON_SCHEMA, Plan } from "../src/schema.js";

const device = newDeviceToken();
const registry = new DeviceRegistry(`phone:${device.hash}`);
const auth = { authorization: `Bearer ${device.token}`, "content-type": "application/json" };
const body = (transcript: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ transcript, clientVersion: "1.0.0-rc1", ...extra });

function fixed(output: unknown): PlanProvider {
  return { name: "fixed", plan: async () => output };
}

function app(provider: PlanProvider = new MockProvider(), extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const logs: Record<string, unknown>[] = [];
  const a = createApp({ devices: registry, provider, log: (e) => logs.push(e), ...extra });
  return { a, logs };
}

describe("authentication", () => {
  it("rejects missing and wrong tokens", async () => {
    const { a } = app();
    expect((await a.request("/v1/ping")).status).toBe(401);
    const wrong = await a.request("/v1/ping", { headers: { authorization: `Bearer ${newDeviceToken().token}` } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
  });

  it("accepts a configured device token", async () => {
    const { a } = app();
    const res = await a.request("/v1/ping", { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, provider: "mock" });
  });

  it("only stores hashes and validates the config", () => {
    expect(() => new DeviceRegistry("phone:notahash")).toThrow();
    expect(new DeviceRegistry(sha256Hex("x".repeat(40))).identify("x".repeat(40))).toBe("device-1");
    expect(registry.identify("short")).toBeNull();
  });

  it("throttles repeated auth failures per client", async () => {
    const { a } = app();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await a.request("/v1/ping", { headers: { authorization: "Bearer nope" } })).status;
    expect(last).toBe(429);
  });

  it("health check needs no token and reveals nothing", async () => {
    const { a } = app();
    expect(await (await a.request("/healthz")).json()).toEqual({ ok: true });
  });
});

describe("rate limits", () => {
  it("limits per device per minute with Retry-After", async () => {
    let t = 0;
    const { a } = app(new MockProvider(), { perMinute: 2, now: () => t });
    expect((await a.request("/v1/ping", { headers: auth })).status).toBe(200);
    expect((await a.request("/v1/ping", { headers: auth })).status).toBe(200);
    const limited = await a.request("/v1/ping", { headers: auth });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    t = 61_000;
    expect((await a.request("/v1/ping", { headers: auth })).status).toBe(200);
  });

  it("limiter resets per window", () => {
    let t = 0;
    const l = new RateLimiter(1, 1000, () => t);
    expect(l.take("a")).toBe(0);
    expect(l.take("a")).toBeGreaterThan(0);
    expect(l.take("b")).toBe(0);
    t = 1000;
    expect(l.take("a")).toBe(0);
  });
});

describe("Cloud Run client address", () => {
  const socket = "192.0.2.10";
  const observed = "203.0.113.50";

  it("ignores the header unless the proxy is trusted", () => {
    const forged = `198.51.100.9, ${observed}`;
    expect(clientIpForRateLimit({ trustProxy: false, forwardedFor: forged, socketAddress: socket })).toBe(socket);
    expect(clientIpForRateLimit({ trustProxy: true, forwardedFor: undefined, socketAddress: socket })).toBe(socket);
  });

  it("uses only the rightmost address and requires it to be an IP", () => {
    expect(clientIpForRateLimit({ trustProxy: true, forwardedFor: `1.2.3.4, ${observed}`, socketAddress: socket })).toBe(observed);
    expect(clientIpForRateLimit({ trustProxy: true, forwardedFor: observed, socketAddress: socket })).toBe(observed);
    expect(clientIpForRateLimit({ trustProxy: true, forwardedFor: "2001:db8::1, 2001:DB8::2", socketAddress: socket })).toBe("2001:db8::2");
    expect(clientIpForRateLimit({ trustProxy: true, forwardedFor: `${observed}, not-an-ip`, socketAddress: socket })).toBe(socket);
    expect(clientIpForRateLimit({ trustProxy: true, forwardedFor: `${observed},`, socketAddress: socket })).toBe(socket);
    expect(clientIpForRateLimit({ trustProxy: true, forwardedFor: "203.0.113.8, [2001:db8::9]", socketAddress: socket })).toBe("2001:db8::9");
  });

  it("keeps a forged prefix in the same failed-auth bucket", async () => {
    const { a } = app(new MockProvider(), {
      clientIp: (c) =>
        clientIpForRateLimit({
          trustProxy: true,
          forwardedFor: c.req.header("x-forwarded-for"),
          socketAddress: socket,
        }),
    });
    const attempt = (left: string) =>
      a.request("/v1/ping", { headers: { authorization: "Bearer nope", "x-forwarded-for": `${left}, ${observed}` } });
    for (let i = 0; i < 10; i++) expect((await attempt(`198.51.100.${i}`)).status).toBe(401);
    expect((await attempt("203.0.113.99")).status).toBe(429);
    const other = await a.request("/v1/ping", {
      headers: { authorization: "Bearer nope", "x-forwarded-for": `${observed}, 198.51.100.20` },
    });
    expect(other.status).toBe(401);
    for (let i = 0; i < 10; i++) {
      const junk = await a.request("/v1/ping", {
        headers: { authorization: "Bearer nope", "x-forwarded-for": `203.0.113.${i}, not-an-ip-${i}` },
      });
      expect(junk.status).toBe(401);
    }
    const junkLimited = await a.request("/v1/ping", {
      headers: { authorization: "Bearer nope", "x-forwarded-for": "198.51.100.8, not-an-ip-last" },
    });
    expect(junkLimited.status).toBe(429);
  });
});

describe("POST /v1/plan", () => {
  it("returns a validated plan for an ad request", async () => {
    const { a } = app();
    const res = await a.request("/v1/plan", { method: "POST", headers: auth, body: body("Ετοίμασε μια διαφήμιση για το CryptoCycles") });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { requestId: string; plan: { steps: { type: string; kind: string; title: string }[] } };
    expect(json.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(json.plan.steps[0]).toMatchObject({ type: "show_draft", kind: "ad" });
    expect(json.plan.steps[0]!.title).toContain("CryptoCycles");
    expect(Plan.safeParse(json.plan).success).toBe(true);
  });

  it("asks for clarification when the subject is vague", async () => {
    const { a } = app();
    const res = await a.request("/v1/plan", { method: "POST", headers: auth, body: body("Βρες αυτή την πληροφορία και ετοίμασε μια περίληψη") });
    const json = (await res.json()) as { plan: { steps: unknown[]; clarification: { question: string; slot: string } } };
    expect(json.plan.steps).toEqual([]);
    expect(json.plan.clarification.slot).toBe("free");
  });

  it("omits null clarification on the wire", async () => {
    const { a } = app(fixed({ steps: [{ type: "web_search", query: "καιρός" }], clarification: null, note: "" }));
    const json = (await (await a.request("/v1/plan", { method: "POST", headers: auth, body: body("καιρός") })).json()) as {
      plan: Record<string, unknown>;
    };
    expect("clarification" in json.plan).toBe(false);
  });

  it("rejects malformed requests", async () => {
    const { a } = app();
    const post = (b: string, h: Record<string, string> = auth) => a.request("/v1/plan", { method: "POST", headers: h, body: b });
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ transcript: "" , clientVersion: "x"}))).status).toBe(400);
    expect((await post(JSON.stringify({ transcript: "a", clientVersion: "x", extra: 1 }))).status).toBe(400);
    expect((await post(body("x".repeat(1001)))).status).toBe(400);
    expect((await post(body("hi"), { authorization: auth.authorization, "content-type": "text/plain" })).status).toBe(415);
  });

  it("rejects oversized bodies", async () => {
    const { a } = app();
    const res = await a.request("/v1/plan", { method: "POST", headers: auth, body: body("a", { pad: "x".repeat(9000) }) });
    expect(res.status).toBe(413);
  });

  it.each([
    ["unknown action type", { steps: [{ type: "run_shell", command: "rm -rf /" }], note: "" }],
    ["javascript url", { steps: [{ type: "web_search", query: "javascript:alert(1)" }], note: "" }],
    ["unsupported media app", { steps: [{ type: "media_search", app: "netflix", query: "x" }], note: "" }],
    ["too many steps", { steps: Array.from({ length: 6 }, () => ({ type: "web_search", query: "x" })), note: "" }],
    ["invalid phone number", { steps: [{ type: "dial", contact: "", number: "*#06#" }], note: "" }],
    ["not an object", "plain text"],
  ])("rejects provider output with %s", async (_name, output) => {
    const { a } = app(fixed(output));
    const res = await a.request("/v1/plan", { method: "POST", headers: auth, body: body("test") });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_plan");
  });

  it("times out slow providers", async () => {
    const slow: PlanProvider = { name: "slow", plan: () => new Promise((r) => setTimeout(() => r({ steps: [], note: "" }), 500)) };
    const { a } = app(slow, { providerTimeoutMs: 50 });
    const res = await a.request("/v1/plan", { method: "POST", headers: auth, body: body("test") });
    expect(res.status).toBe(504);
  });

  it("maps provider failures to 502 without leaking details", async () => {
    const failing: PlanProvider = { name: "x", plan: async () => { throw new ProviderError("secret upstream detail", "upstream"); } };
    const { a } = app(failing);
    const res = await a.request("/v1/plan", { method: "POST", headers: auth, body: body("test") });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });

  it("never logs transcripts", async () => {
    const { a, logs } = app();
    await a.request("/v1/plan", { method: "POST", headers: auth, body: body("Μυστικό μήνυμα προς Μαρία") });
    expect(JSON.stringify(logs)).not.toContain("Μαρία");
    expect(logs[0]).toMatchObject({ path: "/v1/plan", status: 200 });
  });

  it("re-plans with clarification context", async () => {
    const { a } = app();
    const res = await a.request("/v1/plan", {
      method: "POST",
      headers: auth,
      body: body("ηλεκτρικά ποδήλατα", { context: { previousTranscript: "Βρες αυτή την πληροφορία και ετοίμασε περίληψη", question: "Για ποιο θέμα;" } }),
    });
    const json = (await res.json()) as { plan: { steps: { type: string; query?: string }[] } };
    expect(json.plan.steps.map((s) => s.type)).toEqual(["show_draft", "web_search"]);
  });
});

describe("OpenAI-compatible provider", () => {
  it("sends a strict JSON schema and the server-side key only", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ steps: [], clarification: null, note: "" }) } }] }));
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ baseUrl: "https://llm.example/v1/", apiKey: "sk-server", model: "m", fetch: fakeFetch });
    const out = await p.plan({ transcript: "Άνοιξε το Instagram", locale: "el-GR", history: [], clientVersion: "1" }, new AbortController().signal);
    expect(out).toEqual({ steps: [], clarification: null, note: "" });
    expect(sent!.url).toBe("https://llm.example/v1/chat/completions");
    const payload = JSON.parse(String(sent!.init.body));
    expect(payload.response_format.json_schema.strict).toBe(true);
    expect(payload.response_format.json_schema.schema).toEqual(PLAN_JSON_SCHEMA);
    expect((sent!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-server");
  });

  it("reports non-JSON content as invalid", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "sure!" } }] }))) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x", apiKey: "k", model: "m", fetch: fakeFetch });
    await expect(p.plan({ transcript: "a", locale: "el-GR", history: [], clientVersion: "1" }, new AbortController().signal)).rejects.toMatchObject({ kind: "invalid" });
  });

  it("reports upstream HTTP errors", async () => {
    const fakeFetch = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x", apiKey: "k", model: "m", fetch: fakeFetch });
    await expect(p.plan({ transcript: "a", locale: "el-GR", history: [], clientVersion: "1" }, new AbortController().signal)).rejects.toMatchObject({ kind: "upstream" });
  });
});

