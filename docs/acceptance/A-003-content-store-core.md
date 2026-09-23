# A-003：ContentStore Core 验收

状态：通过  
对应：[T-003](../tasks/T-003-content-store-core.md)  
实现：`2014701`

`npm run test:content` 通过：2MiB 二进制响应生成 manifest 和多个内容块，并能按 hash 完整读取。内容块与 manifest 都采用原子写入；相同 hash 复用已有 manifest。
