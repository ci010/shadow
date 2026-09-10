/**
 * feishu_doc.ts — 飞书文档读写工具
 *
 * 通过 bot gateway 代理（http://localhost:3123/feishu/open-apis/...）访问飞书文档 API。
 * Gateway 自动注入 tenant_access_token，无需手动处理认证。
 *
 * 用法（Deno）：
 *   deno run --allow-net feishu_doc.ts <command> [args...]
 *
 * Commands:
 *   info <document_id>                    获取文档基本信息
 *   read <document_id>                    读取文档全文（纯文本）
 *   blocks <document_id>                  获取文档块结构（JSON）
 *   create <title> [folder_token]         新建文档
 *   append <document_id> <markdown_text>  向文档末尾追加内容
 *   replace <document_id> <markdown_text> 清空文档内容并写入新内容
 */

const GATEWAY = "http://localhost:3123";

function api(path: string): string {
  return `${GATEWAY}/feishu/open-apis${path}`;
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(api(path), {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json() as { code: number; msg?: string; data?: T };
  if (json.code !== 0) {
    throw new Error(`Feishu API error ${json.code}: ${json.msg}`);
  }
  return json.data as T;
}

// ── 获取文档信息 ──────────────────────────────────────────────────────────────

async function getDocInfo(documentId: string) {
  const data = await req<{ document: Record<string, unknown> }>(
    "GET",
    `/docx/v1/documents/${documentId}`,
  );
  return data.document;
}

// ── 读取全文（raw_content）────────────────────────────────────────────────────

async function readDocContent(documentId: string): Promise<string> {
  const data = await req<{ content: string }>(
    "GET",
    `/docx/v1/documents/${documentId}/raw_content?lang=0`,
  );
  return data.content ?? "";
}

// ── 获取块结构 ────────────────────────────────────────────────────────────────

interface Block {
  block_id: string;
  block_type: number;
  children?: string[];
  [key: string]: unknown;
}

async function getBlocks(documentId: string): Promise<Block[]> {
  const blocks: Block[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ page_size: "500" });
    if (pageToken) params.set("page_token", pageToken);

    const data = await req<{
      items: Block[];
      has_more: boolean;
      page_token?: string;
    }>("GET", `/docx/v1/documents/${documentId}/blocks?${params}`);

    blocks.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);

  return blocks;
}

// ── 新建文档 ──────────────────────────────────────────────────────────────────

async function createDoc(title: string, folderToken?: string) {
  const body: Record<string, string> = { title };
  if (folderToken) body.folder_token = folderToken;
  const data = await req<{ document: Record<string, unknown> }>(
    "POST",
    "/docx/v1/documents",
    body,
  );
  return data.document;
}

// ── Markdown → 飞书 Block 转换 ────────────────────────────────────────────────
// 支持：段落、一级/二级/三级标题、无序列表、有序列表、代码块、分割线

interface FeishuBlock {
  block_type: number;
  [key: string]: unknown;
}

const BLOCK_TYPE = {
  PAGE: 1,
  TEXT: 2,
  HEADING1: 3,
  HEADING2: 4,
  HEADING3: 5,
  HEADING4: 6,
  HEADING5: 7,
  HEADING6: 8,
  BULLET: 12,
  ORDERED: 13,
  CODE: 14,
  DIVIDER: 22,
} as const;

function textElement(content: string, style?: Record<string, unknown>) {
  return {
    text_run: {
      content,
      text_element_style: style ?? {},
    },
  };
}

function paragraphBlock(text: string): FeishuBlock {
  return {
    block_type: BLOCK_TYPE.TEXT,
    text: {
      elements: [textElement(text)],
      style: {},
    },
  };
}

function headingBlock(level: 1 | 2 | 3 | 4 | 5 | 6, text: string): FeishuBlock {
  const typeMap = {
    1: BLOCK_TYPE.HEADING1,
    2: BLOCK_TYPE.HEADING2,
    3: BLOCK_TYPE.HEADING3,
    4: BLOCK_TYPE.HEADING4,
    5: BLOCK_TYPE.HEADING5,
    6: BLOCK_TYPE.HEADING6,
  };
  const blockType = typeMap[level];
  const key = `heading${level}`;
  return {
    block_type: blockType,
    [key]: {
      elements: [textElement(text)],
      style: {},
    },
  };
}

function bulletBlock(text: string): FeishuBlock {
  return {
    block_type: BLOCK_TYPE.BULLET,
    bullet: {
      elements: [textElement(text)],
      style: {},
    },
  };
}

function orderedBlock(text: string): FeishuBlock {
  return {
    block_type: BLOCK_TYPE.ORDERED,
    ordered: {
      elements: [textElement(text)],
      style: {},
    },
  };
}

function codeBlock(code: string, lang = "PlainText"): FeishuBlock {
  return {
    block_type: BLOCK_TYPE.CODE,
    code: {
      elements: [textElement(code)],
      style: { language: 1, wrap: false },
    },
  };
}

function dividerBlock(): FeishuBlock {
  return { block_type: BLOCK_TYPE.DIVIDER, divider: {} };
}

function markdownToBlocks(md: string): FeishuBlock[] {
  const lines = md.split("\n");
  const blocks: FeishuBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || "PlainText";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push(codeBlock(codeLines.join("\n"), lang));
      continue;
    }

    // Divider
    if (/^[-*_]{3,}\s*$/.test(line)) {
      blocks.push(dividerBlock());
      i++;
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const safeLevel = Math.min(level, 6) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push(headingBlock(safeLevel, headingMatch[2]));
      i++;
      continue;
    }

    // Unordered list
    const bulletMatch = line.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      blocks.push(bulletBlock(bulletMatch[1]));
      i++;
      continue;
    }

    // Ordered list
    const orderedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (orderedMatch) {
      blocks.push(orderedBlock(orderedMatch[1]));
      i++;
      continue;
    }

    // Empty line → skip (don't create empty paragraphs)
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Normal paragraph
    blocks.push(paragraphBlock(line));
    i++;
  }

  return blocks;
}

// ── 向文档追加内容 ────────────────────────────────────────────────────────────

async function appendToDoc(documentId: string, markdownText: string) {
  // Root block ID == document_id (no need to fetch)
  const rootBlockId = documentId;

  const newBlocks = markdownToBlocks(markdownText);
  if (newBlocks.length === 0) return { inserted: 0 };

  const data = await req<{ children: unknown[] }>(
    "POST",
    `/docx/v1/documents/${documentId}/blocks/${rootBlockId}/children`,
    {
      children: newBlocks,
      index: -1, // append to end
    },
  );
  return { inserted: data.children?.length ?? newBlocks.length };
}

// ── 清空文档并写入新内容 ───────────────────────────────────────────────────────

async function replaceDoc(documentId: string, markdownText: string) {
  // Root block ID == document_id
  const rootBlockId = documentId;

  // Get root block to find its children
  const rootData = await req<{ block: Block }>(
    "GET",
    `/docx/v1/documents/${documentId}/blocks/${rootBlockId}`,
  );
  const childIds: string[] = rootData.block?.children ?? [];

  // 2. Batch delete existing children
  if (childIds.length > 0) {
    await req(
      "DELETE",
      `/docx/v1/documents/${documentId}/blocks/${rootBlockId}/children/batch_delete`,
      {
        start_index: 0,
        end_index: childIds.length,
      },
    );
  }

  // 3. Insert new blocks
  const newBlocks = markdownToBlocks(markdownText);
  if (newBlocks.length === 0) return { replaced: 0 };

  const data = await req<{ children: unknown[] }>(
    "POST",
    `/docx/v1/documents/${documentId}/blocks/${rootBlockId}/children`,
    {
      children: newBlocks,
      index: 0,
    },
  );
  return { replaced: data.children?.length ?? newBlocks.length };
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

export async function main(args: string[]) {
  const [cmd, ...rest] = args;

  switch (cmd) {
    case "info": {
      const info = await getDocInfo(rest[0]);
      console.log(JSON.stringify(info, null, 2));
      break;
    }
    case "read": {
      const content = await readDocContent(rest[0]);
      console.log(content);
      break;
    }
    case "blocks": {
      const blocks = await getBlocks(rest[0]);
      console.log(JSON.stringify(blocks, null, 2));
      break;
    }
    case "create": {
      const doc = await createDoc(rest[0], rest[1]);
      console.log(JSON.stringify(doc, null, 2));
      break;
    }
    case "append": {
      const result = await appendToDoc(rest[0], rest.slice(1).join(" "));
      console.log(JSON.stringify(result));
      break;
    }
    case "replace": {
      const result = await replaceDoc(rest[0], rest.slice(1).join(" "));
      console.log(JSON.stringify(result));
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Usage: feishu_doc.ts <info|read|blocks|create|append|replace> [args...]");
      Deno.exit(1);
  }
}

if (import.meta.main) {
  main(Deno.args).catch((e) => {
    console.error(e.message);
    Deno.exit(1);
  });
}

export { getDocInfo, readDocContent, getBlocks, createDoc, appendToDoc, replaceDoc, markdownToBlocks };
