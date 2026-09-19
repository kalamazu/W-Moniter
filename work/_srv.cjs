const { createServer } = require("node:http");
const s = createServer((q, r) => { console.log("[HIT]", q.headers.host); r.writeHead(200, {"content-type":"text/html"}); r.end("<title>MARK</title>REACHED") });
s.on("connection", () => console.log("[TCP]"));
s.listen(18080, "0.0.0.0", () => console.log("READY 18080"));
