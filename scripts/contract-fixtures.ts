import { writeFileSync } from "node:fs";
import { createApp } from "../src/app.ts";
import { MockProvider } from "../src/providers.ts";
import { DeviceRegistry, newDeviceToken } from "../src/security.ts";
const d = newDeviceToken();
const a = createApp({
  devices: new DeviceRegistry(`p:${d.hash}`),
  provider: new MockProvider(),
  media: { enabled: true, youtube: async () => ({ videoId: "kJQP7kiw5Fk", title: "Luis Fonsi - Despacito ft. Daddy Yankee" }) },
});
const h = { authorization: `Bearer ${d.token}`, "content-type": "application/json" };
const dir = new URL("../../app/src/test/resources/contract/", import.meta.url).pathname;
const req = async (path: string, body: unknown) =>
  JSON.stringify(await (await a.request(path, { method: "POST", headers: h, body: JSON.stringify(body) })).json(), null, 2) + "\n";
const v = "2.0.0-rc1";
writeFileSync(dir + "plan-ad.json", await req("/v1/plan", { transcript: "Ετοίμασε μια διαφήμιση για το CryptoCycles", clientVersion: v }));
writeFileSync(dir + "plan-clarify.json", await req("/v1/plan", { transcript: "Βρες αυτή την πληροφορία και ετοίμασε μια περίληψη", clientVersion: v }));
writeFileSync(dir + "plan-summary.json", await req("/v1/plan", { transcript: "ηλεκτρικά ποδήλατα", clientVersion: v, context: { previousTranscript: "Βρες αυτή την πληροφορία και ετοίμασε περίληψη", question: "Για ποιο θέμα;" } }));
writeFileSync(dir + "plan-send.json", await req("/v1/plan", { transcript: "Στείλε μήνυμα στη Μαρία για το πάρτι", clientVersion: v, history: [{ role: "user", text: "γεια" }] }));
writeFileSync(dir + "media-resolve.json", await req("/v1/media/resolve", { app: "youtube", query: "Despacito" }));
