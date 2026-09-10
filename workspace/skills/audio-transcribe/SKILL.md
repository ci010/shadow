---
name: audio-transcribe
description: >
  Transcribe audio files to text using the local STT (speech-to-text) service.
  Triggers when a message contains a file annotation like `[file: path/to/audio.mp3]`
  or when the user explicitly asks to "转写"、"识别语音"、"把这段语音转成文字" etc.
  Supported formats: wav, mp3, flac, ogg, opus, m4a, aac, webm, mp4.
  Always clarify intent before calling STT if the purpose is ambiguous (e.g. music vs. speech).
updatedAt: 2026-07-18T18:00:00Z
version: 2
metadata:
  category: conversion
---

# Audio Transcribe — 语音/音频文件转文字

使用本地 STT 服务将音频文件中的语音内容转写为文字。

## 何时使用

当消息中出现以下任意情况时触发：
- 消息包含 `[file: <路径>]` 且路径扩展名为音频格式（`.wav` `.mp3` `.flac` `.ogg` `.opus` `.m4a` `.aac` `.webm` `.mp4`）
- 用户明确要求"转写"、"识别语音"、"语音转文字"、"把这个音频转成文字"
- 用户发送了一段语音/录音并希望获得文字内容

**不要**在以下情况直接调用 STT：
- 用户明确表示这是音乐、歌曲，不需要转写
- 用户想要分析音频的音调、节奏、格式等技术参数（换用其他工具）

## 意图确认

收到音频文件后，**如果上下文中没有明确说明意图**，先询问用户：

> 收到了一个音频文件（`<文件名>`），请问你希望我：
> 1. **转写语音内容**（将对话/讲话转为文字）
> 2. 其他处理方式？

若用户此前已说明意图（如"帮我把这个会议录音转成文字"），则直接进行转写，无需再次询问。

## 获取 STT 服务地址

读取 bot 配置文件获取 STT 服务 URL。配置文件路径相对于 workspace 目录的上一级：

```bash
# workspace 通常是 ./workspace，config 在同级的 bot.config.json
cat ../bot.config.json | grep -A3 '"voice"'
```

取 `voice.sttUrl` 字段，例如 `http://192.168.31.186:8000/transcribe`。

若读取失败也可直接询问用户 STT 服务地址。

### 配置缺失处理

`voice.sttUrl` 字段可能在 `bot.config.json` 中不存在（例如配置文件未包含 voice 配置节）。遇到此情况：

1. **检查配置结构**：先确认 bot.config.json 是否存在，以及是否有 voice 配置节
   ```bash
   # 检查配置文件是否存在
   cat ../bot.config.json 2>/dev/null | head -20
   # 检查是否有 voice 字段
   cat ../bot.config.json | grep -o '"voice"' | head -1
   ```
2. **若 voice 配置完全缺失**：告知用户需要在 bot.config.json 中添加 voice.sttUrl 字段，格式为：
   ```json
   {
     "voice": {
       "sttUrl": "http://<你的STT服务地址>:<端口>/transcribe"
     }
   }
   ```
3. **临时方案**：请用户直接提供 STT 服务 URL，然后用该 URL 手动请求转写
4. **忽略该功能**：如果 STT 服务不可用且无法配置，告诉用户语音转写功能当前不可用

## 执行转写

### 方式一：curl（推荐，简单直接）

```bash
curl -s -X POST "<STT_URL>" \
  -F "file=@<音频文件绝对路径>" \
  --max-time 60
```

示例：
```bash
curl -s -X POST "http://192.168.31.186:8000/transcribe" \
  -F "file=@/path/to/workspace/uploads/feishu_om_xxx.ogg" \
  --max-time 60
```

### 方式二：Deno 脚本（跨平台，网络控制更精确）

```ts
// transcribe.ts
const filePath = Deno.args[0]
const sttUrl = Deno.args[1]

const form = new FormData()
const fileContent = await Deno.readFile(filePath)
const filename = filePath.split('/').pop() ?? 'audio.ogg'
form.append('file', new Blob([fileContent]), filename)

const res = await fetch(sttUrl, {
  method: 'POST',
  body: form,
  signal: AbortSignal.timeout(60_000),
})
const json = await res.json()
console.log(json.text)
```

```bash
deno run --allow-read --allow-net transcribe.ts "<音频路径>" "<STT_URL>"
```

## 响应格式

STT 服务返回 JSON：

```json
{
  "model": "VibeVoice-ASR",
  "duration": 14.2,
  "text": "这里是转写出来的全文",
  "segments": [...]
}
```

只取顶层 `text` 字段作为转写结果。

## 结果呈现

转写成功后，将结果完整呈现给用户：

```
📝 转写结果：

<转写全文>

（时长：14.2 秒）
```

若转写内容较长（>500 字），可按段落整理后呈现，并询问用户是否需要进一步处理（摘要、翻译、整理会议纪要等）。

## 错误处理

| 情况 | 处理方式 |
|------|---------|
| 文件路径不存在 | 告知用户文件可能未下载成功，请重新发送 |
| 格式不在支持列表 | 告知用户当前不支持该格式，支持格式：wav/mp3/flac/ogg/opus/m4a/aac/webm/mp4 |
| curl 超时（60s） | 告知用户 STT 服务响应超时，可稍后重试 |
| STT 服务返回错误 | 将状态码和错误信息告知用户 |
| `text` 字段为空 | 提示"未识别到语音内容，可能是静音或格式问题" |

## 文件路径说明

- 飞书文件：保存在 `workspace/uploads/<filename>`，消息中以 `[file: uploads/<filename>]` 出现
- Discord 附件：`workspace/uploads/discord_<id>.<ext>`
- WeChat 文件：`workspace/uploads/wechat/<filename>`
- Web 上传：`workspace/uploads/web_<timestamp>_<name>.<ext>`

文件路径若为相对路径，相对于 workspace 目录解析绝对路径后再传给 curl。
