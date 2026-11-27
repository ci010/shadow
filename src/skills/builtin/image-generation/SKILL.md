---
name: image-generation
description: "Generate an inline image in private Shadow Web chat using a saved OpenRouter provider. Use the on-demand generate_image tool for text-to-image with fresh owner confirmation; not for local Stable Diffusion, image editing, or saving workspace files."
metadata:
  category: tools
---

# Generate an image in chat with OpenRouter

Use this workflow only when the owner explicitly asks to generate an image in a new message in a local, private Shadow Web conversation. This is a paid provider route, not a way to silently satisfy a request for local generation. For local generation or supported reference-image editing, see `v:skills/diffusion-cpp`.

1. Prepare the exact prompt to send (nonempty, up to 2,000 characters). Include only what the owner wants sent to OpenRouter; do not copy private conversation or workspace context into it by default.
2. Call the built-in dynamic tool directly through the gateway:

   ```js
   invoke_tool({ name: "generate_image", args: { prompt: "A watercolor fox in a snowy pine forest" } })
   ```

   Omit `provider` and `model` to use the saved `openrouter` connection and `bytedance-seed/seedream-4.5`. If the owner requests another saved OpenRouter connection or image model, pass the exact ID. The image model is independent of the chat model. The live contract is at `v:tools/generate_image`; no script or separate import is required.
3. The tool opens its own confirmation with the exact prompt, provider and model. Wait for it. Do not separately ask for payment approval, infer approval from chat text, or send an OpenRouter request yourself. Decline, cancellation or expiry sends nothing. If the provider is missing, direct the owner to the saved provider settings; never request an API key in chat.
4. On success, the image is already attached to the chat tool result; no workspace file is created. If the outcome is uncertain, charges may have occurred. Report the uncertainty and check the provider outcome before considering a new attempt; never retry automatically.

This path generates one text-to-image raster attachment. It does not accept reference images, edit images, or run from BOT, automation, delegated, remote-device, or LayerFS turns. It does not fall back to another provider or a local model.
