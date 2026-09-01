# DSH-MUSE 自迭代评测体系

对照实验：**eval-vanilla**（原版 headless）vs **eval-muse**（+七个 Muse 宿主插件，清单取自 `bin/manifest.mjs` 单一事实源）。
两个 profile 共享同一份全局 settings（同一模型、同一凭据），唯一差异是 Muse 层。

> 构成说明：`dsh-muse-ui` 是纯浏览器端插件，不进 headless 基准；`dsh-muse-bridge` 随宿主插件挂载，
> 但其 `ctx.inject(['sessionProjections'], …)` 在 dsh-headless 装配下不触发（无投影注册表），
> 当前基准中惰性零开销——未来 headless 挂上投影注册表时它会自动进入计量。

## 使用

```bash
node bin/install.mjs install        # 先安装 Muse 层（eval-muse 依赖它）
node eval/bin/setup.mjs             # 创建 eval-vanilla / eval-muse 两个 profile
node eval/bin/run.mjs all           # 跑全部任务 × 两个变体
node eval/bin/compare.mjs           # 汇总 → 表格 + history + 自动刷新主 README
node eval/bin/evolve.mjs            # 分析趋势 → docs/proposals/<date>.md 改进提案
```

## 指标口径

| 指标 | 来源 | 说明 |
|---|---|---|
| verified success | 任务 verifier（文件内容/命令退出码） | 不是"模型说完成了"，是客观检查 |
| tokens | 会话日志 assistant/message|chunk usage | 每 turn:step 取最后一次采样（防双计） |
| duplicate side effects | tool/call+result 配对 | 同一工具+同一语义参数成功执行 >1 次；被护栏拒绝的重试**不算**执行 |
| tool errors / llm retries | 会话日志 | 组件层健康度 |

## 自迭代循环

run → compare → evolve →（在 DSH 会话里把提案变成 `skill_workshop` 受管变更）→ 重跑。
历史批次在 `eval/history/` 追加，主线升级后重跑即可看到兼容性/性能回归。

## 加任务

`eval/tasks/*.json`：`{id, prompt, verify: {type: fileContains|command, ...}, fixture?}`。
`{{WORKDIR}}` 会替换为独立临时目录；fixture 从 `eval/fixtures/<name>/` 拷贝。
