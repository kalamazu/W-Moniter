export default [
  {
    file: 'storage/server.mjs',
    label: '扫描列补 request_id',
    old: "const ENDPOINT_SCAN_COLUMNS = [\n  'seq', 'method', 'host', 'path', 'query', 'status', 'duration_ms', 'ttfb_ms',\n  'encoded_len', 'decoded_len', 'mime_type', 'resource_type', 'url', 'from_cache',\n  'from_sw', 'failed', 'req_body', 'body_hash', 'body_state', 'body_size',\n  'start_ts', 'target_type', 'frame_url', 'initiator_stack', 'initiator_type'\n]",
    new: "const ENDPOINT_SCAN_COLUMNS = [\n  'seq', 'method', 'host', 'path', 'query', 'status', 'duration_ms', 'ttfb_ms',\n  'encoded_len', 'decoded_len', 'mime_type', 'resource_type', 'url', 'from_cache',\n  'from_sw', 'failed', 'req_body', 'body_hash', 'body_state', 'body_size',\n  'start_ts', 'target_type', 'frame_url', 'initiator_stack', 'initiator_type',\n  // request_id 是重定向链的分组键（同一 requestId 的多跳），漏了它关联分析就只能瞎猜\n  'request_id'\n]"
  },
  {
    file: 'storage/server.mjs',
    label: 'blob → Buffer（Uint8Array.toString 不是解码）',
    old: "function readBodyBytes(hash) {\n  const row = db.prepare('SELECT size, stored, blob FROM bodies WHERE hash = ?').get(norm(hash))\n  if (!row || !row.stored || !row.blob) return null\n  const bytes = row.blob instanceof Uint8Array ? row.blob : new Uint8Array(row.blob)\n  return { bytes, size: row.size }\n}",
    new: "/**\n * sqlite 的 blob 是 Uint8Array，不是 Buffer —— 对它调 .toString('utf8')\n * 得到的是 \"1,2,3\" 这种逗号串，不是文本。这里统一包成 Buffer 再交出去，\n * 免得每个调用点各错一遍（这个坑在 HAR、JSONL、schema 抽样上同时踩过）。\n */\nfunction readBodyBytes(hash) {\n  const row = db.prepare('SELECT size, stored, blob FROM bodies WHERE hash = ?').get(norm(hash))\n  if (!row || !row.stored || !row.blob) return null\n  const raw = row.blob\n  const bytes = Buffer.isBuffer(raw)\n    ? raw\n    : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)\n  return { bytes, size: row.size }\n}"
  },
  {
    file: 'storage/server.mjs',
    label: '回归汇总：状态码按全局集合算',
    old: "  const changedKeys = new Set(changed.map((item) => item.key))\n  return {",
    new: "  const changedKeys = new Set(changed.map((item) => item.key))\n  // 状态码的增删按「全量集合」算，而不是只看 changed：\n  // 一个新端点带着新状态码进来，「这个状态码是新的」这件事同样成立。\n  const baseStatuses = new Set(base.endpoints.flatMap((item) => item.statuses))\n  const currentStatuses = new Set(current.endpoints.flatMap((item) => item.statuses))\n  return {"
  },
  {
    file: 'storage/server.mjs',
    label: '回归汇总：newStatusCodes 用全局差集',
    old: "      newStatusCodes: [...new Set(changed.flatMap((item) => item.statuses.added))].sort(),\n      droppedStatusCodes: [...new Set(changed.flatMap((item) => item.statuses.removed))].sort(),",
    new: "      addedEndpointKeys: added.map((item) => item.key),\n      removedEndpointKeys: removed.map((item) => item.key),\n      newStatusCodes: [...currentStatuses].filter((item) => !baseStatuses.has(item)).sort(),\n      droppedStatusCodes: [...baseStatuses].filter((item) => !currentStatuses.has(item)).sort(),"
  }
]