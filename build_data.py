"""Turn the chapters/*.txt files into data/book.js for the reader app.

The data is emitted as a plain <script> assignment rather than JSON so the reader
works when opened directly from disk (file:// blocks fetch()).

Usage:
    python3 build_data.py
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CHAPTERS_DIR = ROOT / "chapters"
OUT = ROOT / "data" / "book.js"
BOOK_TITLE = "Haikyuu!! Genius Omni-System"


def load_order():
    """Chapter files in reading order, by the number in their filename."""
    files = sorted(CHAPTERS_DIR.glob("*.txt"))
    return [(int(re.search(r"(\d+)", f.stem).group(1)), f) for f in files]


def main() -> None:
    chapters = []
    for number, path in sorted(load_order(), key=lambda row: row[0]):
        lines = path.read_text(encoding="utf-8").split("\n")
        title = lines[0].strip()
        paragraphs = [ln.strip() for ln in lines[1:] if ln.strip()]
        if not paragraphs:
            raise SystemExit(f"{path.name} has no body text")
        chapters.append({"n": number, "t": title, "p": paragraphs})

    book = {"title": BOOK_TITLE, "chapters": chapters}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(book, ensure_ascii=False, separators=(",", ":"))
    OUT.write_text(f"window.BOOK = {payload};\n", encoding="utf-8")

    words = sum(len(" ".join(c["p"]).split()) for c in chapters)
    print(f"{len(chapters)} chapters, ~{words:,} words -> {OUT.relative_to(ROOT)} "
          f"({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
