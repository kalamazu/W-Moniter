import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const P = "<title>MARK</title>REACHED";
const runChrome = (url, tag) => {
  const prof = "C:/Users/22478/AppData/Local/Temp/cxn-" + Math.random().toString(36).slice(2,8);
  const t = Date.now();
  let out = "";
  try { out = execFileSync(CHROME, ["--headless=new","--dump-dom","--no-first-run","--user-data-dir="+prof,url], { encoding: "utf8", timeout: 20000, stdio: ["ignore","pipe","pipe"] }) }
  catch (e) { out = String(e.stdout || ""); }
  console.log(tag, "->", out.includes("REACHED") ? "OK" : "FAIL", ((out.match(/ERR_[A-Z_]+/) ?? [])[0] ?? ""), Math.round((Date.now()-t)/1000) + "s");
};
runChrome("http://127.0.0.1:18080/", "[A] node-spawned chrome -> ?????? 18080");
runChrome("https://example.com/",   "[B] node-spawned chrome -> ????");
const s = createServer((q, r) => { console.log("[same-proc hit]"); r.writeHead(200,{"content-type":"text/html"}); r.end(P) });
s.on("connection", () => console.log("[same-proc tcp]"));
await new Promise(r => s.listen(18082, "127.0.0.1", r));
runChrome("http://127.0.0.1:18082/", "[C] node-spawned chrome -> ??????? 18082");
s.close();
