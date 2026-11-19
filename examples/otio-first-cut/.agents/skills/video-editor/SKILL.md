---
name: video-editor
description: "Start a video edit from zero, plan a rough cut, or turn a Shadow OpenTimelineIO review into the next .otio version. 视频剪辑、分镜脚手架、diffusion.cpp 素材与逐帧批注。"
metadata:
  category: creative
---

# 剪辑助手：先做出可以讨论的第一刀

这是当前文件夹的可选 Skill，没有新增工具或权限。用户只想看示例时，指向同一文件夹的 `cut.otio`，不要创建工程。用户问“应该怎么剪”时给方案；明确要求开始或修改时才写文件。Shadow 的 viewer 始终只读，编辑发生在用户指定位置的一份新 OTIO 文档中。

## 从空项目到第一版

1. 确认作品要表达什么、已有素材在哪里，以及新工程要放在哪个工作区。已有答案不要再问；通常只缺一个问题，例如：“先用你手上的素材，还是先列三个镜头？”没有既定规格时可用 **24 fps，建立场景 2 秒 → 主镜头 4 秒 → 收束 2 秒** 作为可调整的起点；不要把它说成素材本身的帧率。
2. 用户要求创建工程后，在**指定工作区和所属设备**运行本 Skill 随附的 `scaffold.mjs`。从本示例根目录启动的写法（Windows 和 macOS 相同）：

   ```sh
   node .agents/skills/video-editor/scaffold.mjs "我的第一剪"
   ```

   参数是当前目录下一个**尚不存在**的文件夹名，不是绝对路径；`--help` 不写文件。命名冲突时改用明确的新名字，不清空或覆盖。不要把 `v:skills/...` 当作操作系统路径。没有 Node / 执行能力时，不自行安装或改在 Main 上跑；用被允许的文件工具在同一目标创建等价的 24 fps Timeline → Stack → Video Track → 三个具名 Gap，或者说明还缺什么权限。没有素材就保持 Gap，不写假的素材引用。
3. 验证并给出实际的 `cut-v001.otio` 路径和 `shots.md`。空的 `media/` 是给本工程素材的。让用户打开时间线，**先决定一个镜头**，例如：“主镜头用哪段视频？从哪一帧进，保留多久？”不要一开始就索要完整分镜表。
4. 写有画面的粗剪时，核对用户指定的本地素材、可解码类型、视频真实时长和帧率。以 `RationalTime(value, rate)` 记录入点和时长；Track 上的 Clip / Gap 按时长串接；Transition 占用两侧余量，不再增加总时长。复制或生成的素材应位于同一可浏览根内，`target_url` 相对 **OTIO 文件所在目录**，例如 `media/shot-02.webm`。素材位置或源时间不确定就询问，不猜测绝对路径、可用时长或源帧号。
5. 指明想生成素材不等于批准安装模型。需要 diffusion.cpp 时另读 `v:skills/diffusion-cpp`，依照生成/安装/许可要求；只引用实际返回的 PNG/WebM，经用户允许再复制到目标。这个示例自带视频，无需模型、联网或转码。

## 把一次批注变成下一版

- 让用户打开已解压的 `.otio`，选结构或轨道上的元素；要圈画面时暂停，用**画面批注 → 加入对话草稿**。加入草稿并不会自动发送或改片。
- 以批注的 `document.owner`、`path`、可用时的 `sha256` 和 `element.pointer` 找回那一版文件，核对元素类型、名称和范围。**`element` 是用户选中的对象；`monitor.clip` 是看到的画面，两者可能不是同一片段。** 名称不是 ID；重排后的 JSON Pointer 也不是跨版本 ID。若版本不符或视觉意图与所选元素冲突，先指出差异，请用户确认或重新选择。
- `playhead.relative` 是时间线位置；`sourceAtPlayhead` 是素材时间；`presentedMediaSeconds` 只有解码器报告时才有值。不要把它们当成同一个帧号。说“把入点推迟 6 帧”时，确认采用哪个 rate、时长是否保持及余量是否足够。
- 用一句话归纳要改什么，以及对切点/总时长的影响。按明确指令保留素材和原版，只写一个未占用的新版本，例如 `cut-v002.otio`，与上一版同目录以保持相对路径。核对媒体能解析，起止范围采用 `[start, end)`，可用时长和总帧数正确；让用户在新版本同一位置复看。不把成功写 JSON 说成已渲染成片。
- 需要最终视频时另行确定交付尺寸、帧率、音频和可用渲染器。Shadow 预览的转场是切点，不是溶解渲染；远程文本预览不等于可播放，不能用 Main 的同名素材顶替。
