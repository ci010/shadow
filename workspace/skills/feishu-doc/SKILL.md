---
name: feishu-doc
description: 读取和写入飞书（Lark）文档。通过 bot gateway 代理访问飞书 docx API，无需手动处理认证。支持：读取文档全文、获取块结构、新建文档、向文档末尾追加内容（支持 Markdown）、替换文档全部内容。触发词包括"读取飞书文档"、"写入飞书文档"、"新建飞书文档"、"飞书文档追加内容"、"从飞书文档获取内容"、"更新飞书文档"等。
metadata:
  category: integration
---

# feishu-doc — 飞书文档读写

通过 bot gateway 代理（`http://localhost:3123/feishu/open-apis/...`）调用飞书 docx API，gateway 自动注入 `tenant_access_token`。

## 快速开始

```bash
# 读取文档全文
/Users/ci010/.deno/bin/deno run --allow-net skills/feishu-doc/scripts/feishu_doc.ts read <document_id>

# 新建文档
/Users/ci010/.deno/bin/deno run --allow-net skills/feishu-doc/scripts/feishu_doc.ts create "文档标题"

# 追加 Markdown 内容到文档末尾
/Users/ci010/.deno/bin/deno run --allow-net skills/feishu-doc/scripts/feishu_doc.ts append <document_id> "## 新章节\n\n内容..."

# 替换文档全部内容（慎用）
/Users/ci010/.deno/bin/deno run --allow-net skills/feishu-doc/scripts/feishu_doc.ts replace <document_id> "# 全新内容"
```

## 获取 document_id

从文档 URL 提取：`https://xxx.feishu.cn/docx/<document_id>`

## 脚本功能

脚本位于 `scripts/feishu_doc.ts`，也可以作为 Deno 模块导入：

```typescript
import { readDocContent, appendToDoc, createDoc } from "./skills/feishu-doc/scripts/feishu_doc.ts";
```

| 函数 | 说明 |
|------|------|
| `getDocInfo(id)` | 获取文档基本信息（标题、revision 等） |
| `readDocContent(id)` | 读取文档纯文本全文 |
| `getBlocks(id)` | 获取文档所有块（JSON 结构） |
| `createDoc(title, folderToken?)` | 新建文档，返回文档信息 |
| `appendToDoc(id, markdown)` | 向文档末尾追加 Markdown 内容 |
| `replaceDoc(id, markdown)` | 清空文档后写入 Markdown 内容 |

## Markdown 支持

`appendToDoc` 和 `replaceDoc` 接受 Markdown 文本，自动转换为飞书块：

- `# 标题` → Heading1（支持 1-6 级）
- `- 列表项` / `* 列表项` → Bullet
- `1. 列表项` → Ordered
- `` ```lang\n代码\n``` `` → Code block
- `---` → Divider
- 普通文本 → Text 段落

## 更多 API 细节

详见 `references/api.md`，包含块结构示例、权限要求、接口文档。

## 注意事项

- `replaceDoc` 会删除文档中所有现有内容，操作不可逆
- `folder_token` 可从云盘文件夹 URL 获取
- 如果报错 `Access denied`，需在飞书开放平台为应用开通以下权限后重新发布：
  - 读取：`docx:document:readonly` 或 `docx:document`
  - 写入/新建：`docx:document` 或 `docx:document:create`
  - 直接访问链接：`https://open.feishu.cn/app/cli_a912201c21b89cc6/auth?q=docx:document`
