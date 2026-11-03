# Super Agent 能力设计

产品名是 **DSH-haibo**。本文是设计说明，不是实现记录。仓库里没有对应的插件、安装步骤或运行时代码。凡写着「未验证」的句子，本次没有在目标主机上跑过，或没有把上游文件逐行读完。

拓扑以 [家庭主机](home-host.md) 为准：一台常开的家庭主机是唯一长期运行的 DSH，Router 与 Worker 在同一进程；其他设备只做这台主机的客户端。不要借用 DeepSeek Super-agent 文章里「云上无状态计算 + 设备守护进程」的拆法。上游原型 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的提交 [`6337fc823ce20251c8de8085948165c81aaa701e`](https://github.com/deepseek-ai/dsh-superagent-prototype/commit/6337fc823ce20251c8de8085948165c81aaa701e) 只作只读参考，并且只跑在隔离 profile `superagent` 里。不要把它装进 haibo 的 `# >>> dsh-muse >>>` 标记块，也不要把它的源码拷进 `plugins/`。

官方 DSH 尚未提供、因而本仓库只跟踪、不假装已经有的能力，见 [上游待办](upstream-backlog.md)。

## 目标

在家庭主机上，代理从 Bruce 明确交过来的对话里自动注意到需求，并主动提出对 [smile-xuc/DSH-haibo](https://github.com/smile-xuc/DSH-haibo) 的改进：Router 与 Worker 在同一台主机、同一个 DSH 进程里，由事件触发；需求发现走「对话里的需要 → 自主的改进提案」。提案到草稿为止。合并始终要 Bruce 明确说可以。

## 用词

文章里的 Router / Worker，原型里没有同名类。下表是本文用词和提交 `6337fc8` 里实际代码的对应。对应关系来自该提交的 [docs/007-architecture.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/007-architecture.md) 与 `src/app/http.ts`。面板路径 `/orchestrator` 在该文件里注册。端口 `3082` 是本仓库试验写死的，见 [profile 样例](trial/profile.cordis.patch.example.yml)，不是上游默认端口的复测。

| 本文 | 原型里 | 作用 |
|---|---|---|
| Router | `Engine`、`Assessor`、`Intake` | 收下 Trigger，评估，写下 Decision，决定接不接 |
| Worker | `DshExecutor`（`src/executor/dsh.ts`）及其 worker session | 在同一台主机上执行被接过的单 |
| Trigger | `Engine.receive(trigger)`；GitHub / 飞书 Source | 事件入口 |
| Subscription | Ticket 上的 Subscription | 一张单继续听哪些线程 |
| 面板 | 同一 profile 的 webserver 上的 `/orchestrator` | 人看评估记录和待办的地方 |

`Runtime` 在一个 profile 里把这些装在一起。这就是「同一进程里的 Router + Worker」。`acceptMode` 在面板的 Eval 设置里，取值 `off` / `observe` / `auto`，对应设置块 `eval.mode`。`observe` 的含义以原型 `src/core/model.ts` 为准：主动候选仍评估，Decision 记下本来会接受什么（`would_accept`），实际不接单。本试验把它固定为 `observe`，见 [home-host](home-host.md)。

## 形态

| 形态 | 执行在哪 | 对话面 | 和现有试验、rc.5 的关系 | 取舍 |
|---|---|---|---|---|
| 聊天 Bot（活在 Bruce 的聊天里） | 若 Bot 自己跑一套 DSH，就变成第二台长期 runtime；若 Bot 远程驱动主机，就要拿主机的会话凭据 | 有 | 原型的飞书 Source 是主机 profile 上的插件（`feishu-watch`），不是独立 Bot 进程。rc.5 没有设备配对，也没有「这个聊天用户只有这些权限」。浏览器会话 cookie 等于主机上的完整工具能力，见下文红线 | 对话近，但执行要么分裂出第二套 runtime，要么把完整主机权限交到聊天通道上 |
| 主机上的触发式后台，没有聊天在场 | 主机，同一进程 | 无。人看面板或 GitHub | 这就是当前隔离试验的形状：只开 GitHub Source，`eval.mode` 为 `observe`，面板在 `127.0.0.1:3082/orchestrator`。飞书关闭 | 和拓扑、原型一致，也是阶段 0。它看不见未转成 GitHub 事件的对话，批准也不在 Bruce 正在用的聊天里 |
| 混合：主机侧 Router/Worker + 聊天 Bot 只做对话面和批准通道 | 只在主机 | 聊天 Bot 只收明确转来的会话、只把提案和「可否」送回该会话 | 主机半边就是原型的 Engine + Executor，试验已经按这个装（仍是 observe，不执行）。聊天半边是原型里可选的飞书 Source，试验要求 GitHub observe 健康之后才开 | 执行不离开主机；聊天不持有第二套 runtime。批准出现在对话里，而不是只在面板上 |
| 只看面板（试验现状） | 主机 | 面板，不是 Bruce 的日常聊天 | 已有步骤，见 [主机安装](home-host.md#host-install)。不新写插件 | 适合阶段 0。不够做「从对话里发现需要」 |
| 离线提案脚本 | 无常驻进程 | 无 | 仓库已有 `node eval/bin/evolve.mjs`，把评测历史写成 `docs/proposals/<date>.md`。它不听事件 | 能出文档提案，不是这里要的事件触发 |
| 云上无状态计算 + 每台设备一个守护进程 | 云和设备分开 | 视文章而定 | 文章有、原型声明自己不等于文章实现。rc.5 也没有这种产品形态（未对每个客户端包穷尽检索，见待办 UB-2） | 不采用 |

**建议采用混合。** 理由只根据仓库和原型里已经有的东西，不根据文章里尚未落地的拆分：

1. 目标拓扑是一台主机、一个长期 DSH 进程。原型的 `Runtime` 已经把评估（Router）和 `DshExecutor`（Worker）装在同一个 profile 里。再养一个会执行的聊天 Bot，就违反「其他设备只是客户端」。
2. 纯后台触发能覆盖 GitHub，覆盖不了「对话里的需要」。批准若只在面板上，Bruce 不在主机前就看不到。聊天 Bot 适合做表面和批准通道，不适合做第二套执行器。
3. 飞书插件已经在原型里，且本仓库的启用顺序写明：先 GitHub-only + `observe`，健康之后才在**隔离 profile** 打开飞书。混合的聊天半边因此有一条现成路径，而且默认关着。
4. rc.5 的远程访问模型是「启动 token 换成签名 cookie，持有 cookie 即完整工具能力」。让聊天通道直接拿这枚 cookie 去驱动主机，比「聊天只作为 Source、执行留在主机进程」风险更大。见红线表。

混合在阶段 0 退化为「只有主机半边」：GitHub Source、`observe`、面板。聊天 Bot 不开。这不是已经实现的产品，只是试验步骤所描述的范围。

## 需求发现

只处理下面两类输入。其他输入在快路径丢掉。

- **对话。** 仅限 Bruce 明确转到主机的会话（将来若打开飞书 Source：被允许的会话里点名代理的消息）。不监听、不导入他的其他聊天。阶段 0 没有这条输入，因为飞书关闭。
- **GitHub。** 仅限 `smile-xuc/DSH-haibo`。试验样例把 `observeIssues` / `observePulls` / `observeComments` / `observeCi` 全部设为 `false`，只收点名通知（见 [settings 样例](trial/settings.observe.example.json) 与 [home-host](home-host.md#host-install)）。放宽这四个开关是扩大入口，要单独决定，不在阶段 0 做。

快路径不调用模型，只做便宜过滤：

| 检查 | 通过条件 | 不过 |
|---|---|---|
| 范围 | 仓库字符串恰好是 `smile-xuc/DSH-haibo`，或会话在明确转发的允许名单里 | 丢掉。名字或路径里出现 `aihw`、`yuanzhi`、`ai-sports` 直接停 |
| 种类 | 点名通知，或（仅在以后被允许时）上述四类 GitHub 事件之一；对话只收明确转发 | 丢掉 |
| 去重 | 原型 `Engine.receive` 会返回 `stored` / `duplicate` / `filtered`（`007` 的 Sources 行）。设计上的去重键是「来源 + 外部 id」（通知 id 或消息 id） | `duplicate` 不再进入慢路径。同一键 24 小时内只评估一次。24 小时是本设计的数，不是原型字段 |
| 速率 | 同一来源每小时最多 20 条进入慢路径；同时只评估 1 条 | 超出的记一笔「被限速」后丢掉，不排队打模型。20 与「同时 1 条」是本设计的数。原型 `LIMITS`（`src/limits.ts`）是字段长度和 `maxWorkers` 等校验界，不是这个速率。原型 passes 是一次一轮、每两秒（`007` 的 Passes 行），那是它自己的循环，不代替这里的上限 |
| 机密 | 正文在送给慢路径之前去掉密钥形态，见隐私 | 去不干净就整条丢掉，不保留原文 |

慢路径才做更深的判断：沿用原型的 Eval。阶段 0 下它只留下 Decision（`observe`：`would_accept`，reason code `observed`，`kind` 为 `ignore`，不接单）。慢路径不写仓库、不开 PR、不推送。

**置信门槛（定性，不是概率）。** 本次对原型 `src/core/model.ts` 检索 `confidence` / `score` / `threshold` 无命中。rc.5 侧也没有一条可以引用的「需求置信度」字段（未全库检索，见待办的刷新方法）。因此门槛定义为：快路径通过，并且慢路径的 Decision 属于原型 `observe` 下的 `would_accept`（reason code `observed`），这条才可以成为「给 Bruce 看的提案」。`off`、与 `observed` 无关的 `ignore`、`unavailable`、或快路径丢弃的，不提案。不要发明一个 0.8 之类的数字再假装上游有这个字段。

### 隐私

- 只处理 Bruce 明确转到它的会话。没有「读取他全部聊天」的模式。
- 原始聊天不进 git，不进其他仓库，不写进 haibo 的默认 profile 存储。评估若需要留底，只留在隔离 profile 的状态目录里，且只留快路径之后、已经去过密钥的那一截，留到能解释这条 Decision 为止。原型自己的 sqlite 会存 Trigger；打开飞书之前要接受这一点，否则不打开飞书。
- 去掉密钥：环境变量名里带 `KEY`、`PASSWORD`、`SECRET`、`TOKEN` 的值，以及 `GH_TOKEN`、`GITHUB_TOKEN`、启动 URL 里的 `token`、签名 cookie。原型 setup 已经会从 worker 环境里去掉前一类名字和两个 GitHub 令牌（见 [home-host](home-host.md#host-install) 对上游的转述）。提案正文再写一遍同样的删除。删不掉就不写提案。
- 不把启动 URL、cookie、`gh` 凭据贴进仓库、PR 或聊天记录。

## 主动改进的边界

它可以做的只有：在 `smile-xuc/DSH-haibo` 上**打开 Draft PR**、写下草稿、或提交一份提案。任何阶段都不自动合并。合并永远要 Bruce 对**这一次合并**明确说可以。

不做的事：

- 不向 `main` 推送。开 Draft PR 若要推，只能推非 `main` 的分支。
- 不 force push，不用 `--force` / `-f` / `--delete` / `--mirror`。
- 不碰其他仓库。明确永远不做 `aihw`、`yuanzhi`、`ai-sports`。
- 不写入密钥，不把令牌放进 PR 正文或提交。
- 不打开 auto-merge，不配置合并用的 CLI，不把 `eval.mode` 改成 `auto`，除非 Bruce 明确进入下面的阶段 2，并且即使到了阶段 2 也仍然不自动合并。
- 不改 haibo 的标记块来挂原型，不改 CI 里的 cordis / schemastery pin（tip 保持 `0.2.1-rc.5`）。

默认 profile 的护栏**挡不住**向 `main` 的普通 `git push`。`bin/manifest.mjs` 的 `ALLOW_GIT_PUSH_SAFE` 把非强制的 `git push`（README 写明包含 `git push origin main`）从「要审批」降成「入账后执行」。因此「禁止 push main」不能靠这块护栏。执行若将来发生，必须留在**没有** haibo 标记块的隔离 profile 里，并另有一条「目标分支不是 `main`、PR 是 draft」的检查。这条检查现在不存在。

<a id="red-lines"></a>

## 权限与安全红线

rc.5 的浏览器认证（本次对照 tag `dsh-v0.2.1-rc.5` 读过）：

- 启动 token 只在 `GET /?token=...` 换成签名 cookie，然后跳到干净的 `./`。cookie 是带 HMAC 的 bearer，绑定规范化后的主机名和端口。默认绝对寿命 30 天（`cookieMaxAgeDays`）。属性是 host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`。监听器自己是 HTTPS 时才带 `Secure`。没有 logout。见 [`packages/client/connection/src/browser-auth.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/client/connection/src/browser-auth.ts) 与 [`.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md)。
- 该 note 的 Consequences 写明：持有这枚浏览器 cookie，就获准调用完整的、能用工具的 Host API。明文 HTTP 监听器若其地址在未加密网络上可达，会把 cookie 明文送出。
- API 客户端另有 `GET /connect?token=<launch-token>&interactions=answer|none`，见 [2026-10-09-operator-scoped-connect-handshake.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/.agents/notes/implemented/architecture/2026-10-09-operator-scoped-connect-handshake.md)。这是操作者范围的握手，不是多用户，也不是设备配对。
- 主体与角色在 [2026-10-12-peer-principal-and-remote-access.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md)（`dsh-api-remote-access`）。那是资源上的角色，不是「每台设备一枚可吊销令牌」。

因此任何远程访问都要：TLS（反代终结，或主机自己的 `--tls-cert` / `--tls-key`）加上反代或私人网络（Tailscale / Cloudflare Tunnel 跑在 DSH 外面），并且在公开到互联网之前还有一层代理鉴权。`--public-url` 只公布地址，不授予信任；放行 Host/Origin 的是 `--trusted-host`。`--host 0.0.0.0` 与 `::` 会被拒绝。出处是同一 tag 的 [apps/cli/reference/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/apps/cli/reference/README.md)、[packages/bundle/web-app/src/startup.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/bundle/web-app/src/startup.ts) 与 [docs/user/guide/public-deployments.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/docs/user/guide/public-deployments.md)。细节和临时接法见 [主机安装的客户端设备](home-host.md#client-devices) 与待办 UB-1、UB-4。

| 事项 | 允许 | 要 Bruce 明确同意 | 禁止 |
|---|---|---|---|
| 读 `smile-xuc/DSH-haibo` 的点名通知并记下 Decision | 阶段 0。四个 `observe*` 保持 `false` | 打开任一个 `observe*` | 读其他仓库；把通知或聊天原文提交进 git |
| 写提案草稿 | 阶段 0 只记在隔离 profile 的状态里，不改仓库 | 把草稿写成仓库里的提交 | 写到 `aihw` / `yuanzhi` / `ai-sports` |
| 在该仓库开 Draft PR | 阶段 1：Bruce 对那一条说可以之后。阶段 2：仅文档，且他事先同意进入阶段 2 | 每一次合并；是否进入阶段 2 | 任何阶段自动合并；向 `main` 推送；force push；其他仓库 |
| 飞书或其他聊天 | 阶段 0 不接 | GitHub observe 已经健康，且只接他明确转来的会话 | 扫全部聊天；长期保存原始聊天；把密钥写进提案 |
| 远程打开主机 UI | 本机 `127.0.0.1` | TLS + 反代或私人网络，公开前加代理鉴权 | 明文 HTTP 暴露到可达网络；转发启动 URL 或 cookie |
| 改标记块、把原型拷进 `plugins/`、改 CI peer pin | 无 | 另一次他点头的代码变更 | 借本设计顺手改这些。tip 保持 `0.2.1-rc.5` |
| 主机停机后在客户端继续执行 | 无 | 无 | 客户端自己当长期 DSH。约定见待办 UB-7 |

## 和现有试验的关系

现有试验就是本设计的阶段 0，步骤在 [home-host 的主机安装](home-host.md#host-install)，样例在 [docs/trial/](trial/)。范围：只开 GitHub，`acceptMode` / `eval.mode` 为 `observe`，DSH **`0.2.1-rc.5`**（tag `dsh-v0.2.1-rc.5`），隔离 profile `superagent`，仓库只限 `smile-xuc/DSH-haibo`。原型 peer 与 haibo CI 的 cordis 不一致，破损只接受在试验里，见 [home-host 的 CI tip 与 cordis](home-host.md#ci-tip) 与待办 UB-9。

| 阶段 | 行为 | 谁打开 |
|---|---|---|
| 0 | 只观察。提案（Decision）记下来，不接单，不推送，不开 PR。`load.running` 保持 0 | 现在的试验步骤。飞书不开 |
| 1 | 仍是 `observe`。Bruce 对某一条提案明确说可以之后，才为那一条开 **Draft** PR。不合并 | 每条都要他的同意。没有「阶段 1 一旦打开就自动开 PR」 |
| 2 | 仅当 Bruce 明确说进入阶段 2：对**只改文档**的提案，可以自动开 Draft PR。仍不自动合并，仍不向 `main` 推送，仍不 force push，仍只限这一个仓库 | 进入阶段 2 本身要他明确说可以。他没有说，就停在阶段 1 |
| 飞书 Source | 只在阶段 0 的 GitHub observe 已经健康之后，按 [飞书 Source（v0）](home-host.md#feishu-source-v0) 的顺序，在隔离 profile 上打开 | 健康之前不开。不改默认 profile 的标记块 |

「只改文档」在阶段 2 的含义：diff 只含 `docs/` 与根目录 `README.md`。碰到插件、`bin/`、CI、`cordis.patch.yml` 就退回阶段 1，改由人批准。这个判断现在没有代码。

任何阶段都不自动合并。`observe` 不能改成 `auto` 来「顺便」做阶段 1 或阶段 2。上游执行器在接单之后以操作者的 OS 用户、`danger-full-access` 运行（[home-host](home-host.md) 对 `006` 的转述）。阶段 0 用 `observe` 避免启动它。

<a id="phases"></a>

## 实施顺序

下表是顺序，不是进度。每一格都还没做，除了「阶段 0 的步骤已经写在 home-host」这一点——步骤写了，不表示某台主机已经跑通。

| 顺序 | 内容 | 现在用插件做得到的 | 要上游先有的 | 待办 |
|---|---|---|---|---|
| 阶段 0 | 隔离 profile、GitHub、`observe`、面板上看 Decision | 不需要新的 haibo 插件。原型已经评估并记下不接单。安装器不读 `docs/trial/` | 真正的只读 GitHub。现在 `resolveDeployment` 要求 `permissions.push === true`，否则 `repositoryReadOnly` | UB-8、UB-9 |
| 阶段 1 | 人批准后的单条 Draft PR | 不要放进默认标记块。护栏白名单会放行非强制 `git push`。若做，只在隔离 profile 里，并且另加「非 main、draft」检查（该检查未写） | 只读模式仍缺时，推送能力必须靠账号只被加进这一个仓库来收口，这是试验已写的成员资格，不是新的令牌种类 | UB-1、UB-8 |
| 阶段 2 | 仅文档的自动 Draft PR | 同上，再加 diff 路径检查。没有现成插件 | 没有「只能改 docs」的上游权限位 | UB-8 |
| 聊天面 | 飞书只做表面和批准 | 原型有 `dsh-superagent-feishu` / `feishu-watch`，默认关。本仓库不实现飞书插件 | 设备令牌、在线状态、自建中继都还没有。没有它们之前，聊天面仍是「人先把会话转进来」 | UB-1、UB-2、UB-3、UB-4 |
| 从主机会话里发现需要 | 会话事件触发快路径 | 能否从外部插件挂上会话生命周期：未验证。可以先只靠 GitHub 与明确转发的聊天 | 若钩子不对外，就要上游暴露，或放弃这条输入 | UB-3、UB-6 |
| 看门狗 | 不做 | rc.5 与原型都没有文章里那种「会话外盯着主代理」的看门狗（全库检索未做，结论来自 2026-11-03 的审计，本次未重扫整棵树） | 要上游或另立项目。本设计不把看门狗算进阶段 0–2 | UB-5 |
| 客户端互相看见在线 | 不做进本设计的第一期 | 自建一条 webserver 路由加 cordis 服务在原则上是插件能做的；生命周期钩子是否对外部插件开放，未验证 | 正式的在线列表、心跳、桌面「连接远程 DSH」 | UB-2、UB-3 |

`async start()` / `stop()` 那种全双工切换：rc.5 的 base bundle 默认挂着 `subagent` 与 `subagent_fork`，另有实验性的 agent-team profile。这是否等于文章里的异步 ReAct，未验证。见待办 UB-6。在弄清之前，不把子代理或 agent-team 当作 Super Agent 的执行器。执行器仍是隔离 profile 里的原型 `DshExecutor`，并且阶段 0 不启动它。

## 本次核对与未验证

核对过（2026-11-03，对 tag `dsh-v0.2.1-rc.5` 与原型 `6337fc8` 的文件，不是对一台家庭主机的安装）：

- 浏览器认证 note、`browser-auth.ts`、握手 note、peer-principal note、`apps/cli/reference/README.md`、`packages/bundle/web-app/src/startup.ts`、`docs/user/guide/public-deployments.md`。
- base `packages/bundle/base/cordis.patch.yml` 挂着 subagent 工具；`maxActiveSubagents` 默认 8、`maxDepth` 默认 1 在 `packages/subagent/subagent/src/index.ts` 的 schema，不在 patch 里写成字面量。`packages/experimental/agent-team-profile/cordis.patch.yml` 关掉那四条 subagent 工具并插入 agent-team。base patch 与 `packages/bundle/web-app/cordis.patch.yml` 不插入 agent-team。
- 原型 `src/deployment.ts` 在 `permissions.push !== true` 时抛 `repositoryReadOnly`。`src/core/model.ts` 有 `AcceptMode = 'off' | 'observe' | 'auto'`。`src/app/http.ts` 注册 `/orchestrator`。`package.json` 把 cordis / schemastery 钉在 `4.0.5-alpha.1` / `3.18.5-alpha.1`。
- 本仓库 `bin/install.mjs` 的子命令只有 `install` / `uninstall` / `status`。试验样例与 home-host 的既有步骤。

未验证：

- 没有在家庭主机上执行安装、启动 `dsh web`、或跑通 observe 试验。
- 没有穷尽 rc.5 的每个客户端包去找「连接远程 DSH」或心跳。审计结论是未找到，见待办里标了「待核对」的条目。
- 没有通读 `src/core/model.ts` 全文；置信度只做了关键词检索。
- 外部插件能否挂上会话或连接生命周期，未验证。
- 子代理或 agent-team 与文章中的异步全双工是否同一件事，未验证。
- Tailscale 或 Cloudflare Tunnel 的具体配置没有在本仓库验证。它们只作为 DSH 外面的临时接法被点名。
