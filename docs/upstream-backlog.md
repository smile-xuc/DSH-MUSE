# 上游待办

官方 DSH 还没有、因而 **DSH-haibo** 只跟踪、不在本仓库里假装已经实现的能力。产品行为以 [家庭主机](home-host.md) 和 [Super Agent 设计](super-agent.md) 为准。本文不改 CI pin，不改安装器，不把原型并进标记块。

对照版本：**DSH `0.2.1-rc.5`**，tag [`dsh-v0.2.1-rc.5`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.5)。原型只读参考是 [dsh-superagent-prototype@8c32a9d](https://github.com/deepseek-ai/dsh-superagent-prototype/commit/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)。下面「rc.5 现状」里写「本次读过」的，是 2026-11-03 对着该 tag 的文件看的。写「审计未找到」的，来自同日审计；本次写文档没有把整棵上游树再扫一遍，刷新时要重做。

2026-11-03 上游 force-push 了 `deepseek-ai/dsh-superagent-prototype` 的 `main`：HEAD 从 `6337fc823ce20251c8de8085948165c81aaa701e` 换成 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`，两边文件树相同（git tree `3efbb036e5a56183c6bf642e2e1856a1f64e7be3`，236 个条目）。

## 状态

| 状态 | 含义 |
|---|---|
| `not-started` | 上游没有，本仓库也没有可用的替代实现 |
| `watching` | 上游没有或只有相邻能力。我们看发布说明，不在 haibo 里造一个半成品去冒充它 |
| `workaround-in-place` | 有一条临时做法，边界写明了。临时做法不是上游能力 |
| `upstream-landed` | 上游已经提供，haibo 可以改去用它。改用法要另一次变更，不在本文自动发生 |

没有第五种状态。不要把「文档里写了约定」标成 `upstream-landed`。

## 怎么刷新

`dsh-upstream-watch` 是这里规定的例行核对，不是本仓库里的 workflow 或脚本。本仓库没有这个名字的文件。

- 时间：每周一、每周四。
- 读 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 最新的 `0.2.1-rc.*` 发布说明和 tag（形如 `dsh-v0.2.1-rc.N`）。tip 要不要跟着改，是另一次决定。haibo CI 的 peer 现在钉在 `0.2.1-rc.5`，见 `.github/workflows/ci.yml` 的 plugin-behavior 作业。刷新文档时不要顺手改这些 pin。
- 在该 tag 上查看下面条目点名的路径。发布说明没提到的，用 tag 上的检索确认，不要用默认分支代替 tag。
- 原型 pin 看 `dsh-superagent-prototype` 的 `package.json` 里 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`。试验继续只读 `8c32a9d`，直到另一次决定更换提交。
- 有变化就改对应条目的「rc.5 现状」和文末变更表，并写上新的 tag。没有变化也在变更表留一行「无变化」即可，避免下次不知道上次看到哪。

要盯的包和笔记（路径相对该 tag 的树根）：

- `packages/client/connection/`（`src/browser-auth.ts`、`src/peer.ts`、README）
- `.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md`
- `.agents/notes/implemented/architecture/2026-10-09-operator-scoped-connect-handshake.md`
- `.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md`
- `packages/bundle/base/cordis.patch.yml`、`packages/bundle/web-app/cordis.patch.yml`
- `packages/subagent/subagent/`（容量与深度的默认值）
- `packages/experimental/agent-team/`、`packages/experimental/agent-team-profile/`
- `apps/cli/reference/README.md`、`docs/user/guide/public-deployments.md`
- 原型 `src/deployment.ts`、`src/core/model.ts`、`package.json`

发现上游已经做了某条，状态改为 `upstream-landed`，在条目里写 tag 和路径。不要在同一次刷新里改 haibo 的运行时代码。

## 清单

负责人都是 Bruce。没有第二负责人。

### UB-1 设备级令牌、配对、吊销

| 项 | 内容 |
|---|---|
| id | UB-1 |
| 项 | 按设备签发、配对、吊销的令牌。一台客户端丢失时可以单独作废，而不是作废整台主机的浏览器会话 |
| 为什么要 | 其他设备只是家庭主机的客户端。现在拿得到的凭据是进程启动 token 换成的签名 cookie，持有者拥有完整工具能力。做不到按设备授权，远程访问就只能靠网络层把人挡在外面 |
| 上游要提供的 | 设备配对、每设备凭据、单独吊销、登出。多用户若要做，也属于这一条，而不是 haibo 自己在 cookie 旁边再签一种 |
| rc.5 现状 | 本次读过。只有启动 token 换签名 cookie（`packages/client/connection/src/browser-auth.ts`；[2026-08-24 笔记](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md)）。该笔记写明没有 logout；全局作废办法是删掉 `client-connection/browser-session` 记录并重启进程。另有操作者范围的 `GET /connect?token=` 握手（[2026-10-09 笔记](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/.agents/notes/implemented/architecture/2026-10-09-operator-scoped-connect-handshake.md)），以及 peer 主体加 `dsh-api-remote-access` 的角色（[2026-10-12 笔记](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md)）。没有配对，没有多用户，没有 logout |
| 临时做法 | 不造第二套令牌。远程只走 TLS 加反代或私人网络，公开前加代理鉴权。见 [客户端设备](home-host.md#client-devices) 与 [设计红线](super-agent.md#red-lines) |
| 怎么跟 | `dsh-upstream-watch`。看上面三篇笔记和 `packages/client/connection`。若要上游单独立项，标题围绕 device pairing / per-device revoke / logout，别把「请让 cookie 权限变小」写成含糊的功能请求。尚未开 issue |
| 状态 | `watching` |
| 负责人 | Bruce |

### UB-2 桌面或原生客户端的「连接到远程 DSH」

| 项 | 内容 |
|---|---|
| id | UB-2 |
| 项 | 桌面或原生客户端以「连接一台远程 DSH」为模式，而不是在本机再起一份长期 runtime |
| 为什么要 | 手机和笔记本应是家庭主机的客户端，用同一套 harness，而不是每台机器各跑一个常驻 DSH |
| 上游要提供的 | 一个明确的远程连接模式：填主机地址、完成认证、断开后不再在本机执行 |
| rc.5 现状 | 浏览器经域名访问是有的，见 tag 上的 [public-deployments.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/docs/user/guide/public-deployments.md) 与 CLI 的 `--public-url` / `--trusted-host`。原生「connect to a remote DSH」：2026-11-03 审计未找到。该审计没有搜遍每个客户端包，**待核对**。本次写文档只确认了 haibo 自己的 `desktop/README.md`：那是本机 WKWebView 壳，读取官方 `dsh web:` URL 并交换 cookie，不是远程连接模式。上游客户端包本次没有逐个打开 |
| 临时做法 | 其他设备用浏览器打开主机公布的 HTTPS 地址。桌面壳继续只跑在主机上。见 [客户端设备](home-host.md#client-devices) |
| 怎么跟 | `dsh-upstream-watch`。除了发布说明，还要在新 tag 上检索客户端与 `apps/` 里的 remote / connect 字样。未搜完之前保持「待核对」，不要改成 `not-started` 的绝对口气，也不要改成 `upstream-landed` |
| 状态 | `watching` |
| 负责人 | Bruce |

### UB-3 在线状态：设备列表、心跳、谁在线

| 项 | 内容 |
|---|---|
| id | UB-3 |
| 项 | 主机知道哪些客户端在线，客户端能看见彼此的连接状态 |
| 为什么要 | 目标拓扑里，其他设备是同一台主机的客户端，最好能看见彼此是否连着。主机停机时也要有一致的「离线」表现，见 UB-7 |
| 上游要提供的 | 设备列表、心跳、在线状态，以及外部插件若要自己做，需要被保证的生命周期钩子 |
| rc.5 现状 | 2026-11-03 审计结论是未找到 presence / device list / heartbeat / online status。本次重读了 [`packages/client/connection/src/peer.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/client/connection/src/peer.ts)：它定义一个 Peer（固定 principal、interactions、scope、abort 寿命），文件里没有 WebSocket，也没有 duplicate-attach 字样。2026-10-09 握手笔记写明 loader 测试覆盖 duplicate attachment，测试文件是 `packages/api/gateway/tests/operator-connect.host.spec.ts`。本次没有打开该测试，duplicate attach 的具体条件**待核对**。不要把「peer.ts 里拒绝了第二条 WebSocket」写成已读事实 |
| 临时做法 | 插件路径在原则上说得通：自建 webserver 路由加一个 cordis 服务，记最后一次见到的客户端。外部插件能否挂上连接建立和断开，**未验证**。在这件事核对完之前，不在 haibo 里做半套在线灯。客户端的离线表现先用 UB-7 的约定 |
| 怎么跟 | `dsh-upstream-watch`。检索 presence、heartbeat、device list。同时看 `packages/client/connection` 与 gateway 测试是否对外暴露挂钩。未验证的钩子不要标成 `workaround-in-place` |
| 状态 | `watching` |
| 负责人 | Bruce |

### UB-4 自建中继与 NAT 穿越

| 项 | 内容 |
|---|---|
| id | UB-4 |
| 项 | DSH 自己提供的中继，或内建的 NAT 穿越，使家里的主机不必有公网端口 |
| 为什么要 | 其他设备要经过域名或中继连到家庭主机。主机在 NAT 后面 |
| 上游要提供的 | 自建中继，或一等公民的穿透。在那之前，官方只提供反代部署方式 |
| rc.5 现状 | 本次读过 CLI 与 public-deployments。没有内建中继或 NAT 穿越。有的是反代：`--public-url` 只公布地址，`--trusted-host` 放行浏览器看见的主机名，`--tls-cert` / `--tls-key` 让监听器自己提供 HTTPS。webserver 绑定一个具体地址；`0.0.0.0` 与 `::` 会在启动时报 usage error 并拒绝（`packages/bundle/web-app/src/startup.ts` 的 `isWildcardHost`）。笔记与 CLI 都写明认证本身不配置转发头 |
| 临时做法 | 中继跑在 DSH 外面。临时选择是 Tailscale、Caddy 加域名 TLS，或 Cloudflare Tunnel。三者都不是本仓库的配置，也没有在此验证。自建中继推迟。端口只对反代或私人网络开放。见 [客户端设备](home-host.md#client-devices) |
| 怎么跟 | `dsh-upstream-watch`。看 `public-deployments` 与 CLI web 旗标有没有 relay、hole-punch、ICE 一类字样。没有就保持本条。不要把 Tailscale 写进 DSH 的安装器 |
| 状态 | `workaround-in-place` |
| 负责人 | Bruce |

### UB-5 看门狗

| 项 | 内容 |
|---|---|
| id | UB-5 |
| 项 | 文章里那种看门狗：主代理的会话之外，另有一方盯着它 |
| 为什么要 | 只在将来若要照文章做「会话外监督」时才需要。当前 Super Agent 设计明确不把看门狗放进阶段 0–2 |
| 上游要提供的 | 一个会话外、能观察主代理且权限小于主代理的监督者。不是再开一个持有同一枚 cookie 的客户端 |
| rc.5 现状 | 2026-11-03 审计未在 rc.5 找到。原型 `8c32a9d` 的 README 声明自己不等于该文章的实现；架构文档的组成是 Runtime、Engine、Assessor、Executor、Source，没有单独的 Watchdog 类。本次没有把「watchdog」在整棵树里再搜一遍，**待核对** |
| 临时做法 | 不建。试验里可选的每小时检查是操作者自己的 DSH profile 去看 `scripts/dsh-superagent status`（见 home-host），那是人的巡检提示，不是看门狗 |
| 怎么跟 | `dsh-upstream-watch`。发布说明与原型变更日志里看 watchdog / supervisor。没有则保持 `not-started` |
| 状态 | `not-started` |
| 负责人 | Bruce |

### UB-6 异步 `start()` / `stop()` 全双工切换

| 项 | 内容 |
|---|---|
| id | UB-6 |
| 项 | 文章中的异步 ReAct：`start()` / `stop()` 全双工地换掉正在跑的代理 |
| 为什么要 | 若 Super Agent 的 Worker 要在同一进程里换执行方式，需要知道 rc.5 的子代理是不是这件事 |
| 上游要提供的 | 若子代理并不等于该文章设计，就要那个独立的切换，而不是让 haibo 用子代理去模拟 |
| rc.5 现状 | 本次读过。`packages/bundle/base/cordis.patch.yml` 默认挂着 `subagent`、`tool-subagent`（工具名 `subagent`）、`tool-subagent-fork`（工具名 `subagent_fork`），没有单独的总开关。`maxActiveSubagents` 默认 8、`maxDepth` 默认 1 写在 `packages/subagent/subagent/src/index.ts` 的 schema，不在 patch 里写成数字。实验性 agent-team 在 `packages/experimental/agent-team` 与 `agent-team-profile`；该 profile 的 patch 把四条 subagent 工具设为 `disabled: true` 再插入 team。base 与 web-app 的 patch 不插入 agent-team。没有找到名为 `start()` / `stop()` 的全双工切换旗标（只看了上述文件，未全库检索）。这是否等于文章里的异步 ReAct，**未验证** |
| 临时做法 | Super Agent 不用子代理或 agent-team 当执行器。执行仍是隔离 profile 里的原型，并且阶段 0 不接单。见 [设计的实施顺序](super-agent.md#phases) |
| 怎么跟 | `dsh-upstream-watch`。看 subagent README 与 agent-team-profile 的 patch。只有上游写明它实现了该文章的切换，才把「未验证」划掉 |
| 状态 | `watching` |
| 负责人 | Bruce |

### UB-7 主机离线时客户端怎么表现

| 项 | 内容 |
|---|---|
| id | UB-7 |
| 项 | 主机停了以后，客户端的约定行为 |
| 为什么要 | 只有家庭主机在执行。主机不在时，不能让笔记本或手机改去本地执行，也不能让触发继续跑 |
| 上游要提供的 | 客户端能区分「连不上这台主机」和「主机在、认证失败」。在 UB-2、UB-3 落地之前，上游没有这个状态 |
| rc.5 现状 | 没有主机离线协议。连不上就是连不上（未在空网络上复测，行为按常规 TCP/HTTP 理解，**未验证**具体错误文案） |
| 临时做法 | 约定，没有实现：客户端显示离线，并只给出只读提示（上次看见的地址、不要在本机另起 DSH）。触发和任务随主机停止。不在客户端排队补跑。人回到主机上再看阶段 0 的 Decision |
| 怎么跟 | 这是 haibo 的约定，不是等上游的一项功能。UB-2 或 UB-3 落地时再改这条的现状。在那之前保持约定，不要写客户端 |
| 状态 | `not-started` |
| 负责人 | Bruce |

### UB-8 上游真正的只读 GitHub 模式

| 项 | 内容 |
|---|---|
| id | UB-8 |
| 项 | 原型 setup 能在仓库只读时通过，或 DSH / `gh` 能给出「仅此仓库、只读」的凭据 |
| 为什么要 | 阶段 0 只观察、不推送。但原型不让只读账号完成 setup |
| 上游要提供的 | `resolveDeployment` 在只读时成功，或一条跳过 push 检查的只读模式。更好是一枚只能读 `smile-xuc/DSH-haibo` 的凭据。GitHub App 不能代替：上游要读用户通知 |
| rc.5 与原型现状 | 这条的门在原型，不在 rc.5 的浏览器认证里。本次读过原型 `8c32a9d` 的 `src/deployment.ts`：`gh api repos/<remote> --jq '{name, push: .permissions.push}'`，`push !== true` 时抛 `SetupError('repositoryReadOnly')`。home-host 已写明没有「只读令牌」或「跳过 push 检查」的接口，以及 `gh auth login` 的最低 scope 是 `repo`、`read:org`、`gist`。rc.5 本身不提供这个 GitHub 模式 |
| 临时做法 | 安全来自两处，而不是来自只读令牌：代理账号只被加进 `smile-xuc/DSH-haibo` 这一个仓库，且 `eval.mode` 保持 `observe`（不接单、不推送）。Write 角色只为了通过 setup。不要把这个账号加到其他仓库，不要改成 `auto`。见 [home-host](home-host.md#host-install) |
| 怎么跟 | 看原型 `src/deployment.ts` 与 `SETUP.md`。DSH 发布说明里若出现 GitHub 只读连接器，一并记上。要开 issue 就开在原型仓库，说明 observe 试验需要 `repositoryReadOnly` 也能完成 setup。尚未开 issue |
| 状态 | `workaround-in-place` |
| 负责人 | Bruce |

### UB-9 原型 peer 与 haibo CI 的 cordis 不一致

| 项 | 内容 |
|---|---|
| id | UB-9 |
| 项 | 原型把 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 钉在 `4.0.5-alpha.1` 与 `3.18.5-alpha.1`。haibo CI 用稳定版 `cordis@4.0.5`、`schemastery@3.18.5` |
| 为什么要 | 隔离试验要把原型 link 进 `0.2.1-rc.5` 的 profile。alpha 精确版本和 CI 的 `~4.0.5` 对不上，面板可能报插件不兼容 |
| 上游要提供的 | 原型改为接受 rc.5 已发布的那组 peer（cordis `~4.0.5`、schemastery `~3.18.5`），或 rc 线发布与原型相同的 alpha 并声明兼容。在那之前不要把 alpha 写进 haibo |
| 现状 | 本次读过原型 `8c32a9d` 的 `package.json`：`@deepseek-ai/cordis` 为 `4.0.5-alpha.1`，`@deepseek-ai/schemastery` 为 `3.18.5-alpha.1`。haibo 侧见 [CI tip 与 cordis](home-host.md#ci-tip) 与 `.github/workflows/ci.yml`：`@deepseek-ai/cordis@4.0.5`、`@deepseek-ai/schemastery@3.18.5`，DSH 包为 `0.2.1-rc.5`。稳定版满足不了原型这两条精确 pin。试验接受破损 |
| 临时做法 | 破损只留在隔离 `superagent` profile。不把 alpha cordis 塞进 haibo 标记块或 CI。tip 保持 `0.2.1-rc.5`，不追 `cordis@4.0.6-alpha.1`，不改成 `0.2.2-alpha` |
| 怎么跟 | `dsh-upstream-watch` 看 DSH tag 的 peer；另看原型 `package.json`。两边对齐之前保持本条。对齐之后先改本文状态，再另开一次变更决定要不要动 CI |
| 状态 | `workaround-in-place` |
| 负责人 | Bruce |

## 变更

| 日期 | 对照 | 记录 |
|---|---|---|
| 2026-11-03 | DSH tag `dsh-v0.2.1-rc.5`；原型 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | 初稿。写入 UB-1 至 UB-9。浏览器认证、CLI 反代旗标、subagent 默认值、原型 push 门与 cordis pin 本次读过源文件。桌面远程模式、presence、看门狗、duplicate-attach 测试正文、全双工是否等于文章设计，仍是待核对或未验证 |
