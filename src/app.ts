import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MediaRequest, Plan, PlanRequest, VIDEO_ID, clampPlanOutput, toWire, unknownStepTypes } from "./schema.js";
import { NoMediaResolver, ProviderError, type MediaResolver, type PlanProvider } from "./providers.js";
import { DeviceRegistry, RateLimiter } from "./security.js";

export interface AppDeps {
  devices: DeviceRegistry;
  provider: PlanProvider;
  /** Optional YouTube lookup so the phone can play a video directly. */
  media?: MediaResolver;
  mediaTimeoutMs?: number;
  /** Upper bound for one model call. */
  providerTimeoutMs?: number;
  perMinute?: number;
  perDay?: number;
  now?: () => number;
  clientIp?: (c: Context) => string;
  /** Metadata-only log line (never transcripts or plans). */
  log?: (entry: Record<string, unknown>) => void;
}

type Vars = { Variables: { device: string; requestId: string } };

const error = (c: Context, status: 400 | 401 | 404 | 413 | 415 | 429 | 502 | 503 | 504, code: string, message: string) =>
  c.json({ error: { code, message } }, status);

export function createApp(deps: AppDeps) {
  const now = deps.now ?? Date.now;
  const minute = new RateLimiter(deps.perMinute ?? 20, 60_000, now);
  const day = new RateLimiter(deps.perDay ?? 500, 86_400_000, now);
  const authFailures = new RateLimiter(10, 60_000, now);
  const timeoutMs = deps.providerTimeoutMs ?? 20_000;
  const ip = deps.clientIp ?? (() => "unknown");
  const log = deps.log ?? (() => {});
  const media = deps.media ?? NoMediaResolver;
  const mediaTimeoutMs = deps.mediaTimeoutMs ?? 4_000;

  const app = new Hono<Vars>();

  app.use("*", async (c, next) => {
    const requestId = randomUUID();
    c.set("requestId", requestId);
    const started = now();
    await next();
    c.header("x-request-id", requestId);
    c.header("cache-control", "no-store");
    log({ requestId, method: c.req.method, path: c.req.path, status: c.res.status, ms: now() - started });
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    const addr = ip(c);
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    const device = deps.devices.identify(token);
    if (!device) {
      const wait = authFailures.take(addr);
      if (wait) {
        c.header("retry-after", String(wait));
        return error(c, 429, "rate_limited", "Too many failed attempts");
      }
      return error(c, 401, "unauthorized", "Missing or invalid device token");
    }
    const wait = minute.take(device) || day.take(device);
    if (wait) {
      c.header("retry-after", String(wait));
      return error(c, 429, "rate_limited", "Rate limit exceeded");
    }
    c.set("device", device);
    await next();
  });

  app.get("/v1/ping", (c) => c.json({ ok: true, provider: deps.provider.name }));

  app.post(
    "/v1/media/resolve",
    bodyLimit({ maxSize: 2 * 1024, onError: (c) => error(c, 413, "too_large", "Request body too large") }),
    async (c) => {
      if (!(c.req.header("content-type") ?? "").includes("application/json")) {
        return error(c, 415, "unsupported_media_type", "Expected application/json");
      }
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return error(c, 400, "bad_json", "Body is not valid JSON");
      }
      const parsed = MediaRequest.safeParse(raw);
      if (!parsed.success) return error(c, 400, "bad_request", "Request does not match the schema");
      const requestId = c.get("requestId");
      if (!media.enabled) return c.json({ requestId, videoId: null, title: null });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), mediaTimeoutMs);
      try {
        const found = await media.youtube(parsed.data, controller.signal);
        if (!found || !VIDEO_ID.test(found.videoId)) return c.json({ requestId, videoId: null, title: null });
        return c.json({ requestId, videoId: found.videoId, title: found.title.slice(0, 200) });
      } catch (e) {
        if (e instanceof ProviderError && e.kind === "timeout") return error(c, 504, "media_timeout", "The video lookup timed out");
        return error(c, 502, "media_error", "The video lookup failed");
      } finally {
        clearTimeout(timer);
      }
    },
  );

  app.post(
    "/v1/plan",
    bodyLimit({ maxSize: 8 * 1024, onError: (c) => error(c, 413, "too_large", "Request body too large") }),
    async (c) => {
      if (!(c.req.header("content-type") ?? "").includes("application/json")) {
        return error(c, 415, "unsupported_media_type", "Expected application/json");
      }
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return error(c, 400, "bad_json", "Body is not valid JSON");
      }
      const parsed = PlanRequest.safeParse(raw);
      if (!parsed.success) return error(c, 400, "bad_request", "Request does not match the schema");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let output: unknown;
      try {
        output = await Promise.race([
          deps.provider.plan(parsed.data, controller.signal),
          new Promise((_, reject) =>
            controller.signal.addEventListener("abort", () => reject(new ProviderError("timeout", "timeout"))),
          ),
        ]);
      } catch (e) {
        if (e instanceof ProviderError && e.kind === "timeout") return error(c, 504, "provider_timeout", "The AI provider timed out");
        if (e instanceof ProviderError && e.kind === "invalid") {
          log({ requestId: c.get("requestId"), event: "provider_invalid", reason: e.message.slice(0, 60) });
          return error(c, 502, "invalid_plan", "The AI provider returned an invalid plan");
        }
        return error(c, 502, "provider_error", "The AI provider failed");
      } finally {
        clearTimeout(timer);
      }

      const dropped = unknownStepTypes(output);
      if (dropped.length > 0) log({ requestId: c.get("requestId"), event: "dropped_steps", types: dropped.slice(0, 5) });
      const plan = Plan.safeParse(clampPlanOutput(output));
      if (!plan.success) {
        // Metadata only: which fields failed and why, never their values.
        log({
          requestId: c.get("requestId"),
          event: "invalid_plan",
          issues: plan.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}:${i.code}`),
        });
        return error(c, 502, "invalid_plan", "The AI provider returned an invalid plan");
      }
      return c.json({ requestId: c.get("requestId"), plan: toWire(plan.data) });
    },
  );

  app.notFound((c) => error(c, 404, "not_found", "Not found"));
  app.onError((_e, c) => c.json({ error: { code: "internal", message: "Internal error" } }, 500));
  return app;
}
