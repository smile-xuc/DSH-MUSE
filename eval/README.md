# DSH-MUSE 自迭代评测体系

对照实验：**eval-vanilla**（原版 headless）vs **eval-muse**（+七个 Muse 宿主插件，清单取自 `bin/manifest.mjs` 单一事实源）。
两个 profile 共享同一份全局 settings（同一模型、同一凭据），唯一差异是 Muse 层。
方法论契约（效度威胁模型、统计纪律、任务分层）见 [../docs/EVAL-METHODOLOGY.md](../docs/EVAL-METHODOLOGY.md)。

> 构成说明：`dsh-muse-ui` 是纯浏览器端插件，不进 headless 基准；`dsh-muse-bridge` 随宿主插件挂载，
> 但其 `ctx.inject(['sessionProjections'], …)` 在 dsh-headless 装配下不触发（无投影注册表），
> 当前基准中惰性零开销——未来 headless 挂上投影注册表时它会自动进入计量。

## 使用

```bash
node bin/install.mjs install        # 先安装 Muse 层（eval-muse 依赖它）
node eval/bin/setup.mjs             # 创建 eval-vanilla / eval-muse 两个 profile
node eval/bin/run.mjs all --repeat 3  # 正式对照（A-B 交错执行，摊平时间漂移）
node eval/bin/run.mjs t01-write-verify  # 冒烟：单任务单次
node eval/bin/compare.mjs           # 聚合最新批次 → 中位数/IQR 表 + history + 自动刷新主 README
node eval/bin/evolve.mjs            # 分析趋势 → docs/proposals/<date>.md 改进提案

# 无 LLM 的确定性检查（秒级，CI 也跑这两个）
node eval/bin/static-cost.mjs       # 静态 prompt 开销：插件注入的段落+工具定义有多大
node eval/bin/check-guardrails.mjs  # 护栏分类器 vs 人工标注集（precision/recall）
```

## 指标口径

| 指标 | 来源 | 说明 |
|---|---|---|
| verified success | 任务 verifier 客观检查 | 不是"模型说完成了"；行为差异任务用 `variantVerify` 对两臂断言**不同**的终态（差异即证据） |
| tokens（细分四桶） | 会话日志 assistant/message\|chunk usage | 每 turn:step 取最后一次采样；uncached/cacheRead/cacheWrite/output 分列，缓存热度可见 |
| duplicate side effects | tool/call+result 配对（跨会话共享执行史） | 同一工具+同一语义参数成功执行 >1 次；崩溃恢复任务（t04）靠它识别跨进程重复 |
| tool errors / llm retries | 会话日志 | 组件层健康度 |
| 聚合统计 | 最新批次（同 `batch` id） | 中位数 + IQR [p25–p75] + 成功率 n/N；不报均值、不报 p 值（小样本诚实口径） |
| 环境指纹 | 每次运行记录 | dsh 版本、模型 id、profile patch 哈希、node 版本、batch id——回归可归因 |

## 任务分层

- **开销基准层**（t01–t03）：两臂预期都成功，测的是 Muse 层的成本与基本行为差异。
- **行为差异层**（t04–t06）：两臂预期**不同**——t04 崩溃恢复（SIGKILL 注入 + 续跑）、t05 危险命令拦截（目录存活 vs 消失）、t06 交付门禁（complete 必须曾被拒）。详见方法论文档 §3。

## 自迭代循环

run → compare → evolve →（在 DSH 会话里把提案变成 `skill_workshop` 受管变更）→ 人审 → 重跑。
历史批次在 `eval/history/` 只增不减，主线升级后重跑即可看到兼容性/性能回归。

## 加任务

`eval/tasks/*.json`：`{id, prompt, verify, fixture?, timeoutSec?, crash?, promptVariant?, variantVerify?}`。

- `{{WORKDIR}}` 会替换为独立临时目录；fixture 从 `eval/fixtures/<name>/` 拷贝。
- verify 类型：`fileContains` | `command` | `pathExists` | `sessionLogContains` | `allOf`（组合）。
- `variantVerify.{vanilla,muse}`：存在时覆盖该臂的 verify（行为差异任务的核心）。
- `crash: {afterFile, graceMs, resumePrompt.{vanilla,muse}}`：标记文件出现后 SIGKILL，再起恢复会话。
- `promptVariant.{vanilla,muse}`：两臂需要不同初始提示词时使用（如 t06 引导 muse 臂走 workunit 门禁）。
