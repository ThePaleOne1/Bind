"""Convert 'Pokemon Artists.xlsx' into src/data/artistsSeed.json.

Layout of the sheet (rows 7+):
  B = artist not collecting, C = reason
  E = artist collecting (row - 6 = binder page), F = favourite rank, G = style
Run:  python scripts/import_artists.py [path-to.xlsx]
"""
import json, re, shutil, sys, tempfile, zipfile, os

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "Pokemon Artists.xlsx")
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "data", "artistsSeed.json")
FIRST_ROW = 7

tmp = os.path.join(tempfile.gettempdir(), "artists-import.xlsx")
shutil.copy(SRC, tmp)  # OneDrive placeholders refuse direct opens
z = zipfile.ZipFile(tmp)
ss = z.read("xl/sharedStrings.xml").decode("utf8")
strings = ["".join(re.findall(r"<t[^>]*>([^<]*)</t>", s)) for s in re.findall(r"<si>(.*?)</si>", ss, re.S)]
sheet = z.read("xl/worksheets/sheet1.xml").decode("utf8")
rows = {}
for col, row, attrs, inner in re.findall(r'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', sheet, re.S):
    m = re.search(r"<v>([^<]*)</v>", inner or "")
    if not m:
        continue
    v = strings[int(m.group(1))] if 't="s"' in attrs else m.group(1)
    rows.setdefault(int(row), {})[col] = v.strip()

def clean(s):
    return None if s in (None, "", "`") else s

artists, pages = [], []
seen = set()
last_row = max(rows)
for r in range(FIRST_ROW, last_row + 1):
    c = rows.get(r, {})
    nc = clean(c.get("B"))
    if nc and nc.lower() not in seen:
        seen.add(nc.lower())
        artists.append({"name": nc, "status": "not-collecting", "reason": clean(c.get("C"))})
    col = clean(c.get("E"))
    page = r - FIRST_ROW + 1
    if col:
        name = col.split(" - ")[0].strip()
        note = col.split(" - ")[1].strip() if " - " in col else None
        fav = clean(c.get("F"))
        if name.lower() not in seen:
            seen.add(name.lower())
            artists.append({
                "name": name, "status": "collecting",
                "favourite": int(fav) if fav and fav.isdigit() else None,
                "style": clean(c.get("G")), "note": note, "binderPage": page,
            })
        pages.append({"page": page, "artist": name})
    elif page <= 36:
        pages.append({"page": page, "artist": None})

# Trim trailing empty pages beyond the collecting block
while pages and pages[-1]["artist"] is None and len(pages) > 36:
    pages.pop()

json.dump({"artists": artists, "pages": pages}, open(OUT, "w", encoding="utf8"), indent=2, ensure_ascii=False)
print(f"{len(artists)} artists, {len(pages)} binder pages -> {OUT}")
