---
description: "私有教育业务资源 DTO 与 Host 仓储要求，适用于组合存储基础的开发人员。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-education-platform

[English](README.md) | 中文

## Summary

Host 调用方可通过显式选定的事务仓储读写员工私有项目。每次私有操作都必须传入服务端解析的 Actor。浏览器可用的类型导出只包含资源 DTO，不包含凭证。本包没有开放 HTTP 或 Remote Controller。

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

`educationRepository.creation` 在同一数据库及 Actor 授权下提供不可变画像、资料版本、固定模型输入、持久运行、对话和原始写回执。`creation-context` 依据扩展原有 `foundation-validation` 分支，旧正式版本不回填。[Controller](../education-controller/README.zh.md)负责外部输入校验，[SQLite Provider](../education-storage-sqlite/README.zh.md)负责事务和迁移。

在隔离的开发 Profile 中选择 [education-bundle](../education-bundle/README.zh.md)。SQLite Provider 就绪后 Host 服务才激活；调用方注入 `educationPlatform`，并在访问其 `repository` 时明确提供 Actor。

### Configuration and imports

服务没有配置字段。Host Provider 实现 [EducationRepository](src/repository.ts)；其中的凭证记录只供身份处理使用。浏览器代码从 `@deepseek-ai/dsh-experimental-education-platform/types` 导入类型，该入口不导出 Node 实现或凭证字段。

仓储写入返回不含秘密的提交结果引用。读取方法单独返回已授权正文。请求结果查询保留原结果，并重新检查当前登录与资源归属。

项目重开包含最新正式版本摘要及本人绑定状态。成果元数据与当前草稿分别提供受权读取，供资源检查和明确来源的导出使用。仓储公开实际字节/分页上限和不含正文的提交后观察；幂等重放及失败事务不发出新提交。[业务 Controller](../education-controller/README.zh.md)通过原生 Gateway 使用这些要求。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节 — 点击展开</summary>

[服务](src/index.ts)仅在 `educationRepository` 存在时激活。[DTO](src/types.ts)区分可编辑草稿与不可变正式版本。[结构化错误](src/error.ts)提供稳定处理类别；传输调用方将其映射为安全响应，不返回内部异常原因。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SQLite Provider](../education-storage-sqlite/README.zh.md) — 事务与部署配置。
- [基础 Bundle](../education-bundle/README.zh.md) — 显式 Profile 组合。
- [架构](../../../docs/architecture.zh.md) — 服务归属与可释放插件。

-----

<a id="model-experience"></a>
## Model Experience

None, as 此 Host 服务与 DTO 不构造模型请求、工具 schema 或 Session 事件。

#### KV Cache effect

无；本包不改变模型可见输入。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

当前基础能力仅供受控 Host 调用方使用。

- 本包尚未实现登录/cookie、员工 Peer 作用域、原生访问授权或 Remote Controller。
- 尚未注册 Client 数据对象或业务面板；类型导出不代表原生 Client 接入已经完成。
- 原生 Session 绑定要求调用方先创建受控 Session，并在关联失败时补偿；两个数据库没有共享事务。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
