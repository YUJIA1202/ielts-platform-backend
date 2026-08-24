from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path


parser = argparse.ArgumentParser(description="Verify normalized IELTS DOCX manifest invariants.")
parser.add_argument("--manifest", type=Path, default=Path("data/rag-docx-task2-v1/manifest.json"))
args = parser.parse_args()

manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
hard_errors = []
status_counts = Counter()
collection_counts = Counter()

for document in manifest["documents"]:
    name = document["fileName"]
    status_counts[document["quality"]["status"]] += 1
    collection_counts[document["collection"]] += 1
    source = Path(document["sourcePath"])
    if not source.exists():
        hard_errors.append(f"{name}: source missing")
    elif hashlib.sha256(source.read_bytes()).hexdigest() != document["fileHash"]:
        hard_errors.append(f"{name}: source hash changed")
    for sentence in document["sentences"]:
        if document["essayText"][sentence["startOffset"]:sentence["endOffset"]] != sentence["text"]:
            hard_errors.append(f"{name}:{sentence['sid']}: offset mismatch")
    quality = document["quality"]
    scopes = quality.get("ragScopes", [])
    if quality["allowedForRag"]:
        if document["task"] != "TASK2":
            hard_errors.append(f"{name}: non-Task-2 document enabled for RAG")
        if quality.get("contentRole") != "MODEL_ESSAY":
            hard_errors.append(f"{name}: enabled document is not a model essay")
        if quality["status"] == "MULTI_ESSAY_DOCUMENT":
            hard_errors.append(f"{name}: unsplit multi-essay document enabled for RAG")
        if not scopes:
            hard_errors.append(f"{name}: enabled document has no RAG scope")
        if quality["status"] != "COMPLETE" and "FULL_ESSAY" in scopes:
            hard_errors.append(f"{name}: incomplete document enabled for full-essay RAG")
        if not document.get("questionText") and "TASK_RESPONSE" in scopes:
            hard_errors.append(f"{name}: promptless document enabled for Task Response RAG")
    elif scopes:
        hard_errors.append(f"{name}: disabled document still has RAG scopes")
    if document["task"] == "TASK1" and quality["allowedForRag"]:
        hard_errors.append(f"{name}: Task 1 document enabled for RAG")
    if quality["bandVerified"]:
        hard_errors.append(f"{name}: filename band claim was incorrectly marked verified")

print(json.dumps({
    "documents": len(manifest["documents"]),
    "collections": dict(collection_counts),
    "statuses": dict(status_counts),
    "allowedForRag": sum(document["quality"]["allowedForRag"] for document in manifest["documents"]),
    "hardErrorCount": len(hard_errors),
    "hardErrors": hard_errors[:100],
}, ensure_ascii=False, indent=2))
raise SystemExit(1 if hard_errors else 0)
