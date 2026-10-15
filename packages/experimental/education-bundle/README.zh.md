---
description: "显式原生员工创作工作台，提供私有创作、获准资料与独立业务存储。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-education-bundle

[English](README.md) | 中文

## Summary

在独立业务库中提供员工登录、私有项目、草稿和正式版本，并通过[原生创作面板](../education-shell/README.zh.md)使用本人画像及获准文本资料创作。此显式组合不加入默认编码 Profile。

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

### Enable in development

已安装依赖并执行 `pnpm run build` 后，在仓库根目录运行 `pnpm run start:education`。命令通过具名 `education` Profile 启动原生员工页面，默认地址为 `http://127.0.0.1:3191/`；匿名访问进入独立登录页。首次启动在 `.cache/education-native` 建立业务库、Profile 和受控首个账号，终端只输出 `first-login.txt` 路径，不输出密码。`pnpm run setup:education:native` 仅初始化；`pnpm run start:education:prototype` 保留独立原型。

`deployment.json` 保存组织、业务库和端口。`EDUCATION_NATIVE_HOME` 选择独立数据目录，`EDUCATION_NATIVE_PORT` 覆盖本地端口；不同部署使用不同业务库。`EDUCATION_MODEL_PROVIDER`、`EDUCATION_MODEL` 和 `EDUCATION_MODEL_CREDENTIAL_REF` 选择模型路由、模型与原生凭证引用。`EDUCATION_CREDENTIALS_PATH` 可指定已有原生凭证文件；默认复用用户原生凭证文件，存在 DeepSeek 账号授权时选择 `deepseek-account`，否则选择 `deepseek-official` 与 `DEEPSEEK_API_KEY` 引用。秘密不复制到业务库、浏览器或模型输入。

新增员工时设置 `EDUCATION_BOOTSTRAP_USERNAME` 后运行 `pnpm run add-user:education`。可用 `EDUCATION_BOOTSTRAP_PASSWORD` 提供至少十二字符的密码；省略时生成随机密码。命令复用同一仓储及密码派生规则，并把登录信息写入当前部署的私有 `accounts` 文件，不提供公开注册或员工管理接口。

使用独立 `DSH_HOME`，在 Profile 的 `dsh.profile.bundles` 中，把 `@deepseek-ai/dsh-experimental-education-bundle` 放在原生 Bundle 名称之后。将 `EDUCATION_DATABASE_PATH` 设置为独立数据库的绝对路径。开发工作树必须已安装并构建本包及依赖。包含裸包名的任意 `--patch` 不会把这些包加入 Profile 运行时解析范围。

[Loader 回归](tests/loader.spec.ts)创建含该 Bundle 的独立 headless Profile，并分别以源码和构建产物启动受支持的 `dsh` CLI。用例创建明确标记的合成员工，提交私有草稿与版本，验证归属拒绝，再卸载 Provider 并检查关闭。已构建工作树可执行：

```text
node node_modules/vitest/vitest.mjs run packages/experimental/education-bundle/tests/loader.spec.ts
```

### What you get

[Patch](cordis.patch.yml)添加已就绪的 SQLite 仓储和 Host 调用方。HTTP 认证默认禁用；受控创建账号后，配置 `EDUCATION_IDENTITY_ENABLED=true`、`EDUCATION_ORGANIZATION_ID`、`EDUCATION_IDENTITY_PUBLIC_ORIGIN` 可启用身份组。`EDUCATION_IDENTITY_PORT` 选择回环监听端口，默认 3191。[身份回归](tests/identity-loader.spec.ts)使用系统分配测试端口和真实 cookie 请求。`EDUCATION_CONTROLLER_ENABLED=true` 与 `EDUCATION_CLIENT_ENABLED=true` 在组内选择 Controller 和原生面板。[Client 浏览器测试](../education-shell/tests/native-browser.e2e.ts)使用原生 Web 测试 Profile，并共享身份/API 监听。受控测试开户不等同于生产账号管理。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节 — 点击展开</summary>

Provider 验证数据库后才提供 `educationRepository`。`educationPlatform` 注入该服务，不会在数据库失败或尚未就绪时激活。卸载 Provider 会移除两个活跃服务并关闭数据库。包清单声明 Patch 中每个插件；Profile 的 Bundle 选择让运行时解析器能够取得这些依赖。

设置 `EDUCATION_CONTROLLER_ENABLED=true`，可在显式身份层内启用 [Controller](../education-controller/README.zh.md)。它要求选定必要请求策略的 Connection、身份适配、Session Query 和 Typert。Bundle 不会暗中替换默认 operator 部署。真实 src/lib 用例覆盖原生授权、项目/草稿/版本 RPC、并发冲突、原请求恢复、项目跟随及精确文本导出。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Platform](../education-platform/README.zh.md) — 可信 Host API 与 DTO。
- [SQLite Provider](../education-storage-sqlite/README.zh.md) — 原子写入与配置。
- [应用启动](../../boot/app-boot/README.zh.md) — Profile 与 Bundle 解析。

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through 选定的[创作 Controller](../education-controller/README.zh.md#model-experience)，由其负责模型可见规则及原生 Agent 执行。

#### KV Cache effect

组合不添加提示词前缀；Controller 固定每次完整且获准的输入，并为该输入启动新的无工具原生 Agent。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

启动辅助命令提供显式选择的本地员工组合；部署管理仍由受控 Host 操作完成。

- 每个业务库使用一个应用进程。开户使用本地辅助命令；公开注册、密码重置和生产部署自动化不在当前组合内。
- 员工 Patch 移除运维 UI 入口，并拒绝未授予的 Controller 与事件；默认 Web operator 保持既有组合。
- 原型数据单独保留；外部数据接入和定时同步属于后续阶段集成。
- 普通自动化测试使用合成响应。显式启用的真实模型测试要求授权和持久调用预算；已录制会话可在没有凭证及新增模型调用的情况下回放。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
