import { createServer } from "node:http";
const s = createServer((q, r) => { console.log("[node-client hit]"); r.end("NODE-OK") });
await new Promise(r => s.listen(0, "127.0.0.1", r));
const port = s.address().port;
console.log("port", port);
try {
  const res = await fetch("http://127.0.0.1:" + port + "/", { signal: AbortSignal.timeout(5000) });
  console.log("node fetch ->", res.status, await res.text());
} catch (e) { console.log("node fetch FAILED", e.name, e.message) }
s.close();
