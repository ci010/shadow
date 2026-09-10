# 飞书文档 API 参考

## 核心概念

- **document_id**：文档唯一标识（27+ 字符），从文档 URL 中提取：`https://xxx.feishu.cn/docx/<document_id>`
- **block_id**：文档根块 ID 等于 `document_id`
- **block_type**：数字枚举，常用值见下表

## Block Type 枚举

| 值 | 类型 |
|----|------|
| 1  | Page（文档根） |
| 2  | Text（段落） |
| 3-8 | Heading1-6 |
| 12 | Bullet（无序列表） |
| 13 | Ordered（有序列表） |
| 14 | Code（代码块） |
| 22 | Divider（分割线） |

## Gateway 代理 URL

所有请求通过 `http://localhost:3123/feishu/open-apis/...`，自动注入 `tenant_access_token`。

## 主要接口

### 获取文档信息
```
GET /docx/v1/documents/{document_id}
```
返回：`{ document: { document_id, revision_id, title, ... } }`

### 读取全文（纯文本）
```
GET /docx/v1/documents/{document_id}/raw_content?lang=0
```
返回：`{ content: "..." }`

### 获取所有块
```
GET /docx/v1/documents/{document_id}/blocks?page_size=500
```
支持分页，`has_more=true` 时用 `page_token` 继续。

### 新建文档
```
POST /docx/v1/documents
{ "title": "文档标题", "folder_token": "可选，目标文件夹" }
```

### 向文档追加块（在末尾）
```
POST /docx/v1/documents/{document_id}/blocks/{parent_block_id}/children
{ "children": [...blocks], "index": -1 }
```
`parent_block_id` = `document_id`（根块）

### 删除子块（清空文档）
```
DELETE /docx/v1/documents/{document_id}/blocks/{parent_block_id}/children/batch_delete
{ "start_index": 0, "end_index": <child_count> }
```

### 更新块内容
```
PATCH /docx/v1/documents/{document_id}/blocks/{block_id}
{ "update_text_elements": { "elements": [...] } }
```

## 块数据结构示例

### 段落（Text）
```json
{
  "block_type": 2,
  "text": {
    "elements": [{ "text_run": { "content": "内容", "text_element_style": {} } }],
    "style": {}
  }
}
```

### 标题（Heading1）
```json
{
  "block_type": 3,
  "heading1": {
    "elements": [{ "text_run": { "content": "标题", "text_element_style": {} } }],
    "style": {}
  }
}
```

### 代码块
```json
{
  "block_type": 14,
  "code": {
    "elements": [{ "text_run": { "content": "code here", "text_element_style": {} } }],
    "style": { "language": 1, "wrap": false }
  }
}
```

### 分割线
```json
{ "block_type": 22, "divider": {} }
```

## 权限要求

应用需在飞书开放平台开启以下权限：
- `docs:doc` — 查看、编辑文档
- `drive:drive` — 访问云盘（新建文档时需要）
