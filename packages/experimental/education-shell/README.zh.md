---
description: "可选的原生员工项目编辑面板，支持草稿同步、不可变版本、受控导出与身份清理。"
kind: "package-plugin"
---

# @deepseek-ai/dsh-experimental-education-shell

[English](README.md) | 中文

## 概述

在原生员工工作台中，用本人确认的事实和获准文本创作口播及朋友圈。面板提供私有项目、对话、直接编辑、草稿自动同步、明确的不可变版本保存与受控下载；身份变化时清理旧账号全部私有状态。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

使用[员工启动命令](../education-bundle/README.zh.md#use-this-package)，或在具名 Web Profile 中显式选择 Bundle、身份、Controller 和 Client。面板沿用原生 Gateway、locale、renderer 与 main 槽位布局，存在完整侧栏时另注册导航。员工组合提供独立匿名登录页，并关闭 operator 导航。

画像中的确认事实、表达偏好和禁用承诺分开保存。仅导入明确选择的 TXT/Markdown 文本，确认使用权后选择资料版本创作。模型解释放在对话区，正文放在稿件区。选区修改以 LF 正文的 SHA-256 和 UTF-16 坐标保护范围；稿件初始收起，有正文后展开。

`autoSyncDelayMs` 默认 800、`runPollIntervalMs` 默认 500、`contextRefreshIntervalMs` 默认 2000、`maxTextFileBytes` 默认 1048576。自动同步有序提交并保留较新的编辑，中文组合输入期间暂停；失败后不自动循环重试。来源撤权会隐藏依赖正文，通过跨页通知和可见页面授权刷新复核。明确清空草稿可在同一项目建立安全空上下文，正式历史继续保留。

面板仅列出获准项目。新建或打开项目、编辑纯文本，选择“同步草稿”或“保存正式版本”。正式保存先同步本地正文，再传入已确认的草稿 revision 与保留的最新正式版本指针。查看历史不修改草稿，明确恢复才替换草稿且不改变已有正式版本。未同步正文在切换项目、新建、恢复或注销前要求明确放弃；关闭仍有未同步内容或未知写入的页面时，使用浏览器标准离页保护。

编辑器有未同步内容时禁用草稿导出。版本导出使用当前明确查看的不可变版本，两者都经精确 Controller 下载路径和员工 cookie，不传文件路径或查询令牌，也不回退到原生 Session ZIP。HTTP 路径相对于当前文档，与 Connection 浏览器传输一致；部署代理必须一致转发身份和 API 路径。

冲突时保留编辑内容，提示先复制或同步，再重新读取服务器草稿。结果未知时停止后续写入并保留 request id、参数及完成处理。“核验原请求结果”查询回执，null 仍表示未知；“重试原请求”先再次查询，否则使用相同参数和键重发。恢复草稿同步结果不会自动追加版本，正式保存始终是明确操作。

<a id="understand-the-implementation"></a>
## 理解实现

`EducationWorkspace` 是浏览器包内部对象，不依赖 React 或数据库。不可变快照通过 renderer 注入的 observable hook 到达组件，组件只接收普通回调和框架派生 props，不持有 Cordis Context、传输服务或自制订阅 hook。CSS Modules 使用原生语义主题 token，所有界面文案归类型化中英文词典；应用级 Toast 在主面板导航后仍然存在。

明确登录、注销、跨页身份通知及已确认的身份失效，会在新身份数据出现前清理列表、草稿、预览、反馈与待核验写入。身份和项目作用域取消 HTTP 读取及跟随流，generation 检查丢弃迟到的单次响应和下载。窗口获得焦点或 Connection reset 时复核身份，单纯网络中断不会丢弃未同步正文。项目正文和凭证不写入 localStorage、IndexedDB 或浏览器草稿缓存；卸载移除槽位、事件监听、Remote 贡献及私有状态。

<a id="further-exploration"></a>
## 深入探索

- [Controller 请求与受控导出](../education-controller/README.zh.md)
- [业务事务规则](../education-storage-sqlite/README.zh.md)
- [Client 分层](../../../docs/subsystems/web-client.zh.md)与[原生槽位](../../../docs/subsystems/slots.zh.md)
- [状态与组件测试](tests/model.client.spec.ts)、[原生浏览器测试](tests/native-browser.e2e.ts)

<a id="model-experience"></a>
## 模型体验

无；编辑面板不构造模型输入、工具或 Session 事件。

#### KV 缓存影响

无；正文仅传给获准的业务操作与下载。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- Client 不把私有草稿或未知请求缓冲写入 localStorage/IndexedDB。强制重载可能丢失未同步内容；已确认草稿和持久运行从服务器重开。
- 项目和版本每页请求三十项，所选仓储的分页上限必须允许该请求。资料与对话读取使用配置的仓储分页上限。
- 生成依赖已配置的原生模型 Provider。生成草稿仍可编辑，正式保存始终由用户明确触发。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

执行 `node node_modules/vitest/vitest.mjs run packages/experimental/education-shell/tests` 检查本地状态、HTTP 适配与原生槽位组件。浏览器测试前先构建此包，再执行 `DSH_SNAPSHOT=replay node node_modules/vitest/vitest.mjs run --config packages/experimental/education-shell/vitest.browser.config.ts packages/experimental/education-shell/tests/native-browser.e2e.ts`。默认使用已安装的 Edge，`EDUCATION_BROWSER_CHANNEL` 可选择其他 Playwright channel。测试创建独占临时业务库，并将窄屏图像保存在 `.cache/education-native-client-tests`。

</details>
