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

  it("keeps a compose on an unsupported channel a draft, never a send", async () => {
    const { clampPlanOutput, Plan } = await import("../src/schema.js");
    const out = Plan.safeParse(clampPlanOutput({
      steps: [{ type: "compose_message", channel: "instagram", recipient: "Ιωάννα", body: "γεια" }],
      clarification: null, note: "", say: "",
    }));
    expect(out.success).toBe(true);
    if (out.success) {
      const goal = (out.data.steps[0] as { goal: string }).goal;
      expect(goal).toContain("χωρίς να το στείλεις");
      expect(goal).not.toContain("στείλε στον");
    }
  });
});

describe("Instagram send: confirmation to first screen step (real-device 502 invalid_step)", () => {
  const transcript = "Στο Instagram στείλε στην Ιωάννα Εξάρχου το μήνυμα «τι κάνεις»";
  const ok = (content: unknown, finish = "stop") =>
    new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }));

  async function flow(screenReply: () => Response) {
    const { OpenAICompatibleProvider } = await import("../src/providers.js");
    const fakeFetch = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.response_format.json_schema.name === "unbroken_plan") {
        return ok({ steps: [{ type: "send_message", channel: "instagram", recipient: "Ιωάννα Εξάρχου", body: "τι κάνεις" }], clarification: null, note: "", say: "" });
      }
      return screenReply();
    }) as unknown as typeof fetch;
    const a = createApp({ devices: registry, provider: new OpenAICompatibleProvider({ baseUrl: "https://x", apiKey: "k", model: "m", fetch: fakeFetch }) });
    const planRes = await a.request("/v1/plan", { method: "POST", headers: auth, body: plan(transcript) });
    expect(planRes.status).toBe(200);
    const steps = ((await planRes.json()) as { plan: { steps: { type: string; goal: string }[] } }).plan.steps;
    expect(steps.map((s) => s.type)).toEqual(["screen_task"]);
    expect(steps[0].goal).toBe("Στο instagram στείλε στον/στην Ιωάννα Εξάρχου το μήνυμα «τι κάνεις»");
    // What the phone sends right after «ναι»: step 0, the launcher screen.
    const screenBody = JSON.stringify({
      goal: steps[0].goal, app: "com.sec.android.app.launcher", step: 0,
      screen: "[0] TextView \"Instagram\" (πάτημα)\n[1] TextView \"Messenger\" (πάτημα)\n", history: [], apps: ["Instagram", "Messenger"], clientVersion: "2.0.8",
    });
    return a.request("/v1/screen/step", { method: "POST", headers: auth, body: screenBody });
  }

  it("runs the first step when the model answers", async () => {
    const res = await flow(() => ok({ action: "open_app", node: -1, text: "", app: "Instagram", say: "" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { step: { action: string } }).step.action).toBe("open_app");
  });

  it("names the cause when the model's reply is cut off, and never claims a step", async () => {
    const res = await flow(() => ok("", "length"));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_step_finish_length");
  });
});

describe("screen step free-text fields (production invalid_step_say:invalid_type)", () => {
  const body = JSON.stringify({ goal: "Στο Instagram γράψε στον/στην Ιωάννα Εξάρχου το μήνυμα «γεια» χωρίς να το στείλεις", app: "com.instagram.android", step: 0, screen: "[0] TextView \"Instagram\" (πάτημα)\n", clientVersion: "2.0.8" });
  const appWith = (output: unknown) => createApp({ devices: registry, provider: { name: "t", plan: async () => ({}), screenStep: async () => output } as PlanProvider });
  const post = (output: unknown) => appWith(output).request("/v1/screen/step", { method: "POST", headers: auth, body });

  it("accepts a valid step with say", async () => {
    const res = await post({ action: "done", node: -1, text: "", app: "", say: "Το έγραψα." });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { step: { say: string } }).step.say).toBe("Το έγραψα.");
  });

  it("treats a missing or null say/text/app as empty", async () => {
    for (const out of [{ action: "tap", node: 3 }, { action: "tap", node: 3, text: null, app: null, say: null }]) {
      const res = await post(out);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { step: unknown }).step).toEqual({ action: "tap", node: 3, text: "", app: "", say: "" });
    }
  });

  it("still rejects wrong types and malformed steps with a specific code", async () => {
    const cases: [unknown, string][] = [
      [{ action: "tap", node: 3, text: "", app: "", say: 42 }, "invalid_step_say:invalid_type"],
      [{ action: "tap", node: 3, text: "", app: "", say: { x: 1 } }, "invalid_step_say:invalid_type"],
      [{ action: "press_send", node: 3, text: "", app: "", say: "" }, "invalid_step_action:invalid_value"],
      [{ node: 3, text: "", app: "", say: "" }, "invalid_step_action:invalid_value"],
    ];
    for (const [out, code] of cases) {
      const res = await post(out);
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });
});

describe("generic screen tools", () => {
  const body = JSON.stringify({ goal: "Βρες καφετέρια κοντά μου", app: "com.sec.android.app.launcher", step: 0, screen: "", clientVersion: "2.0.9" });
  const post = (output: unknown) =>
    createApp({ devices: registry, provider: { name: "t", plan: async () => ({}), screenStep: async () => output } as PlanProvider })
      .request("/v1/screen/step", { method: "POST", headers: auth, body });

  it("accepts long_press, swipes and an https open_url", async () => {
    for (const out of [
      { action: "long_press", node: 2 }, { action: "swipe_left", node: -1 }, { action: "swipe_right", node: -1 },
      { action: "open_url", node: -1, text: "https://www.google.com/maps/search/καφετέρια" },
    ]) expect((await post(out)).status).toBe(200);
  });

  it("rejects open_url without a plain http(s) address", async () => {
    for (const text of ["", "intent://x#Intent;end", "javascript:alert(1)", "file:///sdcard/a", "https://user:pw@evil.example/", "https://a b.com"]) {
      const res = await post({ action: "open_url", node: -1, text, app: "", say: "" });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_step_text:custom");
    }
  });
});

describe("multilingual names", () => {
  it("tells the planner and the screen agent to keep names and text exactly and to treat look-alikes as candidates", async () => {
    const { SYSTEM_PROMPT, SCREEN_PROMPT, screenUserMessage } = await import("../src/prompt.js");
    expect(SYSTEM_PROMPT).toContain("μη μεταγράφεις ελληνικά↔λατινικά");
    expect(SCREEN_PROMPT).toContain("Ιωάννα Εξάρχου = Ioanna Exarchou");
    expect(SCREEN_PROMPT).toContain("≈όνομα");
    expect(SCREEN_PROMPT).not.toContain("προτίμησε το πρώτο αποτέλεσμα");
    const screen = "ΠΡΟΣΟΧΗ: 2 διαφορετικά ονόματα μοιάζουν με «Ιωάννα Εξάρχου».\n[1] TextView \"Ioanna Exarchou\" (πάτημα) ≈όνομα\n";
    const { ScreenStepRequest } = await import("../src/schema.js");
    const req = ScreenStepRequest.parse({ goal: "Στο Instagram στείλε στον/στην Ιωάννα Εξάρχου το μήνυμα «γεια»", screen, clientVersion: "2.1" });
    expect(screenUserMessage(req)).toContain(screen.trim());
  });
});

describe("in-app find never becomes a web search (real-device Bauke failure)", () => {
  const transcript = "Άνοιξε το Instagram, βρες το προφίλ του Bauke και ετοίμασε το μήνυμα \"Γεια σου, τι κάνεις;\" χωρίς να το στείλεις";
  const goal = "Στο Instagram βρες το προφίλ του Bauke και γράψε του το μήνυμα «Γεια σου, τι κάνεις;»";
  const modelPlan = {
    steps: [
      { type: "open_app", app: "instagram" },
      { type: "web_search", query: "τον φίλο μου μπάου και στα αγγλικά γράφει μπαούκε" },
      { type: "screen_task", goal },
    ],
    clarification: null, note: "", say: "",
  };

  it("drops the web search and keeps one no-send screen task with recipient and exact text", async () => {
    const res = await (await import("../src/app.js")).createApp({ devices: registry, provider: fixed(modelPlan) })
      .request("/v1/plan", { method: "POST", headers: auth, body: plan(transcript) });
    expect(res.status).toBe(200);
    const steps = ((await res.json()) as { plan: { steps: { type: string; goal?: string }[] } }).plan.steps;
    expect(steps.map((s) => s.type)).toEqual(["open_app", "screen_task"]);
    expect(steps[1].goal).toBe(`${goal} χωρίς να το στείλεις`);
  });

  it("guards English and Greeklish variants, and turns a send into a draft", async () => {
    const { guardPlan, Plan } = await import("../src/schema.js");
    const p = Plan.parse(modelPlan);
    for (const t of ["Open Instagram, find Bauke and write «Γεια σου, τι κάνεις;» but don't send it", "anoixe to instagram vres ton Bauke, do not send"]) {
      const out = guardPlan(p, t);
      expect(out.steps.some((s) => s.type === "web_search")).toBe(false);
      expect((out.steps.find((s) => s.type === "screen_task") as { goal: string }).goal.endsWith("χωρίς να το στείλεις")).toBe(true);
    }
    const send = Plan.parse({ steps: [{ type: "send_message", channel: "whatsapp", recipient: "Μαρία", body: "έρχομαι" }], clarification: null, note: "", say: "" });
    expect(guardPlan(send, "γράψε στη Μαρία ότι έρχομαι, μην το στείλεις").steps[0]).toEqual({ type: "compose_message", channel: "whatsapp", recipient: "Μαρία", body: "έρχομαι" });
  });

  it("keeps a web search the user asked for, and leaves plans without an in-app task alone", async () => {
    const { guardPlan, Plan } = await import("../src/schema.js");
    const p = Plan.parse(modelPlan);
    expect(guardPlan(p, "βρες στο google ποιος είναι ο Bauke και γράψε του στο Instagram").steps.some((s) => s.type === "web_search")).toBe(true);
    const web = Plan.parse({ steps: [{ type: "web_search", query: "καιρός" }], clarification: null, note: "", say: "" });
    expect(guardPlan(web, "βρες τον καιρό")).toBe(web);
  });
});

describe("suspend and resume (ask)", () => {
  const body = JSON.stringify({ goal: "Στο Instagram βρες τον Bauke και γράψε του «γεια» χωρίς να το στείλεις", app: "com.instagram.android", step: 3, screen: "[4] TextView \"Bauke Jansen\" ≈όνομα\n[5] TextView \"bauke_92\" ≈όνομα\n", clientVersion: "2.1" });
  const post = (output: unknown) =>
    createApp({ devices: registry, provider: { name: "t", plan: async () => ({}), screenStep: async () => output } as PlanProvider })
      .request("/v1/screen/step", { method: "POST", headers: auth, body });

  it("accepts ask with a question and candidates", async () => {
    const res = await post({ action: "ask", node: -1, text: "Bauke Jansen | bauke_92", app: "", say: "Ποιο από τα δύο προφίλ;" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { step: { action: string; text: string } }).step).toMatchObject({ action: "ask", text: "Bauke Jansen | bauke_92" });
  });

  it("rejects ask without a question", async () => {
    const res = await post({ action: "ask", node: -1, text: "a | b", app: "", say: " " });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_step_say:custom");
  });

  it("tells the model to ask instead of failing or guessing, to keep progress notes and to recover in place", async () => {
    const { SCREEN_PROMPT } = await import("../src/prompt.js");
    expect(SCREEN_PROMPT).toContain("ask {say, text}");
    expect(SCREEN_PROMPT).toContain("σημείωση:");
    expect(SCREEN_PROMPT).toContain("ΣΥΝΕΧΙΣΕ προς τον ΙΔΙΟ στόχο");
    expect(SCREEN_PROMPT).not.toContain("κάνε fail και γράψε στο say τα ονόματα");
  });
});

describe("look-only goals (real-device Wi-Fi failure)", () => {
  it("marks every screen goal no-change when the user forbade changes, once", async () => {
    const { guardPlan, Plan, NO_CHANGE_MARK } = await import("../src/schema.js");
    const t = "Άνοιξε τις Ρυθμίσεις του κινητού και δείξε μου τα διαθέσιμα δίκτυα Wi-Fi. Μην αλλάξεις καμία ρύθμιση και μη συνδεθείς σε κανένα δίκτυο.";
    const p = Plan.parse({ steps: [{ type: "screen_task", goal: "Στις Ρυθμίσεις δείξε τα δίκτυα Wi-Fi" }], clarification: null, note: "", say: "" });
    const out = guardPlan(p, t);
    const goal = (out.steps[0] as { goal: string }).goal;
    expect(goal.endsWith(NO_CHANGE_MARK)).toBe(true);
    expect(guardPlan(out, t)).toStrictEqual(out);
  });

  it("tells the planner that a goal inside an app is one screen_task, and the screen agent that intermediate success is not done", async () => {
    const { SYSTEM_PROMPT, SCREEN_PROMPT } = await import("../src/prompt.js");
    expect(SYSTEM_PROMPT).toContain("open_app ΜΟΝΟ όταν ο χρήστης θέλει απλώς να ανοίξει την εφαρμογή");
    expect(SCREEN_PROMPT).toContain("ΔΕΝ είναι ολοκλήρωση");
  });
});
