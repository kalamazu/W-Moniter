import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
const ROOT='F:/code/chrome'; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const DATA='F:/code/chrome/work/ctrl-off'
const app=spawn(ROOT+'/node_modules/electron/dist/electron.exe',['out/main/index.js','--no-sandbox','--remote-debugging-port=9493'],{cwd:ROOT,env:{...process.env,MONITOR_DATA_DIR:DATA,MONITOR_URL:'about:blank',MONITOR_AUTO_QUIT_MS:'0',MONITOR_API:'0',MONITOR_API_PORT:'9500'},stdio:'ignore'})
await sleep(9000)
const file=existsSync(DATA+'/control.json')
let listening=false
try{ await fetch('http://127.0.0.1:9500/health',{signal:AbortSignal.timeout(2000)}); listening=true }catch{}
console.log('MONITOR_API=0 -> control.json exists:', file, '| port 9500 listening:', listening)
app.kill()