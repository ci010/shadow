---
name: clipboard
description: "Set HTML content to system clipboard via Deno TypeScript using @crosscopy/clipboard. Primary trigger: requests to copy rich text/HTML for paste into editors."
metadata:
  category: platform
---

# Clipboard (Deno TypeScript)

Primary goal: write HTML into clipboard for rich-text paste workflows.

Use `npm:@crosscopy/clipboard` for cross-platform clipboard access.

Repository: https://github.com/CrossCopy/clipboard

## 何时使用（以 HTML 为主）

当用户需要：
- 写入 HTML 到剪贴板（如富文本片段）
- 读取系统剪贴板 HTML 进行校验
- 将文章/模板片段复制到公众号编辑器
- （次要）读取或写入纯文本
- 清空剪贴板
- 查看当前剪贴板格式

## 首选命令（最常用）

```bash
# 写入 HTML（主流程）
deno run -A ./scripts/clipboard_cli.ts write-html "<h1>标题</h1><p>正文</p>"

# 读取 HTML（校验）
deno run -A ./scripts/clipboard_cli.ts read-html
```

## 推荐：直接用本技能内 CLI

本目录包含 `clipboard_cli.ts`，支持常见动作：

```bash
# 读取 HTML
 deno run -A ./scripts/clipboard_cli.ts read-html

# 写入 HTML
 deno run -A ./scripts/clipboard_cli.ts write-html "<b>hello clipboard</b>"

# 读取文本（次要）
 deno run -A ./scripts/clipboard_cli.ts read

# 写入文本（次要）
 deno run -A ./scripts/clipboard_cli.ts write "hello clipboard"

# 清空
 deno run -A ./scripts/clipboard_cli.ts clear

# 查看格式
 deno run -A ./scripts/clipboard_cli.ts formats
```

---

## 使用规则

1. 默认优先走 HTML：`write-html` / `read-html`。
2. 用户提到“复制到公众号/富文本编辑器”时，直接使用 `write-html`。
3. 仅当用户明确要求纯文本时，使用 `write` / `read`。
4. 出现原生依赖加载失败时，提示用户重试依赖安装（`deno cache` / 重跑命令）。
