---
description: "在隔离 SQLite 数据库中保存私有教育业务草稿与不可变版本，以事务保护归属和请求回执。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-education-storage-sqlite

[English](README.md) | 中文

## Summary

在独立数据库中保存员工私有项目、同步草稿并追加不可变正式版本。写入以同一事务保存请求回执和审计元数据。草稿 revision 或正式版本指针冲突时拒绝写入，不覆盖正文。Provider 在每次私有操作中验证持久化登录状态，并在卸载时释放数据库。

## Table of Contents

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待实现工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在隔离开发环境中选择[基础 Bundle](../education-bundle/README.zh.md)，并设置绝对路径 `EDUCATION_DATABASE_PATH`。初始化在提供仓储前拒绝其他数据库、未来 schema、不完整表或无效外键关联。

### Configuration

[配置解析器](src/index.ts)负责验证以下字段。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | 必填 | 隔离数据库的绝对路径；测试支持 `:memory:`。 |
| `journalMode` | `wal` | 可选 `wal`、`delete`、`truncate` 或 `persist`；部署磁盘需要独立验证。 |
| `busyTimeoutMs` | `1000` | 1 到 60000 毫秒的有限锁等待。 |
| `maxBodyBytes` | `1048576` | CRLF 规范化后的最大 UTF-8 字节数。 |
| `maxTitleBytes` | `200` | 去除首尾空白后的标题或组织名称的最大 UTF-8 字节数。 |
| `maxPageSize` | `100` | 查询分页上限；配置接受 1 到 1000。 |

### Writes and recovery

仓储只将 CRLF 规范化为 LF，保留空格和 Unicode。草稿同步只增加草稿 revision。正式保存同时检查草稿 revision 与最新版本指针，固定正文及当时的依据，不改变草稿 revision。旧的空 `foundation-validation` 依据原样保留；新生成固定画像版本、资料版本、授权修订、运行、策略和上下文指纹。恢复历史版本只更新草稿；随后保存才追加新版本。

业务 schema 单调迁移至第二版，追加不可变画像与资料、当前授权、输入快照、运行占用、对话和回执，并扩展 `moments` 场景。迁移不改写旧正文、正式版本或回执；失败整体回滚。模型调用在事务外执行，每个成果只占用一个进行中运行，取消、失败或中断不提交部分输出。重启只把未结算运行标为中断，不重发模型请求。来源撤权使依赖正文不可读、不可恢复或导出；明确清空当前草稿可在同一项目建立安全的新上下文，历史版本继续保留。

响应丢失后复用原 requestId 与参数。匹配的回执在重新授权后返回不含秘密的原结果；参数不一致时返回 `idempotency-conflict`。`storage-busy` 允许有界同键重试。其他失败保留内部异常原因，传输层不得暴露它。回滚失败时关闭仓储，停止依赖操作。

复制数据库前停止写入并关闭全部连接，将关闭后的文件恢复到另一个目录。回归用例验证该流程后的数量、hash、归属、正式指针和 SQLite 完整性。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节 — 点击展开</summary>

[Schema 初始化](src/schema.ts)在同一迁移事务中维护独立数据库标识与单调版本。复合外键约束组织、owner、项目与成果关联。触发器拒绝更新或删除历史版本。[仓储操作](src/repository.ts)采用短同步事务，不等待外部调用；写入提交前再次授权。[解码](src/codec.ts)验证持久化字段与正文摘要。

`invalidateSessionBinding()` 仅将本人关联改为 `invalid`，并在同一事务提交审计记录。读取及回执重放拒绝失效关联。该操作保留原生日志与当前业务 schema；运行时取消由[身份资源策略](../education-identity/src/authorization.ts)负责。原生 Agent 创建与此数据库不共享事务。

revision 和版本序号在变更前拒绝不安全整数递增。`onProjectCommit()` 仅在新事务提交后发出无正文元数据；观察者失败单独报告，不会将已提交写入误报为失败。项目重开包含当前版本/绑定元数据，外部游标字段无效时归类为输入失败。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Platform 要求](../education-platform/README.zh.md) — Host API 与安全 DTO 入口。
- [基础 Bundle](../education-bundle/README.zh.md) — 隔离 Profile 组合。
- [仓储用例](tests/repository.spec.ts) — 真实事务与恢复证据。

-----

<a id="model-experience"></a>
## Model Experience

None, as 此数据库 Provider 不构造模型提示词、工具或 Session 事件。

#### KV Cache effect

无；保存业务正文不会把它注入模型请求。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

部署与传输限制有明确边界。

- 验证环境为本地磁盘与单业务写进程；尚未核验网络目录或多实例部署。
- 登录 HTTP、凭证校验、Peer 生命周期与原生 Session 授权属于独立身份及 Controller 工作。受控账号创建不等同于员工注册 API。
- 不迁移已有原型 JSON 或原生 Session 数据。Session 绑定本身不授权原生 RPC、文件或事件投递。
- 数据库父目录必须防止其他主体替换文件；文件模式不能在所有平台上建立这项保护。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
