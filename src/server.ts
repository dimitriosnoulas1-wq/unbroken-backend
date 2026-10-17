import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createApp } from "./app.js";
import { NoMediaResolver, YouTubeResolver, selectProvider, type PlanProvider } from "./providers.js";
import { DeviceRegistry, clientIpForRateLimit } from "./security.js";

function provider(): PlanProvider {
  return selectProvider(process.env);
}

const devices = new DeviceRegistry(process.env.DEVICE_TOKENS_SHA256 ?? "");
if (devices.size === 0) {
  console.error("DEVICE_TOKENS_SHA256 is empty: run `npm run token` and configure at least one device.");
  process.exit(1);
}
const trustProxy = process.env.TRUST_PROXY === "1";
const p = provider();
const media = process.env.YOUTUBE_API_KEY ? new YouTubeResolver({ apiKey: process.env.YOUTUBE_API_KEY }) : NoMediaResolver;

const app = createApp({
  devices,
  provider: p,
  media,
  providerTimeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS ?? 20_000),
  perMinute: Number(process.env.RATE_PER_MINUTE ?? 20),
  perDay: Number(process.env.RATE_PER_DAY ?? 500),
  clientIp: (c) =>
    clientIpForRateLimit({
      trustProxy,
      forwardedFor: c.req.header("x-forwarded-for"),
      socketAddress: getConnInfo(c).remote.address,
    }),
  log: (entry) => console.log(JSON.stringify(entry)),
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, () => {
  console.log(JSON.stringify({ msg: "unbroken-backend listening", port, provider: p.name, media: media.enabled, devices: devices.size }));
});
