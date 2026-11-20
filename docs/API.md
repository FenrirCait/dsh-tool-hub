# HTTP API（2.0）

## 路径

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /tool-hub/api/snapshot | 兼容 1.x；快照 |
| POST | /tool-hub/api/op | 兼容 1.x；分发一个 op |
| GET | /tool-hub/api/v1/snapshot | 同快照，2.0 客户端用 |
| POST | /tool-hub/api/v1/op | 同分发，2.0 客户端用 |

v1 与旧路径共用同一实现；新增字段只增不改，破坏性变更才升 v2。

## 信封

成功：{ "ok": true, "data": ... }
失败：{ "ok": false, "error": { "code": "string", "message": "string" } }

## 门禁

1. 同源检查（Host/Origin）先于一切；
2. connection.requestRejection 每请求现取，不缓存；
3. 拒绝统一 401/403 + 上面的 error 信封，不泄漏内部细节。

## op

op 清单以 Registry 为唯一真源：每个 DomainModule 声明自己的 ops（id/write/audit/confirm/note）。
分发器只认登记过的 op；未登记返回 bad-op。confirm 为 true 或 "reset" 的 op 必须带对应载荷。

## 审计

写类 op 追加一行到 history.jsonl（op、ok、audit、时间、短标识），超过 2 MB 截断保留新半段；
不记录 payload 正文，避免把凭据写进日志。
