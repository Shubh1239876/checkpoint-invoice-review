"""Persistence: SQLite for runs, the invoice ledger, and editable rule settings."""
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
DB_PATH = Path(os.environ.get("CHECKPOINT_DB", DATA_DIR / "checkpoint.db"))
UPLOAD_DIR = Path(os.environ.get("CHECKPOINT_UPLOADS", DATA_DIR / "uploads"))
_lock = threading.Lock()

DEFAULT_SETTINGS = {
    "amount_tolerance_pct": 1.0,        # invoice may exceed remaining PO by this % ...
    "amount_tolerance_abs": 500.0,      # ... or this many rupees, whichever is lower
    "price_tolerance_pct": 1.0,         # unit price may exceed PO price by this %
    "auto_approve_limit": 1000000.0,    # above this, a finance manager must approve
    "max_invoice_age_days": 180,
    "min_field_confidence": 0.80,
    "po_inference_min_score": 75,
    "po_inference_min_gap": 15,
    "duplicate_hold_score": 70,
    "reuse_readings": True,             # same file fingerprint -> reuse the earlier AI reading
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT, filename TEXT, file_hash TEXT, file_path TEXT,
  status TEXT, decision TEXT, headline TEXT,
  vendor_id TEXT, vendor_name TEXT, invoice_number TEXT, total REAL, po_number TEXT,
  stages_json TEXT, extraction_json TEXT, findings_json TEXT, explanation_json TEXT,
  review_status TEXT, reviewer_note TEXT, reviewed_at TEXT,
  duration_ms INTEGER, error TEXT
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT, vendor_id TEXT, po_number TEXT, invoice_date TEXT,
  subtotal REAL, total REAL, status TEXT, paid_on TEXT, source TEXT, run_id INTEGER
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS vendor_updates (
  vendor_id TEXT PRIMARY KEY, bank_account TEXT, ifsc TEXT, bank_name TEXT,
  updated_at TEXT, run_id INTEGER, note TEXT
);
CREATE TABLE IF NOT EXISTS po_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id TEXT, description TEXT, po_number TEXT,
  run_id INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS reading_cache (
  file_hash TEXT PRIMARY KEY, extraction_json TEXT, meta_json TEXT, run_id INTEGER, created_at TEXT
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _conn():
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init(reset: bool = False):
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as c:
        if reset:
            c.executescript("DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS ledger; DROP TABLE IF EXISTS settings; "
                            "DROP TABLE IF EXISTS vendor_updates; DROP TABLE IF EXISTS po_memory; DROP TABLE IF EXISTS reading_cache;")
            for f in UPLOAD_DIR.glob("*"):
                f.unlink()
        c.executescript(SCHEMA)
        if c.execute("SELECT COUNT(*) FROM ledger").fetchone()[0] == 0:
            seed = json.loads((DATA_DIR / "ledger_seed.json").read_text())
            c.executemany(
                "INSERT INTO ledger (invoice_number, vendor_id, po_number, invoice_date, subtotal, total, status, paid_on, source) VALUES (?,?,?,?,?,?,?,?,?)",
                [(r["invoice_number"], r["vendor_id"], r["po_number"], r["invoice_date"],
                  r["subtotal"], r["total"], r["status"], r["paid_on"], r["source"]) for r in seed])
        for k, v in DEFAULT_SETTINGS.items():
            c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, json.dumps(v)))


# ---------------------------------------------------------------- settings
def get_settings() -> dict:
    with _conn() as c:
        rows = c.execute("SELECT key, value FROM settings").fetchall()
    out = dict(DEFAULT_SETTINGS)
    out.update({r["key"]: json.loads(r["value"]) for r in rows})
    return out


def update_settings(values: dict) -> dict:
    with _lock, _conn() as c:
        for k, v in values.items():
            if k in DEFAULT_SETTINGS:
                kind = type(DEFAULT_SETTINGS[k])
                v = (v in (True, 1, "1", "true", "on")) if kind is bool else kind(v)
                c.execute("REPLACE INTO settings (key, value) VALUES (?, ?)", (k, json.dumps(v)))
    return get_settings()


# ---------------------------------------------------------------- ledger
def ledger_rows() -> list[dict]:
    with _conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM ledger ORDER BY invoice_date DESC, id DESC")]


def post_to_ledger(run_id: int, inv: dict, status: str = "Approved - scheduled for payment"):
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO ledger (invoice_number, vendor_id, po_number, invoice_date, subtotal, total, status, paid_on, source, run_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (inv["invoice_number"], inv["vendor_id"], inv["po_number"], inv["invoice_date"],
             inv["subtotal"], inv["total"], status, None, "checkpoint", run_id))


# ---------------------------------------------------------------- runs
JSON_COLS = ("stages_json", "extraction_json", "findings_json", "explanation_json")


def create_run(filename: str, file_hash: str, file_path: str) -> int:
    with _lock, _conn() as c:
        cur = c.execute(
            "INSERT INTO runs (created_at, filename, file_hash, file_path, status, stages_json) VALUES (?,?,?,?,?,?)",
            (now_iso(), filename, file_hash, file_path, "queued", "[]"))
        return cur.lastrowid


def update_run(run_id: int, **fields):
    for k in list(fields):
        if k in JSON_COLS:
            fields[k] = json.dumps(fields[k])
    cols = ", ".join(f"{k} = ?" for k in fields)
    with _lock, _conn() as c:
        c.execute(f"UPDATE runs SET {cols} WHERE id = ?", (*fields.values(), run_id))


def _decode(r) -> dict:
    d = dict(r)
    for k in JSON_COLS:
        if d.get(k):
            d[k.removesuffix("_json")] = json.loads(d.pop(k))
        else:
            d[k.removesuffix("_json")] = d.pop(k)
    return d


def get_run(run_id: int) -> dict | None:
    with _conn() as c:
        r = c.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    return _decode(r) if r else None


def list_runs() -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT * FROM runs ORDER BY id DESC").fetchall()
    return [_decode(r) for r in rows]


def runs_with_hash(file_hash: str, exclude_id: int) -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT id, decision, created_at FROM runs WHERE file_hash = ? AND id != ? AND status = 'done'",
                         (file_hash, exclude_id)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- learning from reviewers
def vendor_updates() -> list[dict]:
    with _conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM vendor_updates")]


def save_vendor_update(vendor_id: str, bank_account: str, ifsc: str, run_id: int, note: str):
    with _lock, _conn() as c:
        c.execute("REPLACE INTO vendor_updates (vendor_id, bank_account, ifsc, bank_name, updated_at, run_id, note) "
                  "VALUES (?,?,?,?,?,?,?)", (vendor_id, bank_account, ifsc, None, now_iso(), run_id, note))


def po_memory(vendor_id: str | None = None) -> list[dict]:
    with _conn() as c:
        q, a = ("SELECT * FROM po_memory WHERE vendor_id = ? ORDER BY id DESC", (vendor_id,)) if vendor_id \
            else ("SELECT * FROM po_memory ORDER BY id DESC", ())
        return [dict(r) for r in c.execute(q, a)]


def remember_po(vendor_id: str, description: str, po_number: str, run_id: int):
    with _lock, _conn() as c:
        c.execute("INSERT INTO po_memory (vendor_id, description, po_number, run_id, created_at) VALUES (?,?,?,?,?)",
                  (vendor_id, description, po_number, run_id, now_iso()))


# ---------------------------------------------------------------- reading cache
def cached_reading(file_hash: str) -> dict | None:
    with _conn() as c:
        r = c.execute("SELECT * FROM reading_cache WHERE file_hash = ?", (file_hash,)).fetchone()
    return {"extraction": json.loads(r["extraction_json"]), "meta": json.loads(r["meta_json"]),
            "run_id": r["run_id"]} if r else None


def cache_reading(file_hash: str, extraction: dict, meta: dict, run_id: int):
    with _lock, _conn() as c:
        c.execute("INSERT OR IGNORE INTO reading_cache (file_hash, extraction_json, meta_json, run_id, created_at) "
                  "VALUES (?,?,?,?,?)", (file_hash, json.dumps(extraction), json.dumps(meta), run_id, now_iso()))
