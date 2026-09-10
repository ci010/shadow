---
name: pandoc
description: "Install pandoc and use it to convert documents (RST, LaTeX, EPUB, etc.) to Markdown. Use when asked to convert a document to markdown or extract text from a file."
metadata:
  category: conversion
---

# Pandoc Skill

Use `pandoc` to convert documents between formats. The primary use case here is converting various document types **to Markdown**.

## Install Pandoc

See [INSTALL.md](INSTALL.md) for full installation instructions (macOS, Linux, Windows, Conda, Docker).

---

## Convert Documents to Markdown

### Word (.docx) → Markdown

```bash
pandoc input.docx -o output.md
```

### HTML → Markdown

```bash
pandoc input.html -t markdown -o output.md
```

Or from a URL directly:

```bash
pandoc "https://example.com/page" -t markdown -o output.md
```

### PDF → Markdown

PDF conversion requires a PDF-to-text extraction step first (pandoc does not read PDF natively):

```bash
pdftotext input.pdf - | pandoc -f plain -t markdown -o output.md
```

Or use pandoc with pdflatex if the PDF has embedded text:

```bash
pandoc input.pdf -t markdown -o output.md
```

### RST / LaTeX / EPUB / ODT → Markdown

```bash
pandoc input.rst    -t markdown -o output.md
pandoc input.tex    -t markdown -o output.md
pandoc input.epub   -t markdown -o output.md
pandoc input.odt    -t markdown -o output.md
```

---

## Useful Options

| Option | Description |
|--------|-------------|
| `-t markdown` | Output format: standard Markdown |
| `-t gfm` | Output format: GitHub-Flavoured Markdown |
| `--wrap=none` | Disable line wrapping in output |
| `--extract-media=./media` | Save embedded images to a folder |
| `--strip-comments` | Remove HTML/XML comments |

### Example: DOCX to GFM with images extracted

```bash
pandoc input.docx -t gfm --extract-media=./media --wrap=none -o output.md
```

---

## Notes

- Always check `pandoc --list-input-formats` and `pandoc --list-output-formats` to see all supported formats.
- For best results with complex Word documents, use `-t gfm` (GitHub-Flavoured Markdown).
- If the source file is in the uploads directory, reference it as `uploads/<filename>`.
