import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const ROOT='F:/code/chrome'
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const DATA='F:/code/chrome/work/ctrl-dbg3'
const origin=spawn(process.execPath,[join(ROOT,'scripts/test-origin.mjs'),'8806'],{cwd:ROOT,stdio:'ignore'})
const app=spawn(join(ROOT,'node_modules/electron/dist/electron.exe'),['out/main/index.js','--no-sandbox','--remote-debugging-port=9487'],{cwd:ROOT,env:{...process.env,MONITOR_DATA_DIR:DATA,MONITOR_URL:'http://127.0.0.1:8806/',MONITOR_PROFILE:'L',MONITOR_AUTO_QUIT_MS:'0',MONITOR_API_PORT:'9495',MONITOR_CONTROL_DEBUG:'1'},stdio:['ignore','pipe','pipe']})
app.stdout.on('data',c=>{const s=String(c); if(s.includes('dom.inspect')) process.stdout.write('MAIN-OUT: '+s)})
app.stderr.on('data',c=>{const s=String(c); if(s.includes('dom.inspect')) process.stdout.write('MAIN-ERR: '+s)})
let info=null
for(let i=0;i<80&&!info;i++){ await sleep(500); const f=join(DATA,'control.json'); if(!existsSync(f))continue; try{const j=JSON.parse(readFileSync(f,'utf8')); if(j.port&&j.token) info=j }catch{} }
const H={authorization:'Bearer '+info.token}; const base='http://127.0.0.1:'+info.port
for(let i=0;i<40;i++){ const s=await (await fetch(base+'/status',{headers:H})).json(); if(s.requestCount>0) break; await sleep(500) }
const r=await fetch(base+'/dom/inspect?selector=body',{headers:H}); console.log('resp:', (await r.text()).slice(0,200))
await sleep(500)
app.kill(); origin.kill()