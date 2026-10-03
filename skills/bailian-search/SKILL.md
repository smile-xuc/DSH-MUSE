---
name: bailian-search
description: 阿里云百炼联网搜索能力。Use when 用户需要查询实时资讯、技术前沿、外部文档或搜索互联网信息。支持百炼 CLI 命令行 (bl search web) 与 DSH 原生 web_search / MCP 搜索工具。
---

# 阿里云百炼搜索 (Bailian Search)

本机已配置阿里云百炼（DashScope）联网搜索能力，支持三种使用方式：

## 1. 原生 web_search 工具（推荐）
在 DSH 会话中直接调用内置 `web_search` 工具：
```json
web_search({"queries": ["OpenAI dots", "最新技术资讯"]})
```
底层已自动桥接到百炼 DashScope 搜索服务。

## 2. MCP 工具
当需要更精准的单条搜索或参数控制时，可调用 MCP 工具：
`mcp__WebSearch__bailian_web_search({"query": "搜索词", "count": 5})`

## 3. 命令行 bl search web (Bash)
在终端或 bash 工具中直接运行 CLI 搜索：
```bash
bl search web --query "搜索词" --count 5
```
输出格式支持结构化 json：
```bash
bl search web --query "搜索词" --output json
```
