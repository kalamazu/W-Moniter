import { createServer as httpSrv } from "node:http";
import { createServer as httpsSrv } from "node:https";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const CHROME = "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe";
const PAGE = "<!doctype html><title>MARK</title><body>REACHED</body>";
const hits = [];
const h = httpSrv((q, r) => { hits.push("http"); r.writeHead(200, {"content-type":"text/html"}); r.end(PAGE) });
h.on("connection", () => hits.push("http-tcp"));
await new Promise(r => h.listen(0, "127.0.0.1", r));
const s = httpsSrv({ key: readFileSync("work/spki/nosan.key"), cert: readFileSync("work/spki/nosan.pem") }, (q, r) => { hits.push("https"); r.writeHead(200, {"content-type":"text/html"}); r.end(PAGE) });
s.on("connection", () => hits.push("https-tcp"));
await new Promise(r => s.listen(0, "127.0.0.1", r));
const hp = h.address().port, sp = s.address().port;
console.log("http", hp, "https", sp);
const run = (url, extra) => {
  const prof = "C:/Users/22478/AppData/Local/Temp/cx-" + Math.random().toString(36).slice(2,8);
  hits.length = 0;
  let out = "", err = "";
  try { out = execFileSync(CHROME, ["--headless=new","--dump-dom","--no-first-run","--user-data-dir="+prof,...extra,url], { encoding: "utf8", timeout: 25000, stdio: ["ignore","pipe","pipe"] }) }
  catch (e) { out = String(e.stdout||""); err = "THROWN " + String(e.message).slice(0,40) }
  const code = (out.match(/ERR_[A-Z_]+/) ?? [null])[0];
  console.log(extra.join(" ")||"(none)", "|", url.slice(0,24), "->", out.includes("REACHED") ? "OK" : "FAIL", code ?? "", err, "| hits:", hits.join(",") || "NONE");
  try { execFileSync("node", ["-e", "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})", prof]) } catch {}
};
run("http://127.0.0.1:" + hp + "/", []);
run("http://127.0.0.1:" + hp + "/", ["--no-proxy-server"]);
run("https://127.0.0.1:" + sp + "/", ["--ignore-certificate-errors"]);
run("https://127.0.0.1:" + sp + "/", ["--ignore-certificate-errors","--no-proxy-server"]);
h.close(); s.close();
