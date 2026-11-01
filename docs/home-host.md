# 家庭主机拓扑与隔离 superagent 试验

产品名是 **DSH-haibo**。小红书 Muse Agentic 架构只作设计参考，见 [README 致谢](../README.md#致谢与设计来源)。本文不改安装器，也不把上游原型并进 haibo。

## 拓扑

- **家庭主机**是唯一长期运行的 DSH runtime。手机和笔记本只做客户端（浏览器或桌面壳连到这台主机），不各自再养一套长期 runtime。
- 主机上的代码就是这份 [smile-xuc/DSH-haibo](https://github.com/smile-xuc/DSH-haibo)。默认 profile 仍用 `node bin/install.mjs install` 写入 `# >>> dsh-muse >>>` 标记块。不 fork DSH 内核。
- haibo 插件留在**默认家庭主机 profile**上，继续做治理（WorkUnit、副作用台账、护栏、证据、评测）。

## 隔离 superagent 试验

可选。单独建一个 DSH profile，名字用 `superagent`。按上游 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的 [SETUP.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/SETUP.md) 和 [docs/006-deployment.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md) 安装到这个 profile。

不要做的事：

- 不要把原型装进 haibo 的标记 cordis 块。
- 不要把 `dsh-superagent-prototype` 的源码或构建产物拷进本仓库的 `plugins/`，也不要改 `bin/install.mjs` 去挂它。

v0 试验默认（允许破损）：

| 项 | 值 |
|---|---|
| DSH tip | **`0.2.1-rc.5`**（tag `dsh-v0.2.1-rc.5`） |
| Source | 只开 **GitHub**。飞书插件保持关闭 |
| 接单 | **`acceptMode: observe`**（评估并记下研判，不接单） |

原型 `SETUP.md` 的示例命令仍写 `@deepseek-ai/dsh@0.2.1-rc.3`。本试验改用 `0.2.1-rc.5`。原型 `engines.dsh` 是 `^0.2.1-alpha.2`，默认 semver 已包含 `0.2.1-rc.5`。

原型 [README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md) 的免责声明：这是研究代码，不是正式产品，也**不等于**文章 *Exploring Super-agent Design: Towards a More Autonomous Agent System* 里的实现。文章里的一些设计尚未做进原型。

`acceptMode` 在原型面板的 Eval 设置里，取值 `off` / `observe` / `auto`。`observe` 的含义见原型 `src/core/model.ts`：主动候选仍会评估并留下 Decision 会接受什么，但实际不接单。

## 飞书 Source（v0 范围内）

飞书在 v0 范围内，路径是上面那个**隔离 profile**，不是 haibo 里的新插件。本仓库不实现飞书插件。

原型已经带飞书 Source：构建入口 `feishu-watch`（`package.json` 导出 `./feishu-watch`），说明见 [docs/008-cookbook.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/008-cookbook.md)（现成 Source 的写法对照）和 [docs/006-deployment.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md)（可选飞书机器人、`dsh-superagent-feishu` 条目）。

启用顺序：

1. 隔离 profile 上 GitHub-only + `acceptMode: observe` 先跑通（能看到评估记录，且没有自动接单）。
2. 只在该 profile 打开飞书 Source（`dsh-superagent-feishu` / `feishu-watch`）。不要改 haibo 默认 profile 的标记块。
3. haibo 插件继续只治理默认家庭主机 profile。

## CI tip 与 cordis

haibo 的 plugin-behavior CI 把 `@deepseek-ai/dsh-*` 钉在 **`0.2.1-rc.5`**。对照 tag `dsh-v0.2.1-rc.5` 的已发布 peer：这些包要 `@deepseek-ai/cordis@~4.0.5`，`@deepseek-ai/schemastery@~3.18.5`，`dsh-llm` / `dsh-storage-domain` 依赖 `zod@4.4.3`。schemastery `3.18.5` 依赖 `@deepseek-ai/cosmokit@~1.8.6`。因此 CI 里的 cordis `4.0.5`、cosmokit `1.8.6`、schemastery `3.18.5`、zod `4.4.3` **保持不动**。npm 上的 `cordis@4.0.6-alpha.1` 不在 `~4.0.5` 里，也不追。

插件 `peerDependencies` 里的 `^0.2.1-alpha.1` 已经匹配 `0.2.1-rc.5`（同一 `0.2.1` 预发布元组，不需要 `includePrerelease`），所以没有再追加 `|| ^0.2.1-rc.5`，也没有写入 `0.2.2-alpha`。

隔离试验另有一条 peer，**不**回写到 haibo：原型 `package.json` 把 `@deepseek-ai/cordis` 和 `@deepseek-ai/schemastery` 钉成精确的 `4.0.5-alpha.1` 与 `3.18.5-alpha.1`。稳定版 `4.0.5` / `3.18.5` 满足不了这两条。试验接受破损；不要为此把 alpha cordis 塞进 haibo 的标记块或 CI。
