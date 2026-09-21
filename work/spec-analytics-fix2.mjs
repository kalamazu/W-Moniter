export default [
  {
    file: 'storage/server.mjs',
    label: '端点详情暴露扁平字段表',
    old: "    responseSchema: response.schema,\n    responseSamples: response.samples,\n    responseSamplesSkipped: response.skipped,",
    new: "    responseSchema: response.schema,\n    // 扁平字段表是给 agent 直接用的：嵌套形状要递归才能回答「有没有 foo.bar」\n    responseFields: schemaToPaths(response.schema),\n    responseSamples: response.samples,\n    responseSamplesSkipped: response.skipped,"
  }
]