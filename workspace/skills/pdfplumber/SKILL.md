---
name: pdfplumber
description: 'Use pdfplumber (Python library) for programmatic PDF parsing: extracting text with layout/bounding-box precision, table rows/cells as structured data, and page-level control. Use when you need to process PDF content in code — not just read it. For simple "give me the text" tasks, prefer markitdown.'
metadata:
  category: conversion
---

# pdfplumber — Programmatic PDF Parsing

Use when you need **structured, programmatic access** to PDF content: iterating pages, extracting table rows as Python lists, filtering by bounding box, or building a custom pipeline. For plain text conversion use `markitdown` instead.

## When to Use

✅ USE pdfplumber when:
- You need table data as structured rows/cells (not just text)
- You need bounding-box / coordinate-based extraction
- You are writing a script that processes many PDFs in a loop
- Text ordering from simpler tools comes out scrambled

❌ Use `markitdown` instead when:
- You just want the text or markdown from a PDF
- The PDF is scanned/image-only (needs OCR) → `markitdown` with Azure Doc Intel
- The file is DOCX, XLSX, HTML, or any non-PDF format

## Installation

```bash
pip3 install pdfplumber --break-system-packages
python3 -c "import pdfplumber; print('ok')"
```

---

## Core API

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    print(len(pdf.pages))            # page count

    page = pdf.pages[0]              # zero-indexed
    text = page.extract_text()       # plain text, top-to-bottom order
    tables = page.extract_tables()   # list[list[list[str]]] — rows of cells
    words  = page.extract_words()    # list of word dicts with x0/y0/x1/y1
    chars  = page.chars             # raw character objects with coordinates
```

---

## Common Patterns

### Text: all pages to Markdown

```python
import pdfplumber

output = []
with pdfplumber.open("document.pdf") as pdf:
    for i, page in enumerate(pdf.pages):
        text = page.extract_text()
        if text:
            output.append(f"## Page {i+1}\n\n{text}")

with open("output.md", "w") as f:
    f.write("\n\n---\n\n".join(output))
```

### Tables: extract as structured data

```python
import pdfplumber, json

results = []
with pdfplumber.open("report.pdf") as pdf:
    for i, page in enumerate(pdf.pages):
        for table in page.extract_tables():
            # table is list[list[str]] — first row is often headers
            results.append({"page": i + 1, "rows": table})

print(json.dumps(results, ensure_ascii=False, indent=2))
```

### Crop: extract only a region

```python
with pdfplumber.open("document.pdf") as pdf:
    page = pdf.pages[0]
    # crop(x0, top, x1, bottom) — coordinates in PDF points
    region = page.crop((0, 0, page.width, page.height / 2))
    print(region.extract_text())
```

### Specific pages only

```python
with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages[2:5]:   # pages 3–5
        print(page.extract_text())
```

---

## Image Extraction (pymupdf render + crop)

**Do NOT use `pdfplumber` or pymupdf's `extract_image()` for images** — both produce corrupted/black output. Render the page, then crop by image rect.

```bash
pip3 install pymupdf pillow --break-system-packages
```

```python
import fitz  # pymupdf
from PIL import Image
import os

os.makedirs("images", exist_ok=True)
doc = fitz.open("document.pdf")
scale = 2   # 2x resolution

seen = set()
for page_num in range(len(doc)):
    page = doc[page_num]
    imgs = page.get_images(full=True)
    if not imgs:
        continue
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
    page_img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

    for j, img in enumerate(imgs):
        rects = page.get_image_rects(img[0])
        if not rects:
            continue
        r = rects[0]
        key = (page_num, round(r.x0), round(r.y0), round(r.x1), round(r.y1))
        if key in seen:
            continue
        seen.add(key)
        box = (int(r.x0*scale), int(r.y0*scale), int(r.x1*scale), int(r.y1*scale))
        out = f"images/p{page_num+1}_{j+1}.png"
        page_img.crop(box).save(out)
        print(f"Saved {out}")
```

| Method | Result |
|--------|--------|
| `pdfplumber` stream `frombytes` | ❌ Black — raw undecoded bytes |
| `pymupdf extract_image()` | ❌ Black — SMask alpha corruption |
| pymupdf render + crop by rect | ✅ Correct |

---

## Notes

- Text layer only — scanned (image-only) PDFs return `None` from `extract_text()`. Use `markitdown` + OCR for those.
- Install with `--break-system-packages` on macOS (Homebrew-managed Python).
- `extract_text()` order is top-to-bottom, left-to-right within each page.
- Deduplicate images by `(page, x0, y0, x1, y1)` — PDFs often reference the same xref multiple times per page.
