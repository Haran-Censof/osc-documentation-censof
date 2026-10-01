"""Converts each SDS .docx listed in sds-manifest.json into plain Markdown.

Output goes to source/sds-extract/ (git-ignored: SDS content is client material and
must not be pushed to the public docs repo). Headings, paragraphs and tables are kept
in document order so later steps can locate use cases by section.

Usage:  python scripts/extract-sds.py [module-id ...]
"""
import json
import re
import sys
from pathlib import Path

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "source" / "sds-extract"


def heading_level(paragraph):
    name = (paragraph.style.name or "") if paragraph.style is not None else ""
    match = re.match(r"(?:Heading|Tajuk)\s*(\d)", name, re.I)
    if match:
        return int(match.group(1))
    return 1 if name.lower() == "title" else 0


def cell_text(cell):
    return " ".join(cell.text.split()).replace("|", "\\|")


def table_to_md(table):
    rows = []
    for row in table.rows:
        cells, previous = [], None
        for cell in row.cells:
            # Merged cells repeat the same underlying element; keep one copy.
            if cell._tc is previous:
                continue
            previous = cell._tc
            cells.append(cell_text(cell))
        rows.append(cells)
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + " --- |" * width]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(lines)


def convert(path):
    doc = Document(str(path))
    blocks, headings = [], []
    for child in doc.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            paragraph = Paragraph(child, doc)
            text = " ".join(paragraph.text.split())
            if not text:
                continue
            level = heading_level(paragraph)
            if level:
                headings.append({"level": level, "text": text})
                blocks.append("#" * level + " " + text)
            else:
                blocks.append(text)
        elif tag == "tbl":
            md = table_to_md(Table(child, doc))
            if md:
                blocks.append(md)
    return "\n\n".join(blocks) + "\n", headings


def main():
    manifest = json.loads((ROOT / "scripts" / "sds-manifest.json").read_text(encoding="utf-8"))
    base = Path(manifest["base"])
    wanted = set(sys.argv[1:])
    OUT.mkdir(parents=True, exist_ok=True)
    summary = []
    for module in manifest["modules"]:
        if wanted and module["id"] not in wanted:
            continue
        source = base / module["file"]
        if not source.exists():
            print(f"MISSING  {module['id']}: {source}")
            continue
        text, headings = convert(source)
        (OUT / f"{module['id']}.md").write_text(text, encoding="utf-8")
        (OUT / f"{module['id']}.headings.json").write_text(
            json.dumps(headings, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        summary.append({**module, "chars": len(text), "headings": len(headings)})
        print(f"ok       {module['id']:32} {len(text):>8} chars  {len(headings):>4} headings")
    if not wanted:
        (OUT / "index.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
