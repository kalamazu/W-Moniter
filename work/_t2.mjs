import { createServer as httpSrv, request as httpReq } from "node:http";
import { createServer as httpsSrv } from "node:https";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const h = httpSrv((q, r) => { console.log("[http hit]"); r.end("HTTP-OK") });
h.on("connection", () => console.log("[http tcp]"));
await new Promise(r => h.listen(0, "127.0.0.1", r));
console.log("http port", h.address().port);
try { console.log("curl http ->", execFileSync("curl.exe", ["-s", "-m", "8", "http://127.0.0.1:" + h.address().port + "/"], { encoding: "utf8" })) } catch (e) { console.log("curl http FAILED", e.status) }
h.close();

const s = httpsSrv({ key: readFileSync("work/spki/nosan.key"), cert: readFileSync("work/spki/nosan.pem") }, (q, r) => { console.log("[https hit]"); r.end("HTTPS-OK") });
s.on("connection", (c) => { console.log("[https tcp]"); c.on("error", e => console.log("[https sock err]", e.code)) });
s.on("tlsClientError", (e) => console.log("[tlsClientError]", e.code, e.message));
await new Promise(r => s.listen(0, "127.0.0.1", r));
console.log("https port", s.address().port);
try { console.log("curl https ->", execFileSync("curl.exe", ["-skv", "-m", "8", "https://127.0.0.1:" + s.address().port + "/"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) } catch (e) { console.log("curl https FAILED status", e.status, "stderr:", String(e.stderr).split("\n").slice(-12).join(" | ")) }
s.close();
