# @deepseek-ai/dsh-web-search-bailian

阿里云百炼（DashScope）WebSearch 检索插件。

## 概述

为 DeepSeek Harness（DSH）的 `ctx.web` 规范提供原生的百炼联网搜索实现：
- 解决在非 DeepSeek 官方 API（例如使用阿里云千问、百炼 MaaS 代理等）环境下，调用原生 `web_search` 报 `WEB_PROVIDER_CREDENTIAL_MISSING` 的问题。
- 无缝适配 DSH 的 `web_search` 工具入参及返回契约（`sources: [{ title, url, snippet }]`）。
- 凭据安全解耦：不强制在 YAML 配置文件中硬编码 API Key，按顺序优先从环境变量（`QWEN_API_KEY`、`DASHSCOPE_API_KEY`、`BAILIAN_API_KEY`）、DSH 凭据存储、Bailian CLI 本地配置（`~/.bailian/config.json`）动态提取。
