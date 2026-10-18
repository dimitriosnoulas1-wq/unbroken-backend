import { z } from "zod";

/**
 * Mirrors app/src/main/java/gr/voiceagent/agent/Actions.kt exactly. The phone decodes
 * strictly (unknown keys or types are rejected), and validates every step again with
 * its own ActionRegistry before showing it, so this is defence in depth.
 */
const FORBIDDEN = /\b(?:javascript|intent|file|content):/i;
const text = (max: number) =>
  z.string().max(max).refine((s) => !FORBIDDEN.test(s), { message: "forbidden scheme" });

export const MEDIA_APPS = ["youtube", "spotify"] as const;
export const CHANNELS = ["sms", "whatsapp", "viber", "messenger", "email", "share", ""] as const;
export const PLATFORMS = ["x", "linkedin", "facebook", "instagram", "share", ""] as const;
export const DRAFT_KINDS = ["ad", "summary", "message", "text"] as const;
export const NAVIGATE_TARGETS = ["back", "home", "recents", "notifications"] as const;

export const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open_app"), app: text(80) }),
  z.object({ type: z.literal("media_search"), app: z.enum(MEDIA_APPS), query: text(300) }),
  z.object({ type: z.literal("web_search"), query: text(300) }),
  z.object({ type: z.literal("compose_message"), channel: z.enum(CHANNELS), recipient: text(80), body: text(3000) }),
  // No address field: the phone resolves recipients from its own contacts, never from the model.
  z.strictObject({ type: z.literal("send_message"), channel: z.enum(CHANNELS), recipient: text(80), body: text(3000) }),
  z.object({ type: z.literal("navigate"), target: z.enum(NAVIGATE_TARGETS) }),
  z.object({ type: z.literal("share_post"), platform: z.enum(PLATFORMS), text: text(3000) }),
  z.object({ type: z.literal("dial"), contact: text(80), number: z.string().regex(/^(\+?[0-9][0-9 ()-]{2,19})?$/) }),
  z.object({ type: z.literal("delete_email"), query: text(300) }),
  z.object({ type: z.literal("create_reminder"), title: text(200), startIso: z.string().max(40) }),
  z.object({ type: z.literal("show_draft"), kind: z.enum(DRAFT_KINDS), title: text(120), text: text(6000).min(1) }),
  /** Anything else that can be done by looking at the screen and tapping/typing (the phone confirms the goal first). */
  z.object({ type: z.literal("screen_task"), goal: text(500).min(1) }),
]);
export type Action = z.infer<typeof Action>;

export const Clarification = z.object({
  question: text(300).min(1),
  slot: z.literal("free").default("free"),
  options: z.array(text(60)).max(6).default([]),
});

export const MAX_STEPS = 5;

export const Plan = z.object({
  steps: z.array(Action).max(MAX_STEPS),
  clarification: Clarification.nullable().optional(),
  note: text(300).default(""),
  /** Short spoken reply in Greek (answers, what will happen). Never claims that anything was done. */
  say: text(300).default(""),
});
export type Plan = z.infer<typeof Plan>;

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");
/** The user asked for an internet search in so many words. */
const WEB_ASKED = /google|γκουγκλ|ιντερνετ|διαδικτυ|internet|\bweb\b|browser|chrome|ιστοσελιδ|website/;
/** The user said the message must not be sent. */
const NO_SEND = /χωρισ να (?:το )?στειλεισ|χωρισ αποστολη|μην (?:το )?στειλεισ|χωρισ να σταλει|without sending|don'?t send|do not send|but don'?t send/;
export const NO_SEND_MARK = "χωρίς να το στείλεις";

/**
 * Deterministic rules on the model's plan, applied after validation:
 * - a web search is never a substitute for finding someone inside an app: it is dropped when the
 *   plan already has an in-app task (screen task or message) and the user did not ask for the web;
 * - «χωρίς να το στείλεις» turns every send into a draft and marks every screen goal as no-send.
 */
export function guardPlan(plan: Plan, transcript: string): Plan {
  const t = fold(transcript);
  let steps = plan.steps;
  const inApp = steps.some((s) => s.type === "screen_task" || s.type === "send_message" || s.type === "compose_message");
  if (inApp && !WEB_ASKED.test(t)) steps = steps.filter((s) => s.type !== "web_search");
  if (NO_SEND.test(t)) {
    steps = steps.map((s): Action => {
      if (s.type === "send_message") return { type: "compose_message", channel: s.channel, recipient: s.recipient, body: s.body };
      if (s.type === "screen_task" && !NO_SEND.test(fold(s.goal))) return { ...s, goal: `${s.goal} ${NO_SEND_MARK}`.slice(0, 500) };
      return s;
    });
  }
  return steps === plan.steps ? plan : { ...plan, steps };
}

export const PlanRequest = z.strictObject({
  transcript: z.string().trim().min(1).max(1000),
  locale: z.string().max(16).default("el-GR"),
  context: z
    .strictObject({ previousTranscript: z.string().max(1000), question: z.string().max(300) })
    .nullable()
    .optional(),
  /** Earlier turns of the same conversation, text only. */
  history: z
    .array(z.strictObject({ role: z.enum(["user", "assistant", "result"]), text: z.string().max(500) }))
    .max(8)
    .default([]),
  clientVersion: z.string().max(40),
});
export type PlanRequest = z.infer<typeof PlanRequest>;

export const MediaRequest = z.strictObject({
  app: z.literal("youtube"),
  query: z.string().trim().min(1).max(300),
});
export type MediaRequest = z.infer<typeof MediaRequest>;

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Wire format sent to the phone: no nulls, all defaults present. */
export function toWire(plan: Plan) {
  return {
    steps: plan.steps,
    ...(plan.clarification ? { clarification: plan.clarification } : {}),
    note: plan.note,
    say: plan.say,
  };
}

/**
 * JSON Schema for structured output (strict: every property required, no additional
 * properties). The model can only produce these shapes. OpenAI strict mode receives
 * this object as-is. Gemini receives {@link geminiPlanSchema}, which writes a nullable
 * `clarification` as `type: ["object", "null"]` — the form Gemini documents — instead
 * of `anyOf` with `{type: "null"}`. The phone wire format and the zod `Plan` do not change.
 */
const str = { type: "string" } as const;
const obj = (type: string, props: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: ["type", ...Object.keys(props)],
  properties: { type: { type: "string", enum: [type] }, ...props },
});

export const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["steps", "clarification", "note", "say"],
  properties: {
    steps: {
      type: "array",
      maxItems: MAX_STEPS,
      items: {
        anyOf: [
          obj("open_app", { app: str }),
          obj("media_search", { app: { type: "string", enum: MEDIA_APPS }, query: str }),
          obj("web_search", { query: str }),
          obj("compose_message", { channel: { type: "string", enum: CHANNELS }, recipient: str, body: str }),
          obj("send_message", { channel: { type: "string", enum: CHANNELS }, recipient: str, body: str }),
          obj("navigate", { target: { type: "string", enum: NAVIGATE_TARGETS } }),
          obj("share_post", { platform: { type: "string", enum: PLATFORMS }, text: str }),
          obj("dial", { contact: str, number: str }),
          obj("delete_email", { query: str }),
          obj("create_reminder", { title: str, startIso: str }),
          obj("show_draft", { kind: { type: "string", enum: DRAFT_KINDS }, title: str, text: str }),
          obj("screen_task", { goal: str }),
        ],
      },
    },
    clarification: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["question", "slot", "options"],
          properties: { question: str, slot: { type: "string", enum: ["free"] }, options: { type: "array", items: str } },
        },
      ],
    },
    note: str,
    say: str,
  },
} as const;

/** Same plan schema, with Gemini's documented nullable-object form for `clarification`. */
/**
 * Gemini drops the `type` discriminator from `anyOf` step variants (steps arrive without a type),
 * so Gemini gets ONE flat step object with a required `type` enum; unused fields are "".
 * {@link expandGeminiSteps} turns each flat step back into the strict typed shape.
 */
const STEP_FIELDS: Record<string, string[]> = {
  open_app: ["app"],
  media_search: ["app", "query"],
  web_search: ["query"],
  compose_message: ["channel", "recipient", "body"],
  send_message: ["channel", "recipient", "body"],
  navigate: ["target"],
  share_post: ["platform", "text"],
  dial: ["contact", "number"],
  delete_email: ["query"],
  create_reminder: ["title", "startIso"],
  show_draft: ["kind", "title", "text"],
  screen_task: ["goal"],
};
const FLAT_FIELDS = ["app", "query", "channel", "recipient", "body", "target", "platform", "text", "contact", "number", "title", "startIso", "kind", "goal"];
const flatStep = {
  type: "object",
  required: ["type", ...FLAT_FIELDS],
  properties: {
    type: { type: "string", enum: Object.keys(STEP_FIELDS) },
    ...Object.fromEntries(FLAT_FIELDS.map((f) => [f, str])),
  },
} as const;

/** Key names (never values) of steps that have no usable type, for diagnostics. */
export function untypedStepKeys(output: unknown): string[] {
  const steps = (output as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((st) => typeof st === "object" && st !== null && !KNOWN_STEP_TYPES.has(String((st as { type?: unknown }).type)))
    .map((st) => Object.keys(st as object).map((k) => k.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20)).slice(0, 14).join(","));
}

/** Last resort when the model omits `type`: the field names say which action it meant. */
export function inferStepType(raw: Record<string, unknown>): string | undefined {
  const has = (k: string) => typeof raw[k] === "string" && (raw[k] as string).length > 0;
  if (has("goal")) return "screen_task";
  if (has("recipient") && has("body")) return "send_message";
  if (has("contact") || has("number")) return "dial";
  if (has("startIso")) return "create_reminder";
  if (has("platform")) return "share_post";
  if (has("target")) return "navigate";
  if (has("kind") && has("text")) return "show_draft";
  if (has("app") && has("query")) return "media_search";
  if (has("app")) return "open_app";
  if (has("query")) return "web_search";
  return undefined;
}

export function expandGeminiSteps(output: unknown): unknown {
  if (typeof output !== "object" || output === null) return output;
  const plan = { ...(output as Record<string, unknown>) };
  if (!Array.isArray(plan.steps)) return plan;
  plan.steps = plan.steps.map((st) => {
    if (typeof st !== "object" || st === null) return st;
    let raw = st as Record<string, unknown>;
    // {"send_message": {...}} wrapper form
    const only = Object.keys(raw);
    if (only.length === 1 && STEP_FIELDS[only[0]!] && typeof raw[only[0]!] === "object" && raw[only[0]!] !== null) {
      raw = { type: only[0], ...(raw[only[0]!] as Record<string, unknown>) };
    }
    const type = typeof raw.type === "string" && STEP_FIELDS[raw.type] ? raw.type : inferStepType(raw);
    const fields = type ? STEP_FIELDS[type] : undefined;
    if (!type || !fields) return st; // unknown: left alone, the validator drops or rejects it
    return { type, ...Object.fromEntries(fields.map((f) => [f, raw[f] ?? ""])) };
  });
  return plan;
}

export function geminiPlanSchema() {
  const schema = structuredClone(PLAN_JSON_SCHEMA);
  const objectVariant = schema.properties.clarification.anyOf.find((variant) => variant.type === "object");
  if (!objectVariant) throw new Error("plan schema clarification has no object variant");
  return {
    ...schema,
    properties: {
      ...schema.properties,
      steps: { type: "array", maxItems: MAX_STEPS, items: flatStep },
      clarification: {
        type: ["object", "null"] as ["object", "null"],
        additionalProperties: objectVariant.additionalProperties,
        required: objectVariant.required,
        properties: objectVariant.properties,
      },
    },
  };
}

/**
 * Models sometimes exceed a length limit by a few characters. Shorten the free-text fields
 * instead of rejecting the whole plan (the phone would then fall back to no AI at all).
 * Only lengths change; types, enums and the action list are still validated strictly.
 */
const CLAMPS: Record<string, number> = {
  say: 300,
  note: 300,
  title: 200,
  text: 6000,
  body: 3000,
  query: 300,
  question: 300,
  goal: 500,
};
const clip = (value: unknown, max: number): unknown => {
  if (typeof value !== "string" || value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
};
const KNOWN_STEP_TYPES = new Set([
  "open_app", "media_search", "web_search", "compose_message", "send_message", "navigate",
  "share_post", "dial", "delete_email", "create_reminder", "show_draft", "screen_task",
]);
/** Names of steps the model invented (action names only, never content), for diagnostics. */
export function unknownStepTypes(output: unknown): string[] {
  const steps = (output as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .map((st) => (typeof st === "object" && st !== null ? (st as { type?: unknown }).type : undefined))
    .filter((t) => typeof t !== "string" || !KNOWN_STEP_TYPES.has(t))
    .map((t) => String(t).replace(/[^A-Za-z0-9_ -]/g, "").slice(0, 30));
}
export function clampPlanOutput(output: unknown): unknown {
  if (typeof output !== "object" || output === null) return output;
  const original = output as Record<string, unknown>;
  const plan = { ...original };
  // Nothing runnable AND nothing to say: keep the output as is so validation rejects it (the phone then falls back).
  if (Array.isArray(original.steps) && original.steps.length > 0) {
    const anyKnown = original.steps.some((st) => typeof st === "object" && st !== null && KNOWN_STEP_TYPES.has(String((st as { type?: unknown }).type)));
    const hasSay = typeof original.say === "string" && original.say.trim().length > 0;
    if (!anyKnown && !hasSay) return output;
  }
  plan.say = clip(plan.say, 300);
  plan.note = clip(plan.note, 300);
  if (Array.isArray(plan.steps)) {
    // An invented action type can never run on the phone: drop that step and keep the valid ones.
    plan.steps = plan.steps
      .map((st) => {
        // A message on a channel the phone has no direct route for (Instagram, Telegram…) becomes a screen task.
        if (typeof st !== "object" || st === null) return st;
        const m = st as { type?: string; channel?: unknown; recipient?: unknown; body?: unknown };
        if ((m.type === "send_message" || m.type === "compose_message") && !(CHANNELS as readonly string[]).includes(String(m.channel))) {
          const where = String(m.channel ?? "").slice(0, 30);
          const who = String(m.recipient ?? "");
          const text = String(m.body ?? "");
          // compose_message only prepares the text; the phone refuses to press Send for a goal marked like this.
          const goal = m.type === "send_message"
            ? `Στο ${where} στείλε στον/στην ${who} το μήνυμα «${text}»`
            : `Στο ${where} γράψε στον/στην ${who} το μήνυμα «${text}» χωρίς να το στείλεις`;
          return { type: "screen_task", goal: goal.slice(0, 500) };
        }
        return st;
      })
      .filter((st) => typeof st === "object" && st !== null && KNOWN_STEP_TYPES.has(String((st as { type?: unknown }).type)))
      .map((step) => {
      if (typeof step !== "object" || step === null) return step;
      const s = { ...(step as Record<string, unknown>) };
      const type = s.type;
      if (type === "show_draft") {
        s.title = clip(s.title, 120);
        s.text = clip(s.text, 6000);
      } else {
        for (const k of ["title", "body", "query", "text", "goal"]) if (k in s) s[k] = clip(s[k], CLAMPS[k] ?? 300);
      }
      return s;
    });
  }
  const c = plan.clarification;
  if (typeof c === "object" && c !== null) plan.clarification = { ...(c as Record<string, unknown>), question: clip((c as Record<string, unknown>).question, 300) };
  return plan;
}


// ---------------------------------------------------------------------------------------
// Screen agent: one step at a time. The phone sends what is on screen, the model picks ONE action.
// ---------------------------------------------------------------------------------------
export const SCREEN_ACTIONS = [
  "tap", "long_press", "type", "enter", "scroll_down", "scroll_up", "swipe_left", "swipe_right",
  "back", "home", "open_app", "open_url", "wait", "done", "fail",
] as const;

const clipTo = (n: number) => z.string().transform((v) => v.slice(0, n));

export const ScreenStepRequest = z.strictObject({
  goal: z.string().trim().min(1).transform((v) => v.slice(0, 500)),
  /** Package name of the app in front. */
  app: clipTo(120).default(""),
  step: z.number().int().min(0).max(60).default(0),
  /** Compact numbered list of what is on screen, built on the phone. */
  screen: clipTo(9000),
  history: z.array(clipTo(160)).default([]).transform((v) => v.slice(-14)),
  /** Launchable app labels, sent on the first step. */
  apps: z.array(clipTo(40)).default([]).transform((v) => v.slice(0, 120)),
  clientVersion: clipTo(40),
});
export type ScreenStepRequest = z.infer<typeof ScreenStepRequest>;

export const ScreenStep = z.object({
  action: z.enum(SCREEN_ACTIONS),
  node: z.number().int().min(-1).max(2000),
  text: z.string().max(500),
  app: z.string().max(80),
  say: z.string().max(200),
}).superRefine((s, ctx) => {
  // The phone checks again; an open_url without a plain web address is never sent to it.
  if (s.action === "open_url" && !/^https?:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i.test(s.text)) {
    ctx.addIssue({ code: "custom", path: ["text"], message: "open_url needs an http(s) URL" });
  }
});
export type ScreenStep = z.infer<typeof ScreenStep>;

export const SCREEN_STEP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "node", "text", "app", "say"],
  properties: {
    action: { type: "string", enum: [...SCREEN_ACTIONS] },
    node: { type: "integer" },
    text: str,
    app: str,
    say: str,
  },
} as const;

export function clampScreenStep(output: unknown): unknown {
  if (typeof output !== "object" || output === null) return output;
  const o = { ...(output as Record<string, unknown>) };
  // Gemini leaves out or nulls the free-text fields it has nothing for (seen in production as
  // invalid_step_say:invalid_type). Only missing/null becomes ""; any other wrong type still fails validation.
  for (const k of ["text", "app", "say"]) if (o[k] === undefined || o[k] === null) o[k] = "";
  o.text = clip(o.text, 500);
  o.say = clip(o.say, 200);
  o.app = clip(o.app, 80);
  if (typeof o.node !== "number") o.node = -1;
  return o;
}
