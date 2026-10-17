import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function newDeviceToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256Hex(token) };
}

/**
 * Device registry from DEVICE_TOKENS_SHA256: comma-separated "name:sha256hex" (or bare hex).
 * Only hashes are configured, so a leaked config does not reveal usable tokens.
 */
export class DeviceRegistry {
  private readonly devices: { name: string; hash: Buffer }[];

  constructor(spec: string) {
    this.devices = spec
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry, i) => {
        const [maybeName, maybeHash] = entry.includes(":") ? entry.split(":", 2) : [`device-${i + 1}`, entry];
        const hex = (maybeHash ?? "").toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Invalid SHA-256 in DEVICE_TOKENS_SHA256 entry ${i + 1}`);
        return { name: maybeName ?? `device-${i + 1}`, hash: Buffer.from(hex, "hex") };
      });
  }

  get size() {
    return this.devices.length;
  }

  /** Returns the device name for a valid bearer token, comparing in constant time. */
  identify(token: string | undefined): string | null {
    if (!token || token.length < 32 || token.length > 200) return null;
    const candidate = Buffer.from(sha256Hex(token), "hex");
    let match: string | null = null;
    for (const d of this.devices) {
      if (timingSafeEqual(candidate, d.hash)) match = d.name;
    }
    return match;
  }
}

/**
 * Address used for the failed-authentication limit.
 *
 * With `trustProxy`, only the rightmost entry of `X-Forwarded-For` is eligible.
 * Google's external Application Load Balancer keeps caller-supplied values on
 * the left and appends the addresses it observed
 * (https://cloud.google.com/load-balancing/docs/https#x-forwarded-for). On a
 * direct Cloud Run request the observed client is that rightmost entry, and it
 * is often the only entry. Entries to the left are ignored, including when the
 * rightmost token is not an IP: the header is then discarded and the socket
 * address is used. Walking left would accept an address the caller chose.
 * Without `trustProxy` the header is ignored entirely.
 */
export function clientIpForRateLimit(opts: {
  trustProxy: boolean;
  forwardedFor: string | undefined;
  socketAddress: string | undefined;
}): string {
  if (opts.trustProxy) {
    const forwarded = rightmostIp(opts.forwardedFor);
    if (forwarded) return forwarded;
  }
  return normalizeIp(opts.socketAddress) ?? "unknown";
}

function rightmostIp(header: string | undefined): string | null {
  if (!header) return null;
  const last = header.split(",").at(-1);
  return normalizeIp(last);
}

function normalizeIp(value: string | undefined): string | null {
  if (!value) return null;
  const bare = value.trim().replace(/^["']|["']$/g, "").replace(/^\[|\]$/g, "");
  if (isIP(bare) === 0) return null;
  return bare.toLowerCase();
}

/** Fixed-window counters kept in memory; enough for a single personal instance. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 0 when allowed, otherwise seconds until the window resets. */
  take(key: string): number {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      if (this.windows.size > 10_000) this.prune(t);
      return 0;
    }
    if (w.count >= this.limit) return Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
    w.count++;
    return 0;
  }

  private prune(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
