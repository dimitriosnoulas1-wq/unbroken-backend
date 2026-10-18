import { PLAN_JSON_SCHEMA, SCREEN_STEP_JSON_SCHEMA, VIDEO_ID, expandGeminiSteps, geminiPlanSchema, type MediaRequest, type PlanRequest, type ScreenStepRequest } from "./schema.js";
import { SCREEN_PROMPT, SYSTEM_PROMPT, screenUserMessage, userMessage } from "./prompt.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export interface PlanProvider {
  readonly name: string;
  /** Returns the raw model output; the caller validates it. */
  plan(req: PlanRequest, signal: AbortSignal): Promise<unknown>;
  /** One step of the screen agent. Optional so simple providers (tests) need not implement it. */
  screenStep?(req: ScreenStepRequest, signal: AbortSignal): Promise<unknown>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "upstream" | "invalid",
  ) {
    super(message);
  }
}

/**
 * Any OpenAI-compatible Chat Completions endpoint with JSON-schema structured output
 * (OpenAI, Azure OpenAI, OpenRouter, local servers). The API key never leaves the server.
 */
export class OpenAICompatibleProvider implements PlanProvider {
  readonly name = "openai-compatible";

  constructor(
    private readonly opts: { baseUrl: string; apiKey: string; model: string; fetch?: typeof fetch },
  ) {}

  plan(req: PlanRequest, signal: AbortSignal): Promise<unknown> {
    return this.call(SYSTEM_PROMPT, userMessage(req), "unbroken_plan", PLAN_JSON_SCHEMA, 1500, signal);
  }

  screenStep(req: ScreenStepRequest, signal: AbortSignal): Promise<unknown> {
    return this.call(SCREEN_PROMPT, screenUserMessage(req), "unbroken_screen_step", SCREEN_STEP_JSON_SCHEMA, 400, signal);
  }

  private async call(system: string, user: string, name: string, schema: unknown, maxTokens: number, signal: AbortSignal): Promise<unknown> {
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({
          model: this.opts.model,
          temperature: 0.2,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name, strict: true, schema },
          },
        }),
      });
    } catch (e) {
      if (signal.aborted) throw new ProviderError("timeout", "timeout");
      throw new ProviderError("network", "upstream");
    }
    if (!res.ok) throw new ProviderError(`status ${res.status}`, "upstream");
    const body = (await res.json()) as { choices?: { message?: { content?: string; refusal?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new ProviderError("no content", "invalid");
    try {
      return JSON.parse(content);
    } catch {
      throw new ProviderError("not json", "invalid");
    }
  }
}

interface GeminiPart {
  text?: unknown;
  thought?: unknown;
}
interface GeminiResponse {
  promptFeedback?: { blockReason?: unknown };
  candidates?: { finishReason?: unknown; content?: { parts?: GeminiPart[] } }[];
}

const GEMINI_REJECTED_FINISH = new Set([
  "MAX_TOKENS",
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "LANGUAGE",
  "MALFORMED_FUNCTION_CALL",
]);

/**
 * Google Gemini `generateContent`. The API key is sent only in the `x-goog-api-key`
 * header, never in the URL. There are no tools: the model returns a plan, and the
 * phone executes it. Output is still validated by the caller.
 */
export class GeminiProvider implements PlanProvider {
  readonly name = "gemini";
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(
    private readonly opts: { baseUrl: string; apiKey: string; model: string; fetch?: typeof fetch },
  ) {
    this.apiKey = opts.apiKey.trim();
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is required when PROVIDER=gemini");
    if (!GEMINI_MODEL_ID.test(opts.model)) throw new Error("LLM_MODEL must be a Gemini model id");
    this.endpoint = geminiEndpoint(opts.baseUrl, opts.model);
  }

  async plan(req: PlanRequest, signal: AbortSignal): Promise<unknown> {
    return expandGeminiSteps(await this.call(SYSTEM_PROMPT, userMessage(req), geminiPlanSchema(), 2048, signal));
  }

  screenStep(req: ScreenStepRequest, signal: AbortSignal): Promise<unknown> {
    return this.call(SCREEN_PROMPT, screenUserMessage(req), SCREEN_STEP_JSON_SCHEMA, 2048, signal);
  }

  private async call(system: string, user: string, schema: unknown, maxTokens: number, signal: AbortSignal): Promise<unknown> {
    const f = this.opts.fetch ?? fetch;
    const send = async (withThinking: boolean): Promise<Response> => {
      try {
        return await f(this.endpoint, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: {
              maxOutputTokens: maxTokens,
              responseMimeType: "application/json",
              responseFormat: { text: { mimeType: "APPLICATION_JSON", schema } },
              ...(withThinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
            },
          }),
        });
      } catch {
        if (signal.aborted) throw new ProviderError("timeout", "timeout");
        throw new ProviderError("network", "upstream");
      }
    };
    let res = await send(true);
    // Some models (e.g. Flash-Lite) reject a thinking level they don't support: retry once without it.
    if (res.status === 400) res = await send(false);
    if (!res.ok) throw new ProviderError(`status ${res.status}`, "upstream");

    let body: GeminiResponse;
    try {
      body = (await res.json()) as GeminiResponse;
    } catch {
      throw new ProviderError("not json", "invalid");
    }
    const candidate = body.candidates?.[0];
    const finish = typeof candidate?.finishReason === "string" ? candidate.finishReason : "";
    if (GEMINI_REJECTED_FINISH.has(finish)) throw new ProviderError(`finish ${finish}`, "invalid");
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => part.thought !== true && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    if (!text) {
      const blocked = typeof body.promptFeedback?.blockReason === "string";
      throw new ProviderError(blocked ? "blocked" : "no content", "invalid");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError("not json", "invalid");
    }
  }
}

/**
 * Chooses the planner from the environment. `LLM_API_KEY` selects OpenAI even
 * when `PROVIDER=gemini`, because that deployment has no working Gemini account.
 * Gemini is used only when it is asked for and no OpenAI key is set.
 */
export function selectProvider(env: Record<string, string | undefined>): PlanProvider {
  const kind = (env.PROVIDER ?? "").trim().toLowerCase();
  const llmKey = env.LLM_API_KEY?.trim() ?? "";
  if (kind === "mock" || (!kind && !llmKey)) return new MockProvider();
  if (kind === "gemini" && !llmKey) {
    const apiKey = env.GEMINI_API_KEY?.trim() ?? "";
    if (!apiKey) throw new Error("GEMINI_API_KEY is required when PROVIDER=gemini");
    return new GeminiProvider({
      baseUrl: env.GEMINI_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL,
      apiKey,
      model: env.LLM_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    });
  }
  if (!llmKey) throw new Error("LLM_API_KEY is required unless PROVIDER=mock");
  return new OpenAICompatibleProvider({
    baseUrl: env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1",
    apiKey: llmKey,
    model: env.LLM_MODEL?.trim() || "gpt-4o-mini",
  });
}

function geminiEndpoint(baseUrl: string, model: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("GEMINI_BASE_URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("GEMINI_BASE_URL must be http or https");
  if (url.search || url.hash || url.username || url.password) {
    throw new Error("GEMINI_BASE_URL must not contain a query, hash, or credentials");
  }
  const path = url.pathname.replace(/\/$/, "");
  return `${url.origin}${path}/models/${model}:generateContent`;
}

/**
 * Deterministic offline provider for development, tests and demos. It produces
 * clearly labelled sample output and never pretends to be a real model.
 */
export class MockProvider implements PlanProvider {
  readonly name = "mock";

  async plan(req: PlanRequest): Promise<unknown> {
    const t = `${req.context?.previousTranscript ?? ""} ${req.transcript}`.toLowerCase();
    const topic = (re: RegExp) => req.transcript.match(re)?.[1]?.trim() ?? "";
    if (/διαφήμισ|διαφημισ|\bad\b/.test(t)) {
      const name = topic(/(?:για|about)\s+(?:το\s+|τη\s+|την\s+)?(.+)$/i) || "[προϊόν]";
      return {
        steps: [
          {
            type: "show_draft",
            kind: "ad",
            title: `Διαφήμιση: ${name}`,
            text: `${name}: [σύντομο μήνυμα για το τι κάνει].\nΔοκιμάστε το σήμερα → [σύνδεσμος]`,
          },
        ],
        clarification: null,
        note: "Δείγμα από τον δοκιμαστικό planner (mock).",
      };
    }
    if (/περίληψ|περιληψ|summar/.test(t)) {
      if (/αυτή την πληροφορία|αυτην την πληροφορια|this information/.test(t) && !req.context) {
        return { steps: [], clarification: { question: "Για ποιο θέμα να βρω πληροφορίες;", slot: "free", options: [] }, note: "" };
      }
      const subject = req.context ? req.transcript : topic(/(?:για|about)\s+(.+?)(?:\s+και\s+|$)/i) || req.transcript;
      return {
        steps: [
          { type: "show_draft", kind: "summary", title: `Περίληψη: ${subject}`, text: `[Δείγμα περίληψης για «${subject}».]` },
          { type: "web_search", query: subject },
        ],
        clarification: null,
        note: "Δείγμα από τον δοκιμαστικό planner (mock), χωρίς πρόσβαση στο διαδίκτυο.",
      };
    }
    const message = req.transcript.match(/^στε[ίι]λε\s+(?:ένα\s+)?μήνυμα\s+(?:στ(?:ον|ην|η|ο)|σε)\s+(\S+)\s+για\s+(.+)$/i);
    if (message) {
      const [, recipient, about] = message;
      return {
        steps: [{ type: "send_message", channel: "", recipient, body: `[Δείγμα μηνύματος για: ${about}]` }],
        clarification: null,
        note: "Δείγμα από τον δοκιμαστικό planner (mock).",
        say: "Ετοίμασα ένα δείγμα μηνύματος. Θα σου το διαβάσω πριν το στείλω.",
      };
    }
    if (/^(?:τι ώρα|τι ωρα|what time)/.test(t.trim())) {
      return { steps: [], clarification: null, note: "", say: "Η ώρα φαίνεται πάνω στην οθόνη. Ο δοκιμαστικός planner δεν ξέρει την ώρα." };
    }
    return { steps: [], clarification: { question: "Τι ακριβώς θέλετε να κάνω;", slot: "free", options: [] }, note: "" };
  }
}

export interface ResolvedVideo {
  videoId: string;
  title: string;
}

/** Finds the best matching video so the phone can open and play it directly. */
export interface MediaResolver {
  readonly enabled: boolean;
  youtube(req: MediaRequest, signal: AbortSignal): Promise<ResolvedVideo | null>;
}

export const NoMediaResolver: MediaResolver = { enabled: false, youtube: async () => null };

/** YouTube Data API v3 search. The API key stays on the server. */
export class YouTubeResolver implements MediaResolver {
  readonly enabled = true;

  constructor(private readonly opts: { apiKey: string; fetch?: typeof fetch; regionCode?: string }) {}

  async youtube(req: MediaRequest, signal: AbortSignal): Promise<ResolvedVideo | null> {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      maxResults: "1",
      safeSearch: "moderate",
      videoEmbeddable: "true",
      regionCode: this.opts.regionCode ?? "GR",
      q: req.query,
      key: this.opts.apiKey,
    });
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`https://www.googleapis.com/youtube/v3/search?${params}`, { signal });
    } catch {
      if (signal.aborted) throw new ProviderError("timeout", "timeout");
      throw new ProviderError("network", "upstream");
    }
    if (!res.ok) throw new ProviderError(`status ${res.status}`, "upstream");
    const body = (await res.json()) as { items?: { id?: { videoId?: unknown }; snippet?: { title?: unknown } }[] };
    const item = body.items?.[0];
    const videoId = item?.id?.videoId;
    if (typeof videoId !== "string" || !VIDEO_ID.test(videoId)) return null;
    const title = typeof item?.snippet?.title === "string" ? decodeEntities(item.snippet.title).slice(0, 200) : "";
    return { videoId, title };
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
