# Baoyu Design Plugins for DeepSeek Harness (DSH)

本目录集成了 [JimLiu/baoyu-design](https://github.com/JimLiu/baoyu-design) 为 DeepSeek Harness 打造的 **4 套设计与数据可视化技能插件**。
在 DSH 中，Agent 会将设计与展示文件直接写入本地工作区，并自动启动轻量级可视化编辑器，支持实时在线交互、双向修改和导出。

---

## 插件清单与技能说明

| 插件名称 | NPM 包名 | 触发指令 | 核心功能与输出能力 |
| :--- | :--- | :--- | :--- |
| **Claude Slides** | `dsh-claude-slides` | `/claude-slides` | **制作与编辑 PPT 演示文稿**：生成本地幻灯片工程（`project/deck.json` 与独立 HTML 幻灯片），支持在线放映演示、拖拽排版，并可一键导出 **PDF、HTML、PowerPoint (.pptx)**。 |
| **Claude Design** | `dsh-claude-design` | `/claude-design` | **设计画布与画板**：多画板并排可视化编辑，可直接微调文案、调整间距与样式细节，支持页面批注回传给 Agent。 |
| **Claude Design System** | `dsh-claude-design-system` | `/claude-design-system` | **设计系统与品牌规范**：生成包含 Design Tokens、字体排印、组件库、静态资产与 Brand Book 的完整设计系统页。 |
| **Claude Dashboard** | `dsh-claude-dashboard` | `/claude-dashboard` | **数据驱动大屏看板**：基于 CSV/JSON/TSV 数据文件构建图表、核心指标卡和表格，自带 Sources 数据溯源面板。 |

---

## 快速同步与安装

本套件提供了 `sync.mjs` 自动化维护脚本：

### 1. 检查上游更新
```bash
npm run sync:baoyu:check
# 或直接运行：
node integrations/baoyu-design/sync.mjs --check
```

### 2. 同步并下载最新上游版本到本仓库
```bash
npm run sync:baoyu
# 或直接运行：
node integrations/baoyu-design/sync.mjs
```

### 3. 一键同步并安装至本地 DSH 桌面端
```bash
npm run install:baoyu
# 或直接运行：
node integrations/baoyu-design/sync.mjs --install
```

---

## GitHub Actions 自动更新

仓库配置了自动化更新工作流 [`.github/workflows/sync-baoyu-plugins.yml`](../../.github/workflows/sync-baoyu-plugins.yml)，每周自动检查 npm 官方 registry 上的新发布，若检测到更新将自动拉取并提交 Commit，保持 GitHub 仓库始终与上游保持同步。
