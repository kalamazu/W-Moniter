import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const ROOT='F:/code/chrome'
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const DATA='F:/code/chrome/work/ctrl-dbg2'
const origin=spawn(process.execPath,[join(ROOT,'scripts/test-origin.mjs'),'8805'],{cwd:ROOT,stdio:'ignore'})
const app=spawn(join(ROOT,'node_modules/electron/dist/electron.exe'),['out/main/index.js','--no-sandbox','--remote-debugging-port=9486'],{cwd:ROOT,env:{...process.env,MONITOR_DATA_DIR:DATA,MONITOR_URL:'http://127.0.0.1:8805/',MONITOR_PROFILE:'L',MONITOR_AUTO_QUIT_MS:'0',MONITOR_API_PORT:'9494'},stdio:'ignore'})
let info=null
for(let i=0;i<80&&!info;i++){ await sleep(500); const f=join(DATA,'control.json'); if(!existsSync(f))continue; try{const j=JSON.parse(readFileSync(f,'utf8')); if(j.port&&j.token) info=j }catch{} }
console.log('info:', info?.port)
const H={authorization:'Bearer '+info.token}
const base='http://127.0.0.1:'+info.port
for(let i=0;i<40;i++){ const s=await (await fetch(base+'/status',{headers:H})).json(); if(s.requestCount>0) break; await sleep(500) }
const page=await (await fetch(base+'/requests?limit=3',{headers:H})).json()
console.log('page rows[0]:', JSON.stringify(page.rows?.[0]).slice(0,400))
const seq=page.rows?.[0]?.seq
for(const p of ['/requests/'+seq, '/dom/inspect?selector=body', '/requests?domain=127.0.0.1&limit=2', '/requests?host=127.0.0.1&limit=2']){
  const r=await fetch(base+p,{headers:H}); const txt=await r.text()
  console.log('\n---',p,'->',r.status); console.log(txt.slice(0,500))
}
console.log('\nhost field sample:', page.rows?.map(r=>r.host).slice(0,5))
app.kill(); origin.kill()