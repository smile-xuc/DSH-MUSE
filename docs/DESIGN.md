# DSH × Muse：自用高效研发工具改造设计

> 目标：以 DSH 为 Agent Runtime 内核，吸收小红书 Muse 的 Harness 控制面、
> Context Engineering、WorkUnit 状态、验证、审批与自进化治理，
> 将 DSH 加固为可自用的生产级研发工具。
>
> 灵感来源：InfoQ《AI 写代码飞快，为何交付没有变快？小红书 Muse 的 Agentic 架构实践》
> （郑鑫祺 @ AICon 2026）。本文档是设计契约，实现全部以 DSH 插件形式落地，
> 不改动 node_modules 中的上游包，升级安全、可整体回滚。

## 0. 核心原则（来自 Muse，逐条落到机制）

| Muse 原则 | DSH 落地机制 |
|---|---|
| Transcript ≠ 任务状态 | `dsh-workunit`：结构化任务对象，事件溯源 + 版本化 |
| 工具返回成功 ≠ 业务完成 | `dsh-eval`：交付后业务验证（verify artifact）才算完成 |
| 每个副作用带幂等键 + 副作用日志 | `dsh-effect-ledger`：propose→approve→execute→verify→rollback 全留痕 |
| 四类检查放在四个位置 | `dsh-guardrails`：请求前 / 工具调用前 / 副作用前 / 交付后 |
| 权限 = 主体×动作×资源×参数×时间窗 | guardrails 规则引擎（tool×args×path×preset×session） |
| 证据带来源/时间/归属/权限/hash | `dsh-evidence`：证据注册表 + 引用 span + 新鲜度 |
| 外部内容一律不可信 | evidence trust 级 + guardrails 注入标记 |
| 三层评测 + 失败分类 | `dsh-eval`：result/trajectory/component，失败六分类 |
| 成本按成功任务算 | eval 聚合 token-meter 数据到 WorkUnit 维度 |
| Skill 不允许静默修改 | `dsh-skill-workshop`：proposal→scan→eval→approval→version→canary→rollback |
| 多 Agent 只用于真独立子任务 | orchestrator 指南 + subagent 过程指标（重复/冲突/汇总失败） |
| One Context, One Workspace | evidence 挂载多仓/多源到同一 WorkUnit 上下文 |

## 1. 对象模型

```
Session        = DSH 原生会话（对话、模型可见历史、审计、回放）— 已有
WorkUnit       = 业务任务：目标(不可变)、约束、计划版本、步骤状态、预算、恢复点
Evidence       = 上下文证据：来源、时间、owner、权限、hash、引用 span、trust 级
Effect         = 副作用账本条目：幂等键、审批范围、资源版本、结果、回滚
Artifact       = 可交付物：路径/内容 hash、验证结果、发布状态、版本
EvalRecord     = 评测：结果层 / 轨迹层 / 组件层 + 失败分类 + 成本
SkillProposal  = Skill 变更提案：diff、评测、审批、版本、灰度、回滚
```

关键纪律：
- WorkUnit 状态**只允许**通过 workunit 服务写；模型通过工具读写，工具强制 revision 乐观锁。
- Effect 必须先 propose（拿到幂等键）再执行；重试先查账本。
- Artifact 未通过 verify 不得标记 done。

## 2. 插件分层

```
~/.dsh/profiles/plugins/dsh-muse/
├── dsh-workunit/          结构化任务状态核（Service: workunits）
├── dsh-effect-ledger/     副作用账本（Service: effectLedger）
├── dsh-evidence/          证据注册与供给日志（Service: evidence）
├── dsh-guardrails/        四层检查 + 权限组合（依赖 tools 拦截缝）
├── dsh-eval/              三层评测 + 指标聚合（Service: eval）
├── dsh-skill-workshop/    Skill 治理（proposal 工作流）
├── dsh-muse-bridge/       可观测桥：muse 工具流 → 纯函数会话投影 `muse`（web）
└── dsh-muse-ui/           Muse 工作台标签页（浏览器端 cordis client 插件；宿主侧为空壳）
```

全部注册进 `~/.dsh/profiles/web/cordis.patch.yml`（web profile）与
`~/.dsh/profiles/headless/`（如建立 headless 本地 profile 用于 CI 式验证）。

## 3. 存储

复用 `storageDomain`（dsh-storage-domain，zod 校验、写链、domain/changed 事件，
JSON 落盘 ~/.dsh/storages/）。每个插件一个 domain：

- domain `workunit` v1: tables { units, checkpoints }
- domain `effects`  v1: tables { ledger（key=idempotencyKey）, byResource }
- domain `evidence` v1: tables { items, supplyLog }
- domain `eval`     v1: tables { records, metrics }
- domain `workshop` v1: tables { proposals, versions }

## 4. 模型可见工具（模型是第一公民用户）

| 工具 | 作用 |
|---|---|
| `workunit` (create/get/update/step/checkpoint/complete) | 结构化任务生命周期 |
| `effect` (propose/status/rollback) | 显式副作用登记（自动拦截之外的补充） |
| `evidence` (register/cite) | 登记证据、生成可引用 cite id |
| `eval_report` | 查询本 WorkUnit / 全局指标 |
| `skill_propose` | 发起 Skill 变更提案 |

## 5. Guardrails 四层

1. **请求前**（turn 开始）：任务漂移检测（当前消息 vs WorkUnit 目标）、上下文完整性（WorkUnit 有目标才有执行类工具）。
2. **工具调用前**：参数 schema 校验（DSH 已有）+ 业务规则（路径越界、危险命令模式、trust 级）。
3. **副作用前**：写类工具（write/edit/bash 写命令/网络 POST…）→ 自动 propose effect → 按策略 auto-approve（danger-full-access 下记录不拦截）或 ask（走 approval 缝）。
4. **交付后**：WorkUnit complete 前必须有 verify 记录（test/build/人工确认），否则拒绝 complete。

## 6. Eval 三层与指标

- **Result**：WorkUnit.verifiedSuccess、deliverable 存在且通过验证。
- **Trajectory**：从 sessionPersistence 事件流折叠：工具调用次数、重复副作用（同幂等键执行>1）、越权尝试、漏审批、错误恢复次数。
- **Component**：按 tool/model/prompt 维度统计失败率。
- **失败六分类**：model / route / tool / state / control / delivery。
- **指标**：verified_success、resume_success、duplicate_side_effect_rate、
  time_to_success、cost_to_success（token 用量 × WorkUnit）。

## 7. 第一条生产化路径（Pilot）

WeChat source → raw → digest → query/project artifact → human-approved writeback。
用一条真实低风险 WorkUnit 验证：崩溃恢复、重试幂等、证据留痕、审批续跑、指标报告。

## 8. 生产边界（自用）

允许：本机单用户、默认记录式 guardrails、有限工具白名单、可回滚文件产物。
禁止：公网暴露 webserver、无审批外部写入、模型静默改 Skill/Policy、
支付/群发/删除/生产发布类副作用（全部强制人工审批）。
