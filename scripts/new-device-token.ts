import { newDeviceToken } from "../src/security.js";

const name = (process.argv[2] ?? "phone").replace(/[^a-zA-Z0-9_-]/g, "");
const { token, hash } = newDeviceToken();
console.log("Device token (enter it once in the Unbroken app, then discard):");
console.log(`  ${token}`);
console.log("\nAdd this to DEVICE_TOKENS_SHA256 on the server (comma-separated for several devices):");
console.log(`  ${name}:${hash}`);
