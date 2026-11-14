"""Excel and PDF files built from the same payload the screen shows, so they always carry the same filters and numbers.

Spreadsheet safety: product names and notes are typed by salesmen. Text is always written as a *string* cell, so a value
such as `=HYPERLINK(...)` shows up as text in Excel and is never evaluated as a formula.
"""
import io
import re
from datetime import date
from xml.sax.saxutils import escape

from django.utils import timezone
from django.utils.text import slugify
from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

CONTENT_TYPES = {"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "pdf": "application/pdf"}
PDF_ROW_CAP = 1500
NUMERIC = {"int", "dec", "pct", "pct_opt", "change", "target", "rank", "mixed"}
NAVY, INK = "#0b2347", "#1e293b"


# ───────────────────────────── normalising the payload ─────────────────────────────

def month_text(v) -> str:
    m = re.match(r"^(\d{4})-(\d{2})$", str(v))
    return date(int(m.group(1)), int(m.group(2)), 1).strftime("%b %Y") if m else str(v)


def _x_kind(x):
    return {"day": "date", "month": "month"}.get(x, "text")


def export_tables(p: dict) -> list[dict]:
    """Rankings, charts (only when the report has no table) and tables as one uniform list."""
    out = []
    for r in p.get("rankings", []):
        kind = {"pct": "pct"}.get(r.get("format"), "int")
        out.append({
            "title": r["title"], "columns": [{"key": "rank", "label": "Rank", "kind": "rank"}, {"key": "name", "label": "Name", "kind": "text"},
                                             {"key": "value", "label": r.get("unit", "Value").capitalize(), "kind": kind}, {"key": "note", "label": "Detail", "kind": "text"}],
            "rows": r["rows"], "totals": None,
        })
    # A report whose only tables are small side tables (e.g. quantity by unit) still needs its chart data exported.
    if not any(not t.get("compact") for t in p.get("tables", [])):
        for c in p.get("charts", []):
            if c["type"] == "compare" or not c["points"]:
                continue
            if c["type"] == "segments":
                cols = [{"key": "label", "label": "Part", "kind": "text"}, {"key": "value", "label": "Count", "kind": "int"}]
            else:
                cols = [{"key": "label", "label": c["title"], "kind": _x_kind(c.get("x"))}] + [{"key": s["key"], "label": s["label"], "kind": "int"} for s in c["series"]]
            out.append({"title": c["title"], "columns": cols, "rows": c["points"], "totals": None})
    for t in p.get("tables", []):
        out.append({"title": t["title"], "columns": t["columns"], "rows": t["rows"], "totals": t.get("totals"), "total": t.get("total")})
    return out


def plain(kind, v, row) -> str:
    """Text form of a value for the PDF."""
    if kind == "mixed":
        kind = row.get("kind", "int")
    if v is None or v == "":
        return "-" if kind in ("pct_opt", "change") else ""
    if kind == "month":
        return month_text(v)
    if kind == "order":
        return f"#{v}"
    if kind == "pct" or kind == "pct_opt":
        return f"{v:g}%" if isinstance(v, (int, float)) else str(v)
    if kind == "change":
        return f"{v:+g}%" if isinstance(v, (int, float)) else str(v)
    if kind == "target":
        return "No target" if not v else f"{v:,}"
    if kind == "dec":
        return f"{v:,.1f}" if isinstance(v, (int, float)) else str(v)
    if isinstance(v, float):
        return f"{v:,.1f}"
    if isinstance(v, int):
        return f"{v:,}" if kind != "rank" else str(v)
    return str(v)


def cell_value(kind, v, row):
    """(value, number_format) for an Excel cell. Numbers stay numbers so the sheet can be sorted and summed."""
    if kind == "mixed":
        kind = row.get("kind", "int")
    if v is None or v == "":
        return None, None
    if kind == "month":
        return month_text(v), None
    if kind == "date":
        try:
            return date.fromisoformat(str(v)), "yyyy-mm-dd"
        except ValueError:
            return str(v), None
    if kind == "target":
        return ("No target", None) if not v else (v, "#,##0")
    if kind in ("order", "rank") and isinstance(v, int):
        return v, "0"
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return str(v), None
    fmt = {"pct": '0.0"%"', "pct_opt": '0.0"%"', "change": '+0.0"%";-0.0"%";0.0"%"', "dec": "0.0"}.get(kind)
    if fmt is None:
        fmt = "#,##0" if isinstance(v, int) else "#,##0.0"
    return v, fmt


def filename(p: dict, ext: str) -> str:
    r = p["meta"]["range"]
    span = f"{r['from']}_to_{r['to']}" if r["from"] else "all-time"
    return f"sales-master-{slugify(p['title']) or p['report']}-{span}.{ext}"


# ───────────────────────────── Excel ─────────────────────────────

def _sheet_name(title: str, used: set) -> str:
    base = re.sub(r"[\[\]\*\?/\\:]", "", title).strip()[:28] or "Sheet"
    name, n = base, 2
    while name.lower() in used:
        name = f"{base[:25]} {n}"
        n += 1
    used.add(name.lower())
    return name


def to_xlsx(p: dict) -> bytes:
    wb = Workbook(write_only=True)
    head_font, head_fill = Font(bold=True, color="FFFFFF"), PatternFill("solid", fgColor=NAVY.lstrip("#"))
    used: set = set()

    def text(ws, v, *, bold=False):
        c = WriteOnlyCell(ws, value=v)
        c.data_type = "s"  # never a formula, whatever the text starts with
        if bold:
            c.font = Font(bold=True)
        return c

    ws = wb.create_sheet(_sheet_name("Summary", used))
    ws.column_dimensions["A"].width = 28
    ws.column_dimensions["B"].width = 60
    ws.append([text(ws, p["title"], bold=True)])
    ws.append([text(ws, "Generated"), text(ws, timezone.localtime().strftime("%d %b %Y %H:%M"))])
    ws.append([text(ws, "Scope"), text(ws, "All company data" if p["meta"]["scope"] == "company" else "Own records only")])
    ws.append([])
    ws.append([text(ws, "Filters applied", bold=True)])
    for f in p["meta"]["filters"]:
        ws.append([text(ws, f["label"]), text(ws, f["value"])])
    for w in p.get("warnings", []):
        ws.append([text(ws, "Warning", bold=True), text(ws, w)])
    if p.get("cards"):
        ws.append([])
        ws.append([text(ws, "Key figures", bold=True)])
        for c in p["cards"]:
            v = c["value"]
            shown = plain({"pct": "pct", "change": "change", "dec": "dec"}.get(c["format"], "int"), v, {}) if not isinstance(v, str) else v
            ws.append([text(ws, c["label"]), text(ws, f"{shown}  {c['hint']}".strip())])
    if p.get("notes"):
        ws.append([])
        ws.append([text(ws, "Notes", bold=True)])
        for n in p["notes"]:
            ws.append([text(ws, n)])

    for t in export_tables(p):
        sh = wb.create_sheet(_sheet_name(t["title"], used))
        for i, c in enumerate(t["columns"], start=1):
            sh.column_dimensions[get_column_letter(i)].width = 38 if c["kind"] == "text" and c["key"] in ("items", "top_products", "notes") else 18 if c["kind"] != "text" else 26
        sh.freeze_panes = "A2"
        header = []
        for c in t["columns"]:
            h = text(sh, c["label"])
            h.font, h.fill, h.alignment = head_font, head_fill, Alignment(horizontal="center", vertical="center", wrap_text=True)
            header.append(h)
        sh.append(header)
        for row in t["rows"]:
            cells = []
            for c in t["columns"]:
                v, fmt = cell_value(c["kind"], row.get(c["key"]), row)
                if isinstance(v, str):
                    cells.append(text(sh, v))
                else:
                    x = WriteOnlyCell(sh, value=v)
                    if fmt:
                        x.number_format = fmt
                    cells.append(x)
            sh.append(cells)
        if t.get("totals"):
            cells = []
            for c in t["columns"]:
                v, fmt = cell_value(c["kind"], t["totals"].get(c["key"]), t["totals"])
                x = text(sh, v, bold=True) if isinstance(v, str) else WriteOnlyCell(sh, value=v)
                if not isinstance(v, str):
                    x.font = Font(bold=True)
                    if fmt:
                        x.number_format = fmt
                cells.append(x)
            sh.append(cells)
        if t.get("total") and t["total"] > len(t["rows"]):
            sh.append([text(sh, f"Showing {len(t['rows']):,} of {t['total']:,} rows.")])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ───────────────────────────── PDF ─────────────────────────────

def _pdf_text(s) -> str:
    s = str(s).replace("→", "->").replace("−", "-")
    return s.encode("cp1252", "replace").decode("cp1252")  # the built-in PDF fonts cannot draw other scripts


def to_pdf(p: dict) -> bytes:
    buf = io.BytesIO()
    page = landscape(A4)
    left = right = 12 * mm
    doc = SimpleDocTemplate(buf, pagesize=page, leftMargin=left, rightMargin=right, topMargin=12 * mm, bottomMargin=14 * mm, title=_pdf_text(p["title"]),
                            author="Sales Master")
    width = page[0] - left - right
    ss = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=ss["Title"], fontSize=17, leading=21, alignment=0, textColor=colors.HexColor(NAVY), spaceAfter=2)
    h2 = ParagraphStyle("h2", parent=ss["Heading2"], fontSize=11.5, leading=14, textColor=colors.HexColor(NAVY), spaceBefore=10, spaceAfter=4)
    body = ParagraphStyle("body", parent=ss["BodyText"], fontSize=8.5, leading=11, textColor=colors.HexColor("#475569"))
    cell = ParagraphStyle("cell", parent=ss["BodyText"], fontSize=7.5, leading=9.2, textColor=colors.HexColor(INK))
    cell_r = ParagraphStyle("cell_r", parent=cell, alignment=2)
    head = ParagraphStyle("head", parent=cell, textColor=colors.white, fontName="Helvetica-Bold")
    head_r = ParagraphStyle("head_r", parent=head, alignment=2)

    P = lambda s, st: Paragraph(escape(_pdf_text(s)), st)  # noqa: E731
    story = [P(p["title"], h1)]
    meta = p["meta"]
    story.append(P(" · ".join(f"{f['label']}: {f['value']}" for f in meta["filters"]), body))
    story.append(P(f"{'All company data' if meta['scope'] == 'company' else 'Own records only'} · generated {timezone.localtime():%d %b %Y %H:%M}", body))

    for w in p.get("warnings", []):
        story.append(P(f"Warning: {w}", ParagraphStyle("warn", parent=body, textColor=colors.HexColor("#92400e"), spaceBefore=3)))

    if p.get("cards"):
        cells = []
        for c in p["cards"]:
            v = c["value"]
            shown = v if isinstance(v, str) else plain({"pct": "pct", "change": "change", "dec": "dec"}.get(c["format"], "int"), v, {}) or "-"
            cells.append([P(shown, ParagraphStyle("kv", parent=cell, fontSize=13, leading=15, fontName="Helvetica-Bold")), P(c["label"], cell), P(c["hint"], cell)])
        per = min(6, len(cells))
        rows = [cells[i:i + per] for i in range(0, len(cells), per)]
        grid = [[Table([[x[0]], [x[1]], [x[2]]], colWidths=[width / per - 6]) for x in r] + [""] * (per - len(r)) for r in rows]
        t = Table(grid, colWidths=[width / per] * per)
        t.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd5e1")), ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
                               ("VALIGN", (0, 0), (-1, -1), "TOP"), ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc"))]))
        story += [Spacer(1, 6), t]

    for tb in export_tables(p):
        story.append(P(tb["title"], h2))
        cols = tb["columns"]
        rows = tb["rows"][:PDF_ROW_CAP]
        data = [[P(c["label"], head_r if c["kind"] in NUMERIC else head) for c in cols]]
        for r in rows:
            data.append([P(plain(c["kind"], r.get(c["key"]), r), cell_r if c["kind"] in NUMERIC else cell) for c in cols])
        if tb.get("totals"):
            data.append([P(plain(c["kind"], tb["totals"].get(c["key"]), tb["totals"]), ParagraphStyle("tot", parent=cell_r if c["kind"] in NUMERIC else cell, fontName="Helvetica-Bold")) for c in cols])
        weights = []
        for i, c in enumerate(cols):
            longest = max([len(str(c["label"]))] + [len(plain(c["kind"], r.get(c["key"]), r)) for r in rows[:200]])
            weights.append(min(max(longest, 6), 46))
        scale = width / sum(weights)
        t = Table(data, colWidths=[w * scale for w in weights], repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(NAVY)), ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
            ("TOPPADDING", (0, 0), (-1, -1), 2.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5), ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(t)
        total = tb.get("total") or len(tb["rows"])
        if total > len(rows):
            story.append(P(f"Showing {len(rows):,} of {total:,} rows. Download the Excel file for the complete list.", body))
        if not rows:
            story.append(P("No data for these filters.", body))

    for n in p.get("notes", []):
        story += [Spacer(1, 4), P(n, body)]

    def footer(canvas, d):
        canvas.saveState()
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.HexColor("#64748b"))
        canvas.drawString(left, 8 * mm, _pdf_text(f"Sales Master · {p['title']}"))
        canvas.drawRightString(page[0] - right, 8 * mm, f"Page {d.page}")
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()


def build_export(p: dict, fmt: str) -> tuple[bytes, str]:
    return (to_xlsx(p) if fmt == "xlsx" else to_pdf(p)), filename(p, fmt)
