const { createServer } = require("node:http");
const s = createServer((q, r) => { r.writeHead(200,{"content-type":"text/html"}); r.end("<title>MARK</title>REACHED") });
s.listen(45123, "127.0.0.1", () => console.log("READY high-port 45123"));
