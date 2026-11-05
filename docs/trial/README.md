# 隔离 superagent 试验样例

这些文件只给家庭主机上的 **隔离 profile `superagent`** 抄用。安装器不读它们。

- 不要放进本仓库的 `plugins/`。
- 不要写进默认 profile 的 `# >>> dsh-muse >>>` 标记块。
- 不要把令牌、模型密钥或 `gh` 凭据填进这些文件再提交。

步骤在 [docs/home-host.md 的主机自助安装](../home-host.md#host-install)。样例：

试验在设计上是 [Super Agent](../super-agent.md) 的阶段 0（只观察，不接单）。官方 DSH 还缺的能力记在 [上游待办](../upstream-backlog.md)。这两份都是设计，不是本目录已经实现的功能。

| 文件 | 用途 |
|---|---|
| [profile.cordis.patch.example.yml](profile.cordis.patch.example.yml) | 盖住 `superagent` 的 `cordis.patch.yml`。飞书条目保持注释 |
| [settings.observe.example.json](settings.observe.example.json) | 管理 API 要写入的 GitHub Source 与 `eval.mode`。`cli` 在主机上换成 `gh-agent` 的绝对路径 |

对照的上游提交是 [`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`](https://github.com/deepseek-ai/dsh-superagent-prototype/commit/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)（`deepseek-ai/dsh-superagent-prototype` 的 `main`，写这份手册时）。DSH 版本仍是 **`0.2.1-rc.5`**（tag `dsh-v0.2.1-rc.5`），不用原型 `SETUP.md` 示例里的 `0.2.1-rc.3`，也不用 `0.2.2-alpha`。
