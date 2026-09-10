---
name: markitdown
description: 'Convert files and URLs to Markdown using Microsoft MarkItDown. Supports PDF, Word, Excel, PowerPoint, images (OCR), audio (transcription), HTML, CSV, JSON, XML, ZIP, EPub, YouTube URLs, and more. Prefer over pdfplumber when you need a single unified tool that handles many formats. Triggers include "convert to markdown", "extract text from PDF/docx/xlsx/pptx", "read a Word file", "parse Excel as text", "transcribe audio".'
metadata:
  category: conversion
---

# MarkItDown — Universal File-to-Markdown Converter

Microsoft MarkItDown converts virtually any file format to clean Markdown for LLM consumption or text analysis.

## When to Use

✅ USE when:
- Converting PDF, Word (.docx), Excel (.xlsx/.xls), PowerPoint (.pptx) to text
- Extracting text from images (OCR) or audio files (transcription)
- Parsing HTML, CSV, JSON, XML into readable Markdown
- Processing EPubs, ZIP archives (iterates contents), YouTube URLs
- You want one tool that handles many formats uniformly

❌ DON'T use when:
- Fine-grained PDF table extraction with layout coordinates → use `pdfplumber`
- You only need raw text with no structure preserved → `cat` / `exec` is enough

---

## Installation

```bash
pip install 'markitdown[all]'
```

Optional dependency groups (install only what you need):

```bash
pip install 'markitdown[pdf]'       # PDF
pip install 'markitdown[docx]'      # Word
pip install 'markitdown[xlsx]'      # Excel (.xlsx)
pip install 'markitdown[xls]'       # Excel (.xls legacy)
pip install 'markitdown[pptx]'      # PowerPoint
pip install 'markitdown[outlook]'   # Outlook .msg files
pip install 'markitdown[audio-transcription]'   # WAV / MP3
pip install 'markitdown[youtube-transcription]' # YouTube URLs
pip install 'markitdown[az-doc-intel]'          # Azure Document Intelligence
pip install 'markitdown[pdf,docx,pptx]'         # Multiple at once
```

Verify:
```bash
markitdown --version
```

---

## CLI Usage

```bash
# Convert to stdout
markitdown path/to/file.pdf

# Save to file
markitdown path/to/file.docx -o output.md

# Pipe input
cat file.pdf | markitdown

# Convert a URL or YouTube link
markitdown https://example.com/article
markitdown https://www.youtube.com/watch?v=XXXX

# With plugins enabled
markitdown --use-plugins path/to/file.pdf

# List installed plugins
markitdown --list-plugins
```

---

## Python API

```python
from markitdown import MarkItDown

md = MarkItDown()

# Convert a file
result = md.convert("report.pdf")
print(result.text_content)

# Convert a URL
result = md.convert("https://example.com/page")

# Convert from a stream
with open("report.xlsx", "rb") as f:
    result = md.convert_stream(f, file_extension=".xlsx")
print(result.text_content)
```

### With LLM for image / PPTX descriptions

```python
from markitdown import MarkItDown
from openai import OpenAI

client = OpenAI()
md = MarkItDown(llm_client=client, llm_model="gpt-4o")

result = md.convert("slide_deck.pptx")
print(result.text_content)
```

### With Azure Document Intelligence (high-quality PDF OCR)

```bash
# CLI
markitdown file.pdf -o out.md -d -e "https://<your-endpoint>.cognitiveservices.azure.com/"
```

```python
md = MarkItDown(docintel_endpoint="https://<your-endpoint>.cognitiveservices.azure.com/")
result = md.convert("scanned.pdf")
```

---

## Common Patterns

### Batch-convert a folder

```python
from markitdown import MarkItDown
from pathlib import Path

md = MarkItDown()
for p in Path("docs/").glob("**/*.pdf"):
    result = md.convert(str(p))
    Path(p).with_suffix(".md").write_text(result.text_content)
```

### Extract text from an embedded ZIP

```bash
# MarkItDown iterates ZIP contents automatically
markitdown archive.zip -o extracted.md
```

### Read Excel as Markdown table

```python
md = MarkItDown()
result = md.convert("data.xlsx")
print(result.text_content)   # Sheets rendered as Markdown tables
```

---

## Gotchas

- **`[all]` for safety**: dependency groups exist so you can install lightly, but if unsure just use `markitdown[all]`.
- **Binary streams only**: `convert_stream()` requires a binary file-like object (open in `"rb"` mode or `io.BytesIO`), not `io.StringIO`.
- **OCR on images**: included in `[all]`; produces EXIF metadata + OCR text. Quality depends on image clarity.
- **Audio transcription**: requires `[audio-transcription]`; WAV and MP3 supported.
- **YouTube**: fetches the video transcript (captions), not an AI transcription — requires captions to exist.
- **Output is LLM-optimised, not print-optimised**: structure is preserved but visual fidelity may differ from the original.
