---
description: "隔离开发 Profile 中通过受控 cookie HTTP 路由提供持久员工登录、本人身份与注销。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-education-identity

[English](README.md) | 中文

## Summary

员工可通过三个受控 HTTP 接口登录、读取本人当前身份和注销。每次请求检查 Host、Origin 与当前持久化登录状态。密码验证沿用原型的 scrypt 和用户名规则，仓储只保存令牌摘要。Provider 限制认证资源使用，并在卸载时等待已接受的验证收敛。

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

在隔离 headless Profile 中选择[教育业务 Bundle](../education-bundle/README.zh.md)，并显式启用其身份层。加载 Provider 前，通过受控 Host 设置创建组织和员工凭证。配置的组织必须存在且启用。本包没有开放公众注册或账号管理接口。

### Configuration

[Provider 配置](src/types.ts)定义以下部署上限。远程浏览器 Origin 必须使用 HTTPS；明文 HTTP 仅允许明确的回环地址。配置 Origin 不接受路径、凭证或查询字符串。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `organizationId` | 必填 | 已存在且启用的组织 UUID。 |
| `publicOrigin` | 必填 | 用于 Host 和变更 Origin 检查的准确浏览器 Origin。 |
| `sessionLifetimeMs` | `43200000` | 持久登录的绝对有效期，60000 到 604800000 毫秒。 |
| `loginAttempts` | `10` | 每个直接地址和规范用户名在窗口中的尝试次数。 |
| `loginWindowMs` | `900000` | 尝试窗口，1000 到 86400000 毫秒。 |
| `maxConcurrentVerifications` | `4` | 并发密码验证上限，1 到 64。 |
| `maxThrottleKeys` | `10000` | 尚未过期的限流条目上限，2 到 100000。 |
| `maxAuthRequestBytes` | `4096` | HTTP 认证完整请求体缓冲上限，256 到 65536 字节。 |
| `adaptConnection` | `false` | 显式启用员工 Peer 准入；Connection 必须设置 `requireRequestPolicy: true`。 |
| `loginShell` | `false` | 提供公开员工登录页并重定向匿名首页访问；要求启用 `adaptConnection`。 |
| `maxPeers` | `1000` | 原生有效登录作用域上限，1 到 100000。 |
| `peerSweepIntervalMs` | `1000` | 空闲授权复查间隔，10 到 60000 毫秒。 |

### HTTP and lifecycle

`POST /education/auth/sign-in` 只接受 username/password JSON，并要求配置的 Origin。`GET /education/auth/me` 只返回当前员工公开 DTO。`POST /education/auth/sign-out` 要求变更 Origin，撤销当前有效登录并清理 cookie。响应使用 `Cache-Control: no-store`；cookie 值只写响应头，不进入响应 JSON。无效、停用、过期或已撤销登录不能认证。

启用 `loginShell: true` 后，匿名首页请求重定向到 `GET /education/sign-in`。该精确路由提供带 nonce 内容策略的中英文登录文档，向同源认证路由提交，并在成功后重新载入原生工作台，不暴露原生 operator 启动元数据。[员工启动辅助命令](../education-bundle/README.zh.md#use-this-package)同时选择此配置及受限 Web roster。

Cookie 使用独立于原型和原生 operator 的名称，包含 HttpOnly、SameSite=Strict、Path=/ 和绝对 Max-Age。HTTPS 增加 Secure 与 `__Host-` 前缀。有效登录可跨重启保留；卸载停止新验证并等待已接受操作，不在晚到结果后创建登录。单次注销不影响其他员工或同员工的其他登录。

受控设置可使用 [credentials.ts](src/credentials.ts) 中的 Node 凭证辅助函数。密码保留空格和大小写。新凭证密码至少十二个字符；用户名按 NFKC、trim、lowercase 规范化，再使用原有 ASCII 规则。员工 DTO 不返回原始令牌、密码或凭证 hash。

显式启用的 [Connection 适配](src/connection.ts)提供 Host 侧 `ctx.educationPeers.actor(peer)` 及生命周期信号。一个持久登录使用稳定 Peer；员工及重复登录分别拥有作用域。注销立即中止对应作用域。每次身份读取重新校验持久授权，空闲过期与账号撤权按配置间隔复查。卸载中止作用域、等待释放并撤销策略。适配同时安装[资源策略](src/authorization.ts)；完整原生企业 UI/Profile 仍是独立交付。

`ctx.educationAuthorization` 默认拒绝未知操作。原生 `session.page`、`session.follow`、`session.projections` 仅允许访问本人有效绑定；子 Agent 地址、全局列表/搜索/控制、自由创建、prompt/cancel、原始文件上传/下载及运维命名空间保持关闭。作用域事件要求显式接管的有效 Agent，其实际主体和 Session 标识必须与注册表及绑定一致。全局事件无明确功能授权时拒绝。Gateway 在初始/重连投递、队列出队及回应结算前重新授权，隐藏私有 Host home 元数据。

可信功能插件通过 `register()` 注册资源检查。授权随调用方 fiber 释放，撤销会关闭现有 Peer 作用域，避免空闲订阅保留旧权限。`bindAgent()` 接管受控原生句柄，验证存活身份并提交同归属绑定；失败时等待句柄释放，不宣称跨库事务。调用方必须使用受限验证设置创建句柄，不得驱动未绑定 Agent。`invalidateSession()` 在同一事务提交绑定撤销与审计，关闭该员工当前 Peer 作用域，再释放受管 Agent。其他员工保持连接；有效 cookie 可重连并重新授权。拒绝审计只记录 Actor 标识及固定原因/类别，不记录请求参数或私有正文。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节 — 点击展开</summary>

[Provider](src/index.ts)读取当前账号凭证，在数据库事务外验证加盐 scrypt，再由持久登录创建事务重新检查授权。本人身份通过选定[仓储](../education-platform/src/repository.ts)解析 cookie 摘要。[HTTP 适配](src/http.ts)使用 Connection 的有界 Node-to-Fetch 桥接和可释放的精确 Web 路由，只返回稳定错误类别，不序列化内部原因或凭证值。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Platform](../education-platform/README.zh.md) — 可信 Actor 与公开 DTO 要求。
- [SQLite](../education-storage-sqlite/README.zh.md) — 持久登录和资源授权。
- [Bundle 用例](../education-bundle/tests/identity-loader.spec.ts) — 真实源码/构建 Profile HTTP 验证。

-----

<a id="model-experience"></a>
## Model Experience

None, as 身份认证不构造模型提示词、工具或 Session 事件。

#### KV Cache effect

无；凭证和 cookie 不进入模型输入。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

资源策略保护显式选择的员工组合；部署和账号管理仍属于独立的 Host 职责。

- 真实源码/构建 Profile 已验证原生历史、实时跟随、作用域事件隔离、绑定补偿、原始上传/导出拒绝及撤权。[业务 Controller](../education-controller/README.zh.md)负责受控下载；各功能授权验证自身的外部字段及关联资源。
- 尚未提供公众注册、生产邀请/重置管理或管理员访问规则。
- Gateway 已将 Peer 生命周期信号接入逻辑流和事件代际；有效身份本身不授予私有资源权限。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
