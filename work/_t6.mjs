import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const P = "<title>MARK</title>REACHED";
const runChrome = (url, tag) => {
  const prof = "C:/Users/22478/AppData/Local/Temp/cxn-" + Math.random().toString(36).slice(2,8);
  const t = Date.now(); let out = "";
  try { out = execFileSync(CHROME, ["--headless=new","--dump-dom","--no-first-run","--user-data-dir="+prof,url], { encoding:"utf8", timeout:20000, stdio:["ignore","pipe","pipe"] }) }
  catch (e) { out = String(e.stdout || ""); }
  console.log(tag, "->", out.includes("REACHED") ? "OK" : "FAIL " + ((out.match(/ERR_[A-Z_]+/) ?? [])[0] ?? ""), Math.round((Date.now()-t)/1000)+"s");
};
const mk = async (bind, port) => { const s = createServer((q,r)=>{ r.writeHead(200,{"content-type":"text/html"}); r.end(P) }); s.on("connection",()=>console.log("[tcp]", port)); await new Promise(r=>s.listen(port, bind, r)); return s };
const d = await mk("127.0.0.1", 18083);
console.log("D server ready, ? 6 ??? Chrome");
await new Promise(r => setTimeout(r, 6000));
runChrome("http://127.0.0.1:18083/", "[D] 127.0.0.1 ?? + ? 6s");
const e = await mk("0.0.0.0", 18084);
runChrome("http://127.0.0.1:18084/", "[E] 0.0.0.0 ?? + ??");
d.close(); e.close();
