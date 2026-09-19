const { createServer } = require("node:http");
const s = createServer((q, r) => { console.log("[HIT]", q.headers.host); r.writeHead(200, {"content-type":"text/html"}); r.end("<title>MARK</title>REACHED") });
s.on("connection", () => console.log("[TCP]"));
s.listen(18081, "127.0.0.1", () => console.log("READY 18081 loopback-only"));
