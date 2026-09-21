import { readFileSync, writeFileSync } from 'node:fs'
const p = 'package.json'
let text = readFileSync(p, 'utf8')
if (text.includes('test:layout')) { console.log('already there'); process.exit(0) }
const anchor = '    "test:dock": "node scripts/test-dock.mjs",\n'
if (!text.includes(anchor)) throw new Error('anchor not found')
text = text.replace(anchor, anchor + '    "test:layout": "node scripts/test-layout.mjs",\n')
writeFileSync(p, text)
const scripts = JSON.parse(readFileSync(p, 'utf8')).scripts
console.log('test:layout =', scripts['test:layout'])
console.log('keys ok:', Object.keys(scripts).length)