import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MockProvider, ProviderError, YouTubeResolver, type MediaResolver, type PlanProvider } from "../src/providers.js";
import { userMessage } from "../src/prompt.js";
import { DeviceRegistry, newDeviceToken } from "../src/security.js";
import { PLAN_JSON_SCHEMA, Plan, PlanRequest } from "../src/schema.js";

const device = newDeviceToken();
const registry = new DeviceRegistry(`phone:${device.hash}`);
const auth = { authorization: `Bearer ${device.token}`, "content-type": "application/json" };
const plan = (transcript: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ transcript, clientVersion: "2.0.0-rc1", ...extra });

function fixed(output: unknown): PlanProvider {
  return { name: "fixed", plan: async () => output };
}

describe("agent actions", () => {
  it("accepts send_message and navigate and puts say on the wire", async () => {
    const a = createApp({
      devices: registry,
      provider: fixed({
        steps: [
          { type: "navigate", target: "home" },
          { type: "send_message", channel: "whatsapp", recipient: "Μαρία", body: "Θα αργήσω" },
        ],
        clarification: null,
        note: "",
        say: "Θα σου διαβάσω το μήνυμα πριν το στείλω.",
      }),
    });
    const res = await a.request("/v1/plan", { method: "POST", headers: auth, body: plan("x") });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { plan: Record<string, unknown> };
    expect(json.plan.say).toBe("Θα σου διαβάσω το μήνυμα πριν το στείλω.");
    expect(json.plan.steps).toHaveLength(2);
  });

  it.each([
    ["a model-chosen address on a send", { steps: [{ type: "send_message", channel: "sms", recipient: "Μ", body: "x", address: "6900000000" }], note: "" }],
    ["an unknown navigation target", { steps: [{ type: "navigate", target: "factory_reset" }], note: "" }],
  ])("rejects %s", async (_n, output) => {
    const a = createApp({ devices: registry, provider: fixed(output) });
    const res = await a.request("/v1/plan", { method: "POST", headers: auth, body: plan("x") });
    expect(res.status).toBe(502);
  });

  it("shortens a too-long spoken reply instead of rejecting the plan", async () => {
    const a = createApp({ devices: registry, provider: fixed({ steps: [], note: "", say: "α".repeat(301) }) });
    const res = await a.request("/v1/plan", { method: "POST", headers: auth, body: plan("x") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { say: string } };
    expect(body.plan.say.length).toBeLessThanOrEqual(300);
  });

  it("the strict JSON schema lists every action and requires say", () => {
    const types = PLAN_JSON_SCHEMA.properties.steps.items.anyOf.map((o) => o.properties.type.enum[0]);
    expect(types).toEqual(expect.arrayContaining(["send_message", "navigate", "compose_message", "media_search", "delete_email"]));
    expect(PLAN_JSON_SCHEMA.required).toContain("say");
  });

  it("mock provider prepares a sample send and never claims it was sent", async () => {
    const out = Plan.parse(await new MockProvider().plan(PlanRequest.parse({ transcript: "Στείλε μήνυμα στη Μαρία για το πάρτι", clientVersion: "1" })));
    expect(out.steps[0]).toMatchObject({ type: "send_message", recipient: "Μαρία" });
    expect(out.say).not.toMatch(/στάλθηκε|έστειλα/);
  });
});

describe("conversation history", () => {
  it("is bounded and typed", () => {
    const item = { role: "user", text: "Άνοιξε το YouTube" };
    expect(PlanRequest.safeParse({ transcript: "a", clientVersion: "1", history: [item] }).success).toBe(true);
    expect(PlanRequest.safeParse({ transcript: "a", clientVersion: "1", history: Array(9).fill(item) }).success).toBe(false);
    expect(PlanRequest.safeParse({ transcript: "a", clientVersion: "1", history: [{ role: "system", text: "x" }] }).success).toBe(false);
    expect(PlanRequest.safeParse({ transcript: "a", clientVersion: "1", history: [{ role: "user", text: "x".repeat(501) }] }).success).toBe(false);
    expect(PlanRequest.parse({ transcript: "a", clientVersion: "1" }).history).toEqual([]);
  });

  it("is quoted to the model as data, oldest first", () => {
    const msg = userMessage(
      PlanRequest.parse({
        transcript: "όχι, στο Spotify",
        clientVersion: "1",
        history: [
          { role: "user", text: "Παίξε Despacito στο YouTube" },
          { role: "result", text: "Άνοιξα στο YouTube το «Despacito»." },
        ],
      }),
    );
    expect(msg.indexOf("Παίξε Despacito")).toBeLessThan(msg.indexOf("Άνοιξα στο YouTube"));
    expect(msg).toContain("Αποτέλεσμα: «Άνοιξα");
    expect(msg.trim().endsWith("Εντολή: «όχι, στο Spotify»")).toBe(true);
  });

  it("is never logged", async () => {
    const logs: Record<string, unknown>[] = [];
    const a = createApp({ devices: registry, provider: new MockProvider(), log: (e) => logs.push(e) });
    await a.request("/v1/plan", {
      method: "POST",
      headers: auth,
      body: plan("συνέχισε", { history: [{ role: "user", text: "Μυστικό για τον Κώστα" }] }),
    });
    expect(JSON.stringify(logs)).not.toContain("Κώστα");
  });
});

describe("POST /v1/media/resolve", () => {
  const resolver = (r: MediaResolver["youtube"]): MediaResolver => ({ enabled: true, youtube: r });
  const post = (a: ReturnType<typeof createApp>, b: unknown, h: Record<string, string> = auth) =>
    a.request("/v1/media/resolve", { method: "POST", headers: h, body: JSON.stringify(b) });

  it("needs a device token", async () => {
    const a = createApp({ devices: registry, provider: new MockProvider() });
    expect((await post(a, { app: "youtube", query: "x" }, { "content-type": "application/json" })).status).toBe(401);
  });

  it("returns nulls when no resolver is configured", async () => {
    const a = createApp({ devices: registry, provider: new MockProvider() });
    const res = await post(a, { app: "youtube", query: "Despacito" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ videoId: null, title: null });
  });

  it("returns a validated video id", async () => {
    const a = createApp({ devices: registry, provider: new MockProvider(), media: resolver(async () => ({ videoId: "kJQP7kiw5Fk", title: "Despacito" })) });
    expect(await (await post(a, { app: "youtube", query: "Despacito" })).json()).toMatchObject({ videoId: "kJQP7kiw5Fk", title: "Despacito" });
    const bad = createApp({ devices: registry, provider: new MockProvider(), media: resolver(async () => ({ videoId: "javascript:x", title: "" })) });
    expect(await (await post(bad, { app: "youtube", query: "x" })).json()).toMatchObject({ videoId: null });
  });

  it("rejects malformed requests", async () => {
    const a = createApp({ devices: registry, provider: new MockProvider() });
    expect((await post(a, { app: "spotify", query: "x" })).status).toBe(400);
    expect((await post(a, { app: "youtube", query: "" })).status).toBe(400);
    expect((await post(a, { app: "youtube", query: "x", extra: 1 })).status).toBe(400);
  });

  it("maps failures and timeouts", async () => {
    const failing = createApp({
      devices: registry,
      provider: new MockProvider(),
      media: resolver(async () => {
        throw new ProviderError("key=secret", "upstream");
      }),
    });
    const res = await post(failing, { app: "youtube", query: "x" });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
    const slow = createApp({
      devices: registry,
      provider: new MockProvider(),
      mediaTimeoutMs: 20,
      media: resolver((_r, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new ProviderError("t", "timeout"))))),
    });
    expect((await post(slow, { app: "youtube", query: "x" })).status).toBe(504);
  });
});

describe("YouTube resolver", () => {
  it("queries the Data API with the server key and parses the first video", async () => {
    let url = "";
    const fakeFetch = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ items: [{ id: { videoId: "kJQP7kiw5Fk" }, snippet: { title: "Luis Fonsi &amp; Daddy Yankee" } }] }));
    }) as unknown as typeof fetch;
    const r = new YouTubeResolver({ apiKey: "yt-server-key", fetch: fakeFetch });
    expect(await r.youtube({ app: "youtube", query: "Despacito" }, new AbortController().signal)).toEqual({
      videoId: "kJQP7kiw5Fk",
      title: "Luis Fonsi & Daddy Yankee",
    });
    const u = new URL(url);
    expect(u.hostname).toBe("www.googleapis.com");
    expect(u.searchParams.get("key")).toBe("yt-server-key");
    expect(u.searchParams.get("q")).toBe("Despacito");
    expect(u.searchParams.get("type")).toBe("video");
  });

  it("returns null for no results and throws on HTTP errors", async () => {
    const empty = new YouTubeResolver({ apiKey: "k", fetch: (async () => new Response(JSON.stringify({ items: [] }))) as unknown as typeof fetch });
    expect(await empty.youtube({ app: "youtube", query: "x" }, new AbortController().signal)).toBeNull();
    const failing = new YouTubeResolver({ apiKey: "k", fetch: (async () => new Response("quota", { status: 403 })) as unknown as typeof fetch });
    await expect(failing.youtube({ app: "youtube", query: "x" }, new AbortController().signal)).rejects.toMatchObject({ kind: "upstream" });
  });
});

describe("invented action types", () => {
  it("drops an unknown step but keeps the valid ones", async () => {
    const out = { steps: [{ type: "answer", text: "x" }, { type: "show_draft", kind: "text", title: "Συνταγή", text: "Ζυμάρι…" }], note: "", say: "Ορίστε." };
    const a = createApp({ devices: registry, provider: fixed(out) });
    const res = await a.request("/v1/plan", { method: "POST", headers: auth, body: plan("πώς φτιάχνω πίτσα") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { steps: { type: string }[] } };
    expect(body.plan.steps.map((s) => s.type)).toEqual(["show_draft"]);
  });
});

describe("unsupported message channel", () => {
  it("turns the send into a screen task instead of rejecting the plan", async () => {
    const { clampPlanOutput, Plan } = await import("../src/schema.js");
    const out = Plan.safeParse(clampPlanOutput({
      steps: [{ type: "send_message", channel: "instagram", recipient: "Ιωάννα", body: "γεια" }],
      clarification: null, note: "", say: "",
    }));
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.steps.map((s) => s.type)).toEqual(["screen_task"]);
      expect(JSON.stringify(out.data.steps[0])).toContain("γεια");
    }
  });
});
