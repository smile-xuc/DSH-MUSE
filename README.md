# DSH-MUSE

**把 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）从"会写代码的 Agent"升级为"能可靠交付的研发工具"** —— 受小红书 Muse Agentic 架构（InfoQ/AICon 2026《AI 写代码飞快，为何交付没有变快？》）启发，以**纯插件**形式实现 Harness 控制面：WorkUnit 任务状态、Effect Ledger 副作用台账、Context Evidence 证据链、四位护栏、三层评测、Skill 治理工坊。

> 零内核改动：DSH 主线怎么升级都不会与本项目冲突；删掉一个标记块即可完整回滚。

## 快速开始（fork 之后）

```bash
git clone <your-fork> && cd DSH-MUSE
node bin/install.mjs install        # 安装到 ~/.dsh 的 web profile（幂等）
# 重启 DSH，完成
```

```bash
node bin/install.mjs status         # 查看安装状态
node bin/install.mjs uninstall      # 完整卸载（只删自己创建的东西）
```

安装器做的事（全部可逆）：把 `plugins/` 拷到 `~/.dsh/profiles/plugins/dsh-muse/`、`skills/` 拷到 `~/.dsh/skills/`、在目标 profile 的 `node_modules` 建符号链接、在 `cordis.patch.yml` 插入 `# >>> dsh-muse >>>` 标记块。不碰 DSH 运行时的任何文件。

## 相对原版 DSH 的改动点

| 层 | 插件 | 原版行为 | DSH-MUSE 行为 |
|---|---|---|---|
| 任务状态 | `dsh-workunit` | 任务状态只活在转写里， compaction/崩溃后即失真 | WorkUnit 独立持久化：不可变目标、步骤、预算、checkpoint、revision CAS；complete 需全部步骤完成 + verification 声明 + **交付物磁盘存在性核验** |
| 副作用 | `dsh-effect-ledger` | 重试=可能重复执行同一副作用 | 幂等键台账：相同操作撞键即拒绝执行；审批/结果/回滚全部入账 |
| 证据链 | `dsh-evidence` | 上下文无出处 | 证据带 source/trust/hash/spans/freshUntil；url/工具输出默认不可信；(source,hash) 幂等去重 |
| 护栏 | `dsh-guardrails` | 仅靠 DSH 原生沙箱/审批 | 四位拦截：①每步注入 WorkUnit 任务框+预算告警 ②写文件/变异命令自动台账、危险命令强制审批 ③同键已执行→拒绝重复副作用 ④交付后兜底核验 |
| 评测 | `dsh-eval` | 无 | 三层评测：结果（verified delivery）、轨迹（重复副作用/未审批副作用/重试）、组件（分工具失败率）；成本口径=每验证任务 token |
| 自进化 | `dsh-skill-workshop` | Skill 可直接改 | Skill 变更走治理流水线：提案→**直接人类回合审批**→热注册+版本快照→canary→promote→rollback |
| 编排 | `muse-orchestrator` skill | — | Workflow/Pipeline/Agent Team 选型纪律（多 Agent 仅用于真独立子任务） |
| 可视化 | `dsh-muse-bridge` + `dsh-muse-ui` | agent 干活方式只在转写里 | Web UI 会话标签栏新增 **Muse 工作台** 视图（轨迹右侧），实时渲染 muse 工作方式（见下） |

## Muse 工作台（可视化面板）

装好后重启 DSH，会话顶部标签栏变为「对话 | 轨迹 | **Muse 工作台**」。新标签页以图形化仪表盘实时展示 agent 的工作方式：

- **统计胶囊条**：Muse 调用 / 写操作 / 已执行 / 护栏拦截 / 失败,彩色图标一目了然
- **🧭 任务旅程**：里程碑进度图（立项→执行中→核验→已交付）,当前节点呼吸高亮,受阻/待审批琥珀警示、失败转红;步骤画成节点链（五态圆点）;token/失败额度/轮次画成环形仪表
- **🛡 副作用流水线**：每条写操作带类型图标（✏️写入/📝编辑/⚡命令）+ 三站点进度点（提议→入账→执行）+ 中文状态徽章;护栏自动登记与显式登记分标;重复拦截整行红标 ⛔
- **📎 证据墙**：盾牌图标区分可信/存疑,hash 指纹,时效徽章（🕒有效/⌛过期）
- **📦 交付核验**：大号核验印章（✓已核验/？待核验）+ 交付物清单 + 评测指标瓦片（验证成功率/重复副作用率/成本）
- **📡 实时动态**：时间线 feed（Muse 蓝色 ◎、写操作琥珀 ✎、状态徽章）

数据通路（零内核改动的关键）：`dsh-muse-bridge` 把会话日志里的 muse 工具调用对（workunit/effect/evidence/eval_report/skill_workshop）以及护栏拦截的写类调用，**纯折叠**成一个 `muse` session projection，经 DSH 官方投影推送通道（`session/projection` 帧 + 历史尾部 seed）到达浏览器；`dsh-muse-ui` 是一个标准 cordis 客户端插件（`conversation.view` 槽注册），bundle 经 `/plugins/dsh-muse-ui/client.js` 由 DSH 官方 `client-modules` 机制下发——**不需要 fork DSH、不需要改前端源码**。

历史会话同样可视（打开旧会话即回放折叠）；会话没有 muse 活动时显示引导空态。

### 构建与分发

- `plugins/dsh-muse-ui/lib/client.js` 是**已提交的构建产物**（esbuild 工厂格式，external 仅用浏览器模块表基线），clone 后无需构建即可安装。
- 仅在修改 `plugins/dsh-muse-ui/src/` 后需要重建：`npm install && npm run build:ui`（devDependency 仅 esbuild）。
- 兼容性注记：client bundle 与 DSH `0.1.1-rc.x` 的浏览器模块表 API 绑定；DSH 大版本升级后若标签页消失/报错，先跑 `npm run build:ui` 重建，仍不行再对照 `conversation.view` 槽契约调整 `src/client.jsx`。

## 兼容性

- **DSH 版本**：在 `0.1.1-rc.2` 上开发并实测通过。依赖的公共 seam：`@deepseek-ai/cordis`（Service/inject/effect）、`dsh-storage-domain`、`dsh-tools`（defineTool + tools/pre-execute、tools/result、tools/post-execute 瀑布）、`systemPrompt`、`approval`、`skills`、`sessionPersistence`、`sessionProjections`（bridge 投影）、`client-modules` 的 `dsh.client` 双面包声明（UI 插件）。主线升级后跑一遍 `eval`（见下）即可验证兼容。
- **零冲突保证**：不修改/不重打包 DSH 任何文件；全部通过 profile 的 `cordis.patch.yml` 标记块挂载，`uninstall` 精确移除。
- **会话安全**：不向会话追加自定义事件类型（持久层会拒读未知类型）；审计走独立存储域（`~/.dsh/storages/{workunit,effects,evidence,eval,workshop}.json`）+ 转写自带 tool/call 对。
- **环境**：Node ≥ 20（开发环境 22.x），macOS/Linux。
- **审批策略**：若你的 DSH 配置为 `danger-full-access`（审批通道关闭），危险命令会被护栏**直接拒绝并入账**；恢复人工审批提示请调整 `settings.yaml` 的 permission preset。

## 性能差异（实测）

评测方法：同一机器、同一模型（kimi-k3）、同一任务集，对照 `eval-vanilla` 与 `eval-muse` 两个 headless profile。指标口径与复现方式见 [eval/README.md](eval/README.md)。

<!-- BEGIN EVAL RESULTS -->

| Task | Variant | Verified success | Wall time | Tokens (in+out) | Tool calls | Tool errors | Duplicate side effects |
|---|---|---|---|---|---|---|---|
| t01-write-verify | vanilla | ✅ | 91s | 36856 | 2 | 0 | 0 |
| t01-write-verify | muse | ✅ | 44s | 47230 | 2 | 0 | 0 |
| t02-idempotent-retry | vanilla | ✅ | 45s | 36851 | 2 | 0 | 1 |
| t02-idempotent-retry | muse | ✅ | 38s | 62758 | 3 | 1 | 0 |
| t03-bugfix-deliver | vanilla | ✅ | 61s | 63637 | 5 | 0 | 0 |
| t03-bugfix-deliver | muse | ✅ | 91s | 79830 | 5 | 0 | 0 |

**Deltas (muse − vanilla), latest runs:**

| Task | Δ success | Δ tokens | Δ wall | Δ duplicates |
|---|---|---|---|---|
| t01-write-verify | 0 | +10374 | -47s | 0 |
| t02-idempotent-retry | 0 | +25907 | -7s | -1 |
| t03-bugfix-deliver | 0 | +16193 | +30s | 0 |

_Latest batch: 2026-09-01T02:24:30.909Z — raw data in eval/results/, trend in eval/history/._

<!-- END EVAL RESULTS -->

**结论速读**（基于上表实测）：三个任务两个变体全部验证成功——Muse 层**没有牺牲交付能力**。代价是每个任务多消耗 28%–70% token（任务框注入+台账+幂等检查的工具往返，t02 的 +70% 已被 evolve 标记为 P1 优化项）。换来的是可证明的行为差异：t02 中原版把同一写入**执行了两次**（dup=1），DSH-MUSE 的第二次被护栏**精确拒绝**（dup=0，拒绝记录可查）；此外崩溃后可从 checkpoint 精确续跑、交付必须过磁盘核验、每次任务留下可归因的三层评测记录。对"写代码快但交付不可靠"这一 Muse 文章点名的痛点，这是刻意且值得的权衡。

## 自迭代评测体系

```bash
node eval/bin/setup.mjs    # 建 eval-vanilla / eval-muse 两个对照 profile
node eval/bin/run.mjs all  # 跑基准（任务集在 eval/tasks/）
node eval/bin/compare.mjs  # 汇总表格 + 追加历史 + 自动刷新上面的实测表
node eval/bin/evolve.mjs   # 分析历史 → docs/proposals/<date>.md 改进提案
```

循环：`run → compare → evolve → 在 DSH 会话中把提案变成 skill_workshop 受管变更 → 人审 → 重跑`。历史批次在 `eval/history/` 只增不减，DSH 主线升级后重跑即得兼容性回归报告。

## 仓库结构

```
plugins/            六个 Muse 插件（独立 npm 包形态，peerDeps 钉住 DSH seam 版本）
skills/             muse-orchestrator 编排纪律 skill
bin/install.mjs     幂等安装/卸载/状态（含旧手工安装的自动迁移）
eval/               自迭代评测：tasks + runner + compare + evolve + history
docs/DESIGN.md      设计契约（对象模型/存储域/护栏位/指标口径）
```

## 致谢与设计来源

- [小红书 Muse 的 Agentic 架构实践](https://mp.weixin.qq.com/s/KNJLcIARope82xZoBm-lxA)（郑鑫祺，AICon 2026）：Harness 控制面、Context Engineering、WorkUnit 状态、验证与审批、自进化治理的原始思想。
- [DeepSeek Harness](https://github.com/deepseek-ai)：cordis 插件体系让这一切无需碰内核。

## License

MIT
