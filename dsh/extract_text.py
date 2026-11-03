#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Extract plain text from a knowledge-base file.

Usage: python extract_text.py <path>
Stdout: JSON {"text": "...", "title": "..."} or {"error": "..."}
"""
import json
import os
import sys


def read_docx(path):
    from docx import Document
    doc = Document(path)
    parts = []
    for p in doc.paragraphs:
        if p.text and p.text.strip():
            style = (p.style.name or "") if p.style is not None else ""
            style_l = style.lower()
            if style_l.startswith("title") or style_l in ("heading 0", "heading0"):
                prefix = "# "
            elif style_l.startswith("heading 1"):
                prefix = "# "
            elif style_l.startswith("heading"):
                prefix = "## "
            else:
                prefix = ""
            parts.append(prefix + p.text.strip())
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip().replace("\n", " ") for c in row.cells]
            if any(cells):
                parts.append(" | ".join(cells))
    return "\n\n".join(parts)


def read_pptx(path):
    from pptx import Presentation
    prs = Presentation(path)
    parts = []
    for i, slide in enumerate(prs.slides, 1):
        parts.append("## Slide %d" % i)
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False) and shape.text_frame is not None:
                text = shape.text_frame.text.strip()
                if text:
                    parts.append(text)
    return "\n\n".join(parts)


def read_xlsx(path):
    from openpyxl import load_workbook
    wb = load_workbook(path, read_only=True, data_only=True)
    parts = []
    for ws in wb.worksheets:
        parts.append("## " + (ws.title or "Sheet"))
        for row in ws.iter_rows(values_only=True):
            cells = ["" if v is None else str(v) for v in row]
            if any(c.strip() for c in cells):
                parts.append(" | ".join(cells).rstrip(" |"))
    return "\n\n".join(parts)


def read_pdf(path):
    from pypdf import PdfReader
    reader = PdfReader(path)
    parts = []
    for i, page in enumerate(reader.pages, 1):
        text = page.extract_text() or ""
        if text.strip():
            parts.append("## Page %d\n\n%s" % (i, text.strip()))
    return "\n\n".join(parts)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing path"}))
        return 2
    path = sys.argv[1]
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".docx":
            text = read_docx(path)
        elif ext == ".pptx":
            text = read_pptx(path)
        elif ext == ".xlsx":
            text = read_xlsx(path)
        elif ext == ".pdf":
            text = read_pdf(path)
        else:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        text = text[:2000000]
        title = ""
        for line in text.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
        print(json.dumps({"text": text, "title": title}, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"error": "%s: %s" % (type(e).__name__, e)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
