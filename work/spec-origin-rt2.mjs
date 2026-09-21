export default [
  {
    file: 'F:/code/chrome/scripts/test-origin.mjs',
    label: 'origin 请求处理器改成 async（等 body 收完）',
    old: '  const server = createServer((req, res) => {',
    new: '  const server = createServer(async (req, res) => {'
  },
  {
    file: 'F:/code/chrome/scripts/test-origin.mjs',
    label: 'json-echo 等 body 到齐',
    old: "    if (path === '/api/json-echo') {\n      // 请求体带 extra 才多给一个字段",
    new: "    if (path === '/api/json-echo') {\n      // body 是异步到的：不等它收完，读到的就是空对象\n      await new Promise((resolve) => {\n        if (req.readableEnded) return resolve()\n        req.on('end', resolve)\n        req.on('error', resolve)\n      })\n      // 请求体带 extra 才多给一个字段"
  }
]