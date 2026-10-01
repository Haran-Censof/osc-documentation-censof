"""Parses the SDS extracts (source/sds-extract/*.md) into structured use cases.

Nothing here is inferred: every use case, step, actor, screen and business rule is
read from the SDS's own tables:
  - Section 3  "Jadual Pemadanan Aktor Dengan Fungsi Sistem"  -> functions (SF-PL-..)
  - Section 4  screens + "Jadual Pemetaan Data"                -> screens, DB tables/fields
  - Section 5  "Rekabentuk Transaksi Sistem"                   -> use cases (UC-PL-..), business rules

Output: data/usecases/<module>.json and data/usecases/index.json

Usage:  python scripts/extract-sds.py && python scripts/extract-usecases.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source" / "sds-extract"
OUT = ROOT / "data" / "usecases"

ID_RE = re.compile(r"\b(UC|UI|SF)\s*-\s*PL((?:\s*-\s*[A-Z0-9]+)+)")
UC_COLUMNS = ["id", "name", "mainFlow", "alternatives", "actor", "input", "output", "uiRef", "integration", "notes"]


def norm(text):
    return re.sub(r"\s+", " ", text.lower().replace("&", "dan")).strip()


def clean_id(text):
    """'UC- PL-MO-PM-03-01' -> 'UC-PL-MO-PM-03-01'; returns None if no ID is present."""
    match = ID_RE.search(text.upper())
    if not match:
        return None
    return f"{match.group(1)}-PL{re.sub(r'\s+', '', match.group(2))}"


def all_ids(text, kind):
    return sorted({clean_id(m.group(0)) for m in ID_RE.finditer(text.upper()) if m.group(1) == kind})


def module_code(identifier):
    parts = identifier.split("-")
    return parts[2] if len(parts) > 2 else None


def split_row(line):
    cells = re.split(r"(?<!\\)\|", line.strip())[1:-1]
    return [c.strip().replace("\\|", "|") for c in cells]


def parse_blocks(text):
    """Yields ('heading', level, text) | ('para', text) | ('table', rows) in order."""
    table = []
    for line in text.splitlines():
        if line.startswith("|"):
            if not re.fullmatch(r"\|(\s*---\s*\|)+", line.strip()):
                table.append(split_row(line))
            continue
        if table:
            yield ("table", table)
            table = []
        if not line.strip():
            continue
        heading = re.match(r"(#+) (.*)", line)
        yield ("heading", len(heading.group(1)), heading.group(2).strip()) if heading else ("para", line.strip())
    if table:
        yield ("table", table)


def split_steps(text):
    """Splits '1. a 2. b' into ['a', 'b'], accepting only numbers in sequence."""
    marks, expected = [], 1
    for match in re.finditer(r"(?:^|(?<=\s))(\d{1,2})\.\s+", text):
        if int(match.group(1)) == expected:
            marks.append(match)
            expected += 1
    if not marks:
        return [text.strip()] if text.strip() else []
    return [text[m.end():(marks[i + 1].start() if i + 1 < len(marks) else len(text))].strip() for i, m in enumerate(marks)]


def split_alternatives(text):
    marks = list(re.finditer(r"(?:^|(?<=\s))(A\d{1,2})\s*[:.]\s*", text))
    if not marks:
        return [{"id": None, "text": text.strip()}] if text.strip() and text.strip() not in "-–" else []
    return [
        {"id": m.group(1), "text": text[m.end():(marks[i + 1].start() if i + 1 < len(marks) else len(text))].strip()}
        for i, m in enumerate(marks)
    ]


def split_list(text):
    return [p.strip() for p in re.split(r"\s*[/,;]\s*|\s+dan\s+", text) if p.strip() and p.strip() not in "-–"]


def parse_module(module):
    text = (SRC / f"{module['id']}.md").read_text(encoding="utf-8")
    code = module["code"]
    keep = (lambda identifier: module_code(identifier) == code) if module["combined"] else (lambda identifier: True)

    section = h2 = h3 = None
    functions, use_cases, screens, rule_groups = {}, {}, [], {}
    screen = None
    uc_groups_kept = set()
    issues = set()

    for block in parse_blocks(text):
        kind = block[0]
        if kind == "heading":
            _, level, title = block
            if level == 1:
                section, h2, h3, screen = norm(title), None, None, None
            elif level == 2:
                h2, h3, screen = title, None, None
            elif level == 3:
                h3 = title
                screen = None
                if section == "rekabentuk fungsian":
                    screen = {"title": title, "group": h2, "uiIds": [], "dataMap": []}
                    screens.append(screen)
            continue

        if kind == "para":
            if screen is not None:
                screen["uiIds"] = sorted(set(screen["uiIds"]) | set(all_ids(block[1], "UI")))
            continue

        rows = block[1]
        header = [norm(c) for c in rows[0]]

        # Section 3: actor/function mapping
        for row in rows:
            sf = next((clean_id(c) for c in row if re.match(r"\s*SF\s*-", c.upper())), None)
            if sf and len(row) >= 3 and keep(sf):
                index = next(i for i, c in enumerate(row) if clean_id(c) == sf)
                name = row[index + 1] if index + 1 < len(row) else ""
                actor = row[index + 2] if index + 2 < len(row) else ""
                functions.setdefault(sf, {"id": sf, "name": name, "actors": split_list(actor)})

        # Section 4: screen data mapping
        if screen is not None and header[:2] == ["nama label", "jenis objek"]:
            for row in rows[1:]:
                row = row + [""] * (6 - len(row))
                if not any(row[1:]):
                    continue  # sub-heading row inside the table
                screen["dataMap"].append({
                    "label": row[0], "objectType": row[1], "tables": split_list(row[2]),
                    "fields": split_list(row[3]), "crud": row[4], "note": row[5],
                })
        elif screen is not None and header[:2] == ["komponen", "sumber data"]:
            for row in rows[1:]:
                row = row + [""] * (4 - len(row))
                screen["dataMap"].append({
                    "label": row[0], "objectType": "", "tables": split_list(row[1]),
                    "fields": [row[2]] if row[2] else [], "crud": "R", "note": row[3],
                })

        # Section 5: use cases
        is_uc_table = header[:2] == ["id use case", "nama use case"]
        for row in rows[1:] if is_uc_table else rows:
            if is_uc_table:
                identifier = clean_id(row[0])
            else:
                identifier = clean_id(row[0]) if re.match(r"\s*UC\s*-", row[0].upper()) else None
            if not identifier or len(row) < 5 or not keep(identifier) or identifier in use_cases:
                continue
            if not identifier.startswith("UC-"):
                issues.add(f"Use-case table under '{h3}' uses non-UC identifiers (SF- prefix instead of UC-)")
            if "XXXX" in row[7].upper() if len(row) > 7 else False:
                issues.add(f"Use-case table under '{h3}' has placeholder UI references (UI-XXXXX)")
            cell = dict(zip(UC_COLUMNS, row + [""] * (len(UC_COLUMNS) - len(row))))
            use_cases[identifier] = {
                "id": identifier,
                "name": cell["name"],
                "group": h3,
                "actors": split_list(cell["actor"]),
                "steps": split_steps(cell["mainFlow"]),
                "alternatives": split_alternatives(cell["alternatives"]),
                "input": cell["input"],
                "output": cell["output"],
                "uiRefs": all_ids(cell["uiRef"], "UI"),
                "integration": cell["integration"],
                "notes": cell["notes"],
                "calls": [i for i in all_ids(cell["mainFlow"] + " " + cell["alternatives"], "UC") if i != identifier],
            }
            uc_groups_kept.add(h3)

        # Section 5: business rules (single-column tables under the transaction heading)
        if any(c.startswith("peraturan bisnes") for c in header) and len(header) <= 2:
            rule_groups.setdefault(h3, []).extend(
                {"code": r[0] if len(r) > 1 and r[0] else None, "text": r[-1]} for r in rows[1:] if r and r[-1]
            )

    ids = set(use_cases)
    for uc in use_cases.values():
        parts = uc["id"].split("-")
        uc["parentId"] = next(("-".join(parts[:n]) for n in range(len(parts) - 1, 3, -1) if "-".join(parts[:n]) in ids), None)
        uc["calls"] = [c for c in uc["calls"] if c in ids]

    if module["combined"]:
        name = norm(module["name"])
        screens = [s for s in screens if any(keep(i) for i in s["uiIds"]) or name in norm(s["group"] or "")]
        rule_groups = {g: r for g, r in rule_groups.items() if g in uc_groups_kept}

    return {
        "module": {k: module[k] for k in ("id", "name", "code", "version", "iteration")} | {"sourceFile": Path(module["file"]).name},
        "functions": list(functions.values()),
        "useCases": list(use_cases.values()),
        "screens": screens,
        "businessRules": [{"group": g, "rules": r} for g, r in rule_groups.items()],
        "sdsIssues": sorted(issues),
    }


def main():
    manifest = json.loads((ROOT / "scripts" / "sds-manifest.json").read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    for module in manifest["modules"]:
        data = parse_module(module)
        (OUT / f"{module['id']}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        tables = {t for s in data["screens"] for row in s["dataMap"] for t in row["tables"]}
        entry = {
            **data["module"],
            "functions": len(data["functions"]),
            "useCases": len(data["useCases"]),
            "topLevelUseCases": sum(1 for u in data["useCases"] if not u["parentId"]),
            "screens": len(data["screens"]),
            "businessRules": sum(len(g["rules"]) for g in data["businessRules"]),
            "dbTablesReferenced": len(tables),
            "sdsIssues": data["sdsIssues"],
        }
        index.append(entry)
        print(f"{module['id']:32} fn={entry['functions']:>3} uc={entry['useCases']:>3} (top {entry['topLevelUseCases']:>2}) "
              f"screens={entry['screens']:>3} rules={entry['businessRules']:>3} tables={entry['dbTablesReferenced']:>3}")
    (OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\ntotal use cases: {sum(e['useCases'] for e in index)}")


if __name__ == "__main__":
    main()
