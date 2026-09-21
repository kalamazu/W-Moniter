export default [
  {
    file: 'F:/code/chrome/package.json',
    label: 'package.json 增加 test:realtime',
    old: `    "test:analytics": "node scripts/test-analytics.mjs",`,
    new: `    "test:analytics": "node scripts/test-analytics.mjs",
    "test:realtime": "node scripts/test-realtime.mjs",`
  }
]