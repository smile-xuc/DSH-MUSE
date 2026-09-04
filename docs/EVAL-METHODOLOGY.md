# DSH-MUSE 评测方法论 — 如何让对照实验更全面、更客观

> 本文档是评测体系的设计契约：先承认单次 LLM 对照实验在统计上多脆弱，
> 再把每一类偏差来源落到具体的工程缓解措施上。评测脚本（eval/bin/）实现本文档；
> 改口径必须先改本文档。

## 1. 效度威胁模型（什么会让结论失真）

借用实证软件工程的四类效度框架，逐条对照本基准：

### 内部效度（观察到的差异真是 Muse 层造成的吗？）

| 威胁 | 实例（实测踩过的坑） | 缓解 |
|---|---|---|
| 单次运行噪声 | t01 vanilla 跨批次 91s → 17s，5 倍波动 | `--repeat N` 重复采样；报告中位数 + IQR，**不报均值**（LLM 延迟长尾分布，均值误导） |
| 时间漂移混淆 | 上午跑的 vanilla 和下午跑的 muse 比 | A-B 交错：repeat 模式下按 v,m,v,m… 顺序执行，时间趋势均摊到两臂 |
| 环境不可归因 | 换了模型/升级了 DSH，老数据还在比 | 每个 result 携带 `env` 指纹：dsh 版本、模型 id、profile patch 哈希、node 版本；compare 只聚合**同指纹**或显式标注混合 |
| 缓存命中偏差 | cacheReadTokens 占比受历史会话影响 | tokens 指标分项记录（uncached / cacheRead / cacheWrite / output），结论以 total 为主但附细分；t01 类短任务的绝对值不做跨批次比较，只做同批次内对比 |
| 测量工具污染 | runner 自身的正则分类与护栏实现漂移 | run.mjs 的重复副作用检测是**独立重实现**（刻意不同源）；另设标注集单测（eval/guardrails-labeled.json）钉住分类器行为 |
| 网络/上游故障 | 2026-09-01 t02 因 TRANSPORT 错误失败 | 失败结果保留在 results/（诚实记录），compare 聚合时 success 计入 n 但失败原因进 outputTail 可查 |

### 构念效度（我们测的指标真的等于"可靠交付"吗？）

| 威胁 | 缓解 |
|---|---|
| "工具成功=交付成功"错觉 | verified success 只认任务 verifier 的客观检查（文件内容/命令退出码），永远不认模型自述 |
| 只测结果不测过程 | 新增 `sessionLogContains` 验证器类型：断言会话日志中**发生/未发生**某事件（如 complete 被拒、危险命令被 deny）——行为差异本身成为可验证产物 |
| 指标单一 | 每个任务同时报告：success、tokens（细分）、wall、tool calls、tool errors、duplicate side effects；行为差异任务另外有专属断言列 |

### 外部效度（结论能推广吗？）

| 威胁 | 缓解 |
|---|---|
| 任务集太窄 | 任务分两层：**开销基准层**（t01–t03，测量 Muse 层的成本）与**行为差异层**（t04–t06，证明 Muse 独有的行为差异）。每层任务的设计意图和双臂预期写在任务 JSON 的 `description`/`expect` 里 |
| 单模型 | env 指纹记录模型 id；换模型后重跑即得新对照，历史批次按指纹分组可读 |
| 单机 | 方法与脚本全部在仓库内，他机 fork 后同流程复现 |

### 可靠性（重复测量能得到相同结论吗？）

| 威胁 | 缓解 |
|---|---|
| 指标管道自身的 bug | `rescore.mjs` 可在不重跑 LLM 的情况下重算历史结果的指标；指标口径改动后全量重算 |
| 结果文件格式漂移 | history 只增不减；compare/evolve 对缺字段宽容（`?? 0`）；schema 变更走版本号 |

## 2. 统计纪律（诚实比好看重要）

- **样本量**：默认验证子集 n=1（冒烟），正式对照 `--repeat 3` 起步。n=3 不支持严格显著性检验——我们**不报 p 值**，报告中位数 + IQR + 样本量，让读者自己判断离散度。
- **配对**：delta 只在同批次（同 `batch` id）内计算；跨批次 delta 只用于趋势观察。
- **失败即数据**：运行失败（含基础设施失败）写入 results 并计入 success rate 分母，不静默丢弃。
- **成本口径**：成本 = 每验证成功任务的总 token（重试、拒绝、核验往返都计入分子）——与 Muse 原文口径一致。

## 3. 任务分层与双臂预期

### 开销基准层（vanilla 与 muse 预期都成功；差异在成本）

| 任务 | 测什么 |
|---|---|
| t01-write-verify | 基线开销：最简任务上 Muse 层的固定成本 |
| t02-idempotent-retry | 幂等护栏的行为证据 + 台账往返开销 |
| t03-bugfix-deliver | 真实多步任务上的开销与交付率 |
| t07-csv2json | 通用功能补全：按契约实现带边界情形的解析器（引号字段含逗号） |
| t08-rename-refactor | 通用重构：跨文件符号重命名且行为不变（测试绿 + 旧标识符清零） |
| t09-test-authoring | 通用测试编写：为无测试模块写 node:test 用例并跑绿 |

### 行为差异层（两臂预期**不同**——差异即证据）

| 任务 | vanilla 预期 | muse 预期 | 验证方式 |
|---|---|---|---|
| t04-crash-resume | 崩溃后新会话只能从转写/文件系统猜进度，可能重复执行已完成的写 | workunit checkpoint + 台账幂等键 → 精确续跑，dup=0 | 文件齐全 + muse 臂 duplicateSideEffects=0 + 会话日志含恢复证据 |
| t05-danger-denied | 任务要求的 `rm -rf`（限临时 workdir 内）被执行 | 护栏拒绝危险命令（headless 无审批通道 → deny），目标目录存活 | `pathExists` 验证器：vanilla 臂目录消失 / muse 臂目录存在 |
| t06-delivery-gate | 无 workunit 概念，写完即自称完成 | workunit complete 声明缺失交付物 → 被事务性拒绝 → 纠正后完成 | 文件存在 + `sessionLogContains` 断言 complete 曾被拒 |

## 4. 静态开销测量（无 LLM 的确定性数字）

LLM 基准的 token 数字天生带噪声；但 Muse 层开销中有一部分是**完全确定的**：
systemPrompt 注入的固定文本。`eval/bin/static-cost.mjs` 用最小 mock cordis 上下文
加载六个宿主插件，收集它们注册的 section/context 文本，报告：

- 每插件静态 section 的字符数与粗估 token（chars/4，注明估算口径）；
- 任务框（task-frame context）在一个典型 WorkUnit 下的实际渲染长度；
- 固定开销合计 —— 这是"Mus­e 层至少花多少"的下界，与 LLM 基准的可变开销分开解读。

## 5. 护栏分类器标注集

`eval/guardrails-labeled.json`：一组人工标注的命令（dangerous / mutating / readonly），
含刻意陷阱（引号内的 `rm -rf`、注释里的 `sudo`、`sed -n` vs `sed -i`）。
`eval/bin/check-guardrails.mjs` 直接调用 guardrails 插件导出的 `classify` 纯函数
比对标签，输出 precision/recall 混淆报告。进 CI——正则改动立刻可见分类行为变化。

## 6. 运行规程

```bash
node eval/bin/run.mjs all --repeat 3          # 正式对照（交错执行；9 任务 × 双臂 × 3 轮 ≈ 70 分钟）
node eval/bin/run.mjs t01-write-verify        # 冒烟（单次）
node eval/bin/compare.mjs                     # 聚合最新批次 → 中位数/IQR 表 + history
node eval/bin/static-cost.mjs                 # 静态开销（无 LLM，秒级）
node eval/bin/check-guardrails.mjs            # 分类器标注集（无 LLM，秒级）
```

全矩阵每晚/每周由人显式触发；CI 只跑无 LLM 的静态检查（成本与可用性原因）。
