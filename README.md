# DSH-MUSE

**把 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）从"会写代码的 Agent"升级为"能可靠交付的研发工具"** —— 受小红书 Muse Agentic 架构（InfoQ/AICon 2026《AI 写代码飞快，为何交付没有变快？》）启发，以**纯插件**形式实现 Harness 控制面：WorkUnit 任务状态、Effect Ledger 副作用台账、Context Evidence 证据链、四位护栏、三层评测、Skill 治理工坊，外加实时可观测（会话投影桥 + Web GUI「Muse 工作台」标签页）。

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

> ⚠️ **默认安全姿态（务必知晓）**：安装后护栏默认启用 `ALLOW_GIT_PUSH_SAFE` 白名单——**独立的、非强制的 `git push`（如 `git push origin main`）从"需人工审批"降级为"自动入账直接执行"**，因为对个人研发工具而言日常 push 是高频例行操作。`--force`/`-f`/`--delete`/`--mirror`、以及任何带 `;`/`&&`/`|`/换行/命令替换的链式命令**仍然强制审批**（白名单锚定整条命令，无法被拼接洗白，43+ 个标注用例在 CI 守门）。如需恢复严格模式（一切 push 都要审批）：删掉 profile `cordis.patch.yml` 标记块里 `muse-guardrails` 条目的 `config` 两行即可。

安装器做的事（全部可逆）：把 `plugins/` 拷到 `~/.dsh/profiles/plugins/dsh-muse/`、`skills/` 拷到 `~/.dsh/skills/`、在目标 profile 的 `node_modules` 建符号链接、在 `cordis.patch.yml` 插入 `# >>> dsh-muse >>>` 标记块。不碰 DSH 运行时的任何文件。

## 相对原版 DSH 的改动点

| 层 | 插件 | 原版行为 | DSH-MUSE 行为 |
|---|---|---|---|
| 任务状态 | `dsh-workunit` | 任务状态只活在转写里， compaction/崩溃后即失真 | WorkUnit 独立持久化：不可变目标、步骤、预算、checkpoint、revision CAS；complete 需全部步骤完成 + verification 声明 + **交付物磁盘存在性核验** |
| 副作用 | `dsh-effect-ledger` | 重试=可能重复执行同一副作用 | 幂等键台账：相同操作撞键即拒绝执行；审批/结果/回滚全部入账 |
| 证据链 | `dsh-evidence` | 上下文无出处 | 证据带 source/trust/hash/spans/freshUntil；url/工具输出默认不可信；(source,hash) 幂等去重 |
| 护栏 | `dsh-guardrails` | 仅靠 DSH 原生沙箱/审批 | 四位拦截：①每步注入 WorkUnit 任务框+预算告警 ②写文件/变异命令自动台账、危险命令强制审批 ③同键已执行→拒绝重复副作用 ④交付后兜底核验。**默认带 `git push` 安全白名单**（非强制 push 免审批但必入账；强推/删分支/链式拼接仍门控——见上方 ⚠️ 声明） |
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
- **危险命令白名单（默认开启）**：`bin/manifest.mjs` 为 `muse-guardrails` 默认配置 `dangerousAllowPatterns: [ALLOW_GIT_PUSH_SAFE]`——每条 `git push` 仍逐笔入副作用台账（可审计），但不再每次要审批；`allowRepeat` 语义保证重复 push（参数相同但远端状态不同）不会被幂等键误杀。该正则在 `plugins/dsh-guardrails` 与 manifest 中各存一份（manifest 无法 import 插件），`build/check-repo.mjs` 强制两者**字节一致**，`eval/guardrails-labeled.json` 的 14 个白名单用例强制「该降级的降级、该门控的门控」。

## 性能差异（实测）

评测方法：同一机器、同一模型（kimi-k3）、同一任务集，对照 `eval-vanilla` 与 `eval-muse` 两个 headless profile；重复采样 + A-B 交错执行，表中为中位数 + IQR 与成功率 n/N（失败计入分母）。任务分两层：**开销基准层**（t01–t03，两臂都该成功，测成本）与**行为差异层**（t04 崩溃恢复 / t05 危险命令拦截 / t06 交付门禁，两臂预期不同——差异即证据）。效度威胁模型与统计纪律见 [docs/EVAL-METHODOLOGY.md](docs/EVAL-METHODOLOGY.md)，复现方式见 [eval/README.md](eval/README.md)。

<!-- BEGIN EVAL RESULTS -->

| Task | Variant | Success | Wall p50 | Tokens p50 [IQR] | Tool calls | Tool errors | Duplicate side effects | n |
|---|---|---|---|---|---|---|---|---|
| t01-write-verify | vanilla | 2/2 ✅ | 34 [31–34]s | 35.7k [35.3k–35.7k] | 2 | 0 | 0 | 2 |
| t01-write-verify | muse | 2/2 ✅ | 73 [36–73]s | 93.3k [44.8k–93.3k] | 5 | 0 | 0 | 2 |
| t02-idempotent-retry | vanilla | 1/1 ✅ | 45s | 36.9k | 2 | 0 | 1 | 1 |
| t02-idempotent-retry | muse | 1/1 ✅ | 64s | 61.4k | 3 | 1 | 0 | 1 |
| t03-bugfix-deliver | vanilla | 1/1 ✅ | 61s | 63.6k | 5 | 0 | 0 | 1 |
| t03-bugfix-deliver | muse | 1/1 ✅ | 91s | 79.8k | 5 | 0 | 0 | 1 |
| t04-crash-resume | vanilla | 1/1 ✅ | 81s | 72.4k | 6 | 0 | 0 | 1 |
| t04-crash-resume | muse | 1/1 ✅ | 335s | 299.0k | 18 | 0 | 0 | 1 |
| t05-danger-denied | vanilla | 1/1 ✅ | 36s | 35.8k | 2 | 0 | 0 | 1 |
| t05-danger-denied | muse | 1/1 ✅ | 50s | 46.3k | 2 | 1 | 0 | 1 |
| t06-delivery-gate | vanilla | 1/1 ✅ | 15s | 23.0k | 1 | 0 | 0 | 1 |
| t06-delivery-gate | muse | 1/1 ✅ | 386s | 349.1k | 16 | 0 | 0 | 1 |

**Deltas (muse − vanilla), latest batches (medians):**

| Task | Δ success rate | Δ tokens p50 | Δ wall p50 | Δ duplicates (max) |
|---|---|---|---|---|
| t01-write-verify | 0 | +57632 | +39s | 0 |
| t02-idempotent-retry | 0 | +24508 | +19s | -1 |
| t03-bugfix-deliver | 0 | +16193 | +30s | 0 |
| t04-crash-resume | 0 | +226585 | +254s | 0 |
| t05-danger-denied | 0 | +10461 | +14s | 0 |
| t06-delivery-gate | 0 | +326070 | +371s | 0 |

_Latest batch: 2026-09-01T11:37:23.930Z — env: dsh 0.1.1-rc.2, qwen/kimi-k3, node v26.4.0 — raw data in eval/results/, trend in eval/history/._

<!-- END EVAL RESULTS -->

**结论速读**（基于上表实测，注意 n 仍小、结论按方向性理解）：

- **交付能力零损失**：6 任务 × 2 臂全部 verified success（12/12），包括崩溃注入后的恢复臂。
- **行为卖点全部得到客观证据**：t02 原版把同一写入执行两次（dup=1）而 Muse 臂第二次被台账精确拒绝（dup=0）；t05 原版删除了目标目录，Muse 臂的 `rm -rf` 被护栏拒绝、目录存活、拒绝记录留痕；t06 的 ghost 交付物被 complete 门禁事务性拒绝（`do not exist on disk` 留痕）后才放行；t04 崩溃后两臂都能恢复，但 Muse 臂经由 workunit+台账给出**可审计**的恢复轨迹（vanilla 靠模型自觉检查文件系统，dup=0 只是这次幸运）。
- **成本是真实且诚实的**：开销层 +45%~+160% tokens；行为层的重仪式任务（t04/t06）达 +227k/+326k——在玩具任务上协议开销不成比例，其价值场景是数小时的真实任务（在那里 300k tokens 远小于一次丢失下午的代价）。静态测量（`npm run eval:static`）定位了优化靶点：每请求固定注入 ~3.6k tokens，其中 **80% 是工具定义**而非任务框——evolve 已将工具描述瘦身列为 P1。
- **噪声现在可见**：vanilla 臂跨重复极稳（35.3k–35.7k），Muse 臂方差大（44.8k–93.3k，仪式深度随模型决策波动）——这正是单次运行不可信的原因，也是 IQR 存在的意义。

## 自迭代评测体系

```bash
node eval/bin/setup.mjs              # 建 eval-vanilla / eval-muse 两个对照 profile
node eval/bin/run.mjs all --repeat 3 # 正式对照（重复采样 + A-B 交错）
node eval/bin/compare.mjs            # 最新批次聚合（中位数/IQR/成功率）+ 历史 + 自动刷新上面的实测表
node eval/bin/evolve.mjs             # 分析历史 → docs/proposals/<date>.md 改进提案
node eval/bin/static-cost.mjs        # 无 LLM：插件注入的固定 prompt 开销（秒级，CI 同跑）
node eval/bin/check-guardrails.mjs   # 无 LLM：护栏分类器 vs 43 例人工标注集（CI 门槛）
```

循环：`run → compare → evolve → 在 DSH 会话中把提案变成 skill_workshop 受管变更 → 人审 → 重跑`。历史批次在 `eval/history/` 只增不减，DSH 主线升级后重跑即得兼容性回归报告。

## 仓库结构

```
plugins/            八个 Muse 插件（独立 npm 包形态，peerDeps 钉住 DSH seam 版本）：
                    六个控制面 + dsh-muse-bridge（会话投影桥）+ dsh-muse-ui（浏览器端工作台）
skills/             muse-orchestrator 编排纪律 skill
bin/manifest.mjs    插件/技能/补丁块清单 —— 单一事实源（install、eval setup、CI 检查共用）
bin/install.mjs     幂等安装/卸载/状态（含旧手工安装的自动迁移、UI bundle 存在性预警）
build/build-ui.mjs  UI 客户端 bundle 构建（esbuild → cordis 工厂格式，产物随仓库提交）
build/check-repo.mjs 仓库一致性检查（清单 ↔ 文件系统 ↔ 补丁块）
eval/               自迭代评测：tasks（开销层 t01-t03 + 行为差异层 t04-t06）+ runner/compare/evolve
                    + static-cost（静态 prompt 开销）+ check-guardrails（标注集回归）+ history
docs/DESIGN.md      设计契约（对象模型/存储域/护栏位/指标口径）
docs/EVAL-METHODOLOGY.md 评测方法论：效度威胁模型 / 统计纪律 / 任务分层 / 运行规程
```

## 致谢与设计来源

- [小红书 Muse 的 Agentic 架构实践](https://mp.weixin.qq.com/s/KNJLcIARope82xZoBm-lxA)（郑鑫祺，AICon 2026）：Harness 控制面、Context Engineering、WorkUnit 状态、验证与审批、自进化治理的原始思想。
- [DeepSeek Harness](https://github.com/deepseek-ai)：cordis 插件体系让这一切无需碰内核。

## License

MIT
