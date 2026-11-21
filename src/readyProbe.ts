import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { config } from "./config";

const tls = config.updatesMode === "webhook" && config.tlsCertPath && config.tlsKeyPath;
const request = tls ? https : http;
const tlsOptions = tls ? {
  ca: fs.readFileSync(config.tlsCertPath),
  ...(config.publicWebhookUrl ? { servername: new URL(config.publicWebhookUrl).hostname } : {}),
} : {};
const probe = request.get({ hostname: "127.0.0.1", port: config.port, path: "/ready", ...tlsOptions }, (res) => {
  res.resume();
  process.exitCode = res.statusCode === 200 ? 0 : 1;
});
probe.setTimeout(1500, () => probe.destroy(new Error("Readiness request timed out")));
probe.on("error", () => { process.exitCode = 1; });
