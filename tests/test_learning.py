"""End-to-end through the web API (offline extractor): learning from reviewers, partial approval,
the reading cache and the batch queue.   python tests/test_learning.py"""
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
tmp = tempfile.mkdtemp()
os.environ["CHECKPOINT_DB"] = f"{tmp}/t.db"
os.environ["CHECKPOINT_UPLOADS"] = f"{tmp}/up"
for k in ("GROQ_API_KEY", "GEMINI_API_KEY"):
    os.environ.pop(k, None)

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from tests.fixture_extractor import fixture_extractor  # noqa: E402

main.EXTRACTOR = fixture_extractor
c = TestClient(main.app)


def run(sample):
    rid = c.post(f"/api/runs/sample/{sample}.pdf").json()["id"]
    for _ in range(200):
        r = c.get(f"/api/runs/{rid}").json()
        if r["status"] in ("done", "error"):
            return r
        time.sleep(0.05)
    raise TimeoutError(sample)


def codes(r):
    return [f["code"] for f in r["findings"]]


def test_learning_and_partial():
    c.post("/api/reset")
    # 1. PO memory: ambiguous until a reviewer picks the PO, then remembered for next month's bill
    r10 = run("10_learn_next_month_freight_sunrise")
    assert r10["decision"] == "HOLD" and "PO_AMBIGUOUS" in codes(r10)
    r05 = run("05_edge_no_po_two_candidates_sunrise")
    assert "PO_AMBIGUOUS" in codes(r05)
    nid = c.post(f"/api/runs/{r05['id']}/use-po", json={"po_number": "PO-2026-0162"}).json()["id"]
    for _ in range(200):
        rn = c.get(f"/api/runs/{nid}").json()
        if rn["status"] == "done":
            break
        time.sleep(0.05)
    assert rn["decision"] == "APPROVE", rn["headline"]
    c.put("/api/settings", json={"reuse_readings": False})
    r10b = run("10_learn_next_month_freight_sunrise")
    assert r10b["decision"] == "APPROVE" and "PO_REMEMBERED" in codes(r10b), (r10b["decision"], codes(r10b))
    c.put("/api/settings", json={"reuse_readings": True})

    # 2. Verified bank change updates the vendor master; the next invoice goes straight through
    r11 = run("11_learn_new_bank_acme")
    assert r11["decision"] == "HOLD" and "BANK_CHANGED" in codes(r11)
    r06 = run("06_edge_bank_details_changed_acme")
    resp = c.post(f"/api/runs/{r06['id']}/review", json={"action": "approve", "note": "Called +91 80 4123 5500, confirmed",
                                                         "update_vendor_bank": True})
    assert resp.status_code == 200 and "vendor master" in resp.json()["reviewer_note"]
    r11b = run("11_learn_new_bank_acme")
    # same file as before -> exact duplicate? No: 11 was only held, never posted, so it's not in the ledger
    assert r11b["decision"] == "APPROVE", (r11b["decision"], codes(r11b))
    assert "READING_REUSED" in codes(r11b)          # same file fingerprint -> no second AI call

    # 3. Partial approval on a PO overrun posts only what's left on the PO
    r03 = run("03_edge_split_po_overrun_precision")
    resp = c.post(f"/api/runs/{r03['id']}/review", json={"action": "approve_partial", "note": "Pay balance, credit note asked"})
    assert resp.status_code == 200
    led = [l for l in c.get("/api/reference").json()["ledger"] if l["run_id"] == r03["id"]][0]
    assert abs(led["subtotal"] - 100000) < 0.01 and abs(led["total"] - 118000) < 0.01, led
    assert "Short-paid" in led["status"]

    # 4. Batch: all samples queue and finish
    ids = c.post("/api/runs/samples").json()["ids"]
    assert len(ids) == 9
    for _ in range(400):
        if all(c.get(f"/api/runs/{i}").json()["status"] == "done" for i in ids):
            break
        time.sleep(0.05)
    assert all(c.get(f"/api/runs/{i}").json()["status"] == "done" for i in ids)


if __name__ == "__main__":
    test_learning_and_partial()
    print("learning, partial approval, cache and batch: all pass")
