# DSH × Muse：自用高效研发工具交付说明

> 基于 InfoQ 文章《AI 写代码飞快，为何交付没有变快？小红书 Muse 的 Agentic 架构实践》的
> 设计契约（`~/.dsh/profiles/plugins/MUSE-DESIGN.md`），把 DSH 改造成带 Harness 控制面的
> 个人研发工具。全部以**插件**实现，不动 DSH 内核，删除配置即可完整回滚。

## 对象模型（与 Muse 对齐）

| 对象 | 载体 | 位置 |
|---|---|---|
| Session | 转写/审计材料（DSH 原生） | `~/.dsh/sessions/` |
| WorkUnit | 业务任务状态机（不可变目标+步骤+预算+checkpoint+CAS revision） | `~/.dsh/storages/workunit.json` |
| Effect Ledger | 副作用登记：幂等键+审批+结果+回滚 | `~/.dsh/storages/effects.json` |
| Evidence | 上下文证据链：source/trust/hash/spans/freshUntil | `~/.dsh/storages/evidence.json` |
| Artifact | WorkUnit.artifacts（交付物，完成前磁盘核验） | 随 WorkUnit |
| EvalRecord | 三层评测缓存（结果/轨迹/组件） | `~/.dsh/storages/eval.json` |
| SkillProposal | Skill 治理流水线（提案→审批→灰度→回滚） | `~/.dsh/storages/workshop.json` |

## 十一个插件（`~/.dsh/profiles/plugins/dsh-muse/`）

| 插件 | 服务/工具 | 职责 |
|---|---|---|
| `dsh-workunit` | service `workunits`，工具 `workunit` | 任务状态机；complete 需全部步骤 done + verification 声明 + **交付物磁盘存在性事务校验**；revision CAS 防并发写偏 |
| `dsh-effect-ledger` | service `effectLedger`，工具 `effect` | 副作用幂等登记；propose 天然幂等（fresh=false 即重复）；markExecuted 重复返回 duplicate:true；approve 接受 proposed/failed/approved/rolled_back（失败重试不再死锁） |
| `dsh-evidence` | service `evidence`，工具 `evidence` | 证据注册/引用/过期检查；(source,hash) 幂等；url/tool-output 默认 untrusted |
| `dsh-guardrails` | 无服务，Config 可调 | 四位护栏：①每步注入 WorkUnit 任务框 ②pre-execute 分类（危险命令→审批，写文件/变异命令→自动台账）③同键已执行→deny 重复副作用 ④complete 后兜底交付检查 |
| `dsh-eval` | service `evaluation`，工具 `eval_report` | 三层评测：verifiedSuccess（done 且有 verification）、重复副作用率、每验证任务成本、失败六分类 |
| `dsh-skill-workshop` | service `workshop`，工具 `skill_workshop` | Skill 不允许静默修改：提案→**直接人类回合审批**→写入+热注册+版本快照→canary→promote→rollback |
| `dsh-muse-bridge` | 会话投影 `muse` + host RPC `/muse-file` | 可观测桥：把 muse 工具调用对与护栏拦截的写类调用纯折叠成会话投影实时推给前端；提供 `/muse-file` RPC 支持前端点击交付物在操作系统文件管理器（macOS Finder）中定位高亮；headless 下无连接服务时惰性降级 |
| `dsh-muse-ui` | client 插件（`conversation.view` 槽） | Web GUI「Muse 工作台」标签页：任务旅程/副作用流水线/证据墙/交互式交付物定位跳转/交付印章/实时动态；bundle 已提交，改 src 后 `npm run build:ui` |
| `dsh-token-stats` | host RPC `/token-stats` + client（`sidebar.footer.action` 槽） | 侧栏常驻今日/本周 token 统计，点击弹出完整历史；仅 web profile（依赖 connection 服务） |
| `dsh-session-pins` | host RPC `/session-pins` + client（DOM 增强：会话行菜单注入 + 侧栏顶部置顶区） | 会话置顶：入口在会话行「⋯」菜单（重命名同级），置顶区显示在侧栏列表上方；pins 存宿主侧 `storages/session-pins.json`，重启/换端口不丢；仅 web profile |
| `dsh-drop-path-ref` | client 捕获阶段 drop 拦截（host 惰性） | 拖入非图片文件自动转为输入框路径引用（含空格自动加引号）；桌面壳经原生 WKWebView 拖放桥（`HarnessWebView` + ready 握手）拿绝对路径，浏览器内走 uri-list；图片仍走原生附件流程；仅 web profile |

另有 `~/.dsh/skills/muse-orchestrator/SKILL.md`：编排纪律（Workflow/Pipeline/Agent Team 选型、副作用归父）。

工程化闭环（2026-09-01 补强）：`bin/manifest.mjs` 是插件清单单一事实源（安装器/eval setup/CI 检查共用）；`build/check-repo.mjs` 校验清单↔文件系统一致；CI 新增 client bundle 新鲜度门禁（改 src 忘跑 build 会红）。

## 激活状态

- **web profile**（GUI 用）：`~/.dsh/profiles/web/cordis.patch.yml` 已插入全部插件条目（`# >>> dsh-muse >>>` 标记块管理，以 `bin/manifest.mjs` 为单一事实源）+ `node_modules` 符号链接。插件源码改动后重启 GUI 生效；回滚删标记块或 `node bin/install.mjs uninstall`。
- **eval profiles**：`node eval/bin/setup.mjs` 生成 `eval-vanilla` / `eval-muse`（headless 对照；muse 侧挂七个宿主插件，ui 属浏览器端不进基准）。回归命令：`node eval/bin/run.mjs all`。

## 验证证据（2026-08-31 实跑）

| 场景 | 结果 |
|---|---|
| 10 步端到端（建任务→台账→写文件→checkpoint→complete→evaluate→summary） | ✅ 全链路通过；CAS 冲突被正确检测并按协议重读重试 |
| 重复副作用拒绝 | ✅ 逐字符相同命令第二次被 deny，报首次执行时间与幂等键 |
| 危险命令 | ✅ `rm -rf` 触发审批 → 当前环境审批通道关闭 → 拒绝并入账 |
| 崩溃恢复 | ✅ 进程退出后新进程 list/get 可见 WorkUnit（steps/checkpoint/revision 完整）+ 账本状态 |
| 交付阻断 | ✅ 声明产物缺失时 complete 事务性拒绝，状态保持 active；补齐后 complete 成功 |
| 评测 | ✅ evaluate（verified/tools/tokens）与 summary（1/1 verified、重复率 0、成本/验证任务） |

## 修复过程中的关键工程决策

1. **懒打开存储域**：服务构造函数即提供（插件即刻激活），domain 在首次使用时打开。
   根因：cordis 启动期并发激活 + 依赖 epoch 翻转会 dispose 已激活的 storage-json 光纤，
   在 `Service.init` 里同步开会与 backend 生命周期赛跑（"json backend is closed"）。
2. **幂等键语义化**：只对定义操作身份的参数做哈希（bash 只哈希 command，write 只哈希
   path+content）——重试同一操作必撞键，换一个 description 不会绕过。
3. **危险命令锚定**：正则锚在命令位（`(?:^|[|;&\n])`），引号内的 'rm -rf' 不再误报。
4. **模块级实例捕获**：cordis 不允许插件读取自己提供的服务，工具闭包用模块级句柄。
5. **不向会话追加自定义事件类型**：持久层会拒读未知类型导致会话不可恢复；
   审计走 storageDomain 的 history 表 + 转写自带的 tool/call 对。

## 日常使用姿势

- 让模型开工前 `workunit` create（插件的 systemPrompt 已引导它这么做）。
- 崩了/换会话：`workunit` op=list 找到任务 → op=get 看 checkpoint → 继续。
- 定期 `eval_report` op=summary 看：verified 成功率、重复副作用率、每验证任务 token 成本。
- 改 Skill：让模型走 `skill_workshop` propose，你本人说"批准"才会 apply。
- guardrails 可调（patch 条目加 config）：`extraDangerousPatterns`、`askFallback`（deny/auto）、
  `ledgerFileWrites`、`ledgerBashMutations`、`deliveryCheck`、`taskFrame`。

## 已知边界

- 当前环境审批策略为 never（danger-full-access 设定），危险命令一律拒绝并记录——
  要恢复人工审批提示，改 settings.yaml 的 permission preset。
- 多进程并发写同一 storages 文件是"最后写入赢"（JSON 原子写但无跨进程锁）；自用串行无碍。
- 危险命令清单是保守启发式，误报时用户可改写命令或加 config 调整。
