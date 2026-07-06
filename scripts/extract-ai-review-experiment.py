from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from zipfile import BadZipFile, ZipFile
from xml.etree import ElementTree as ET


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = f"{{{W_NS}}}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract the disposable AI-review RAG experiment corpus.")
    parser.add_argument("--teacher-dir", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--teacher-since", default="2025-06-01")
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalized_text_hash(text: str) -> str:
    normalized = re.sub(r"\s+", " ", text).strip().lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def node_text(node: ET.Element) -> str:
    parts: list[str] = []
    for child in node.iter():
        if child.tag == W + "t" and child.text:
            parts.append(child.text)
        elif child.tag == W + "tab":
            parts.append("\t")
        elif child.tag in {W + "br", W + "cr"}:
            parts.append("\n")
    return "".join(parts).replace("\xa0", " ").strip()


def load_comments(archive: ZipFile) -> dict[str, str]:
    if "word/comments.xml" not in archive.namelist():
        return {}
    root = ET.fromstring(archive.read("word/comments.xml"))
    comments: dict[str, str] = {}
    for comment in root.findall(f".//{W}comment"):
        comment_id = comment.attrib.get(W + "id")
        if comment_id is not None:
            comments[comment_id] = node_text(comment)
    return comments


def extract_document(path: Path, collection: str) -> dict[str, Any]:
    raw_bytes = path.read_bytes()
    with ZipFile(path) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))
        comment_map = load_comments(archive)

    paragraphs: list[str] = []
    comment_anchors: list[dict[str, Any]] = []

    for paragraph_index, paragraph in enumerate(document.findall(f".//{W}p")):
        paragraph_text = node_text(paragraph)
        if paragraph_text:
            paragraphs.append(paragraph_text)

        active_comments: dict[str, list[str]] = {}
        for element in paragraph.iter():
            if element.tag == W + "commentRangeStart":
                comment_id = element.attrib.get(W + "id")
                if comment_id is not None:
                    active_comments[comment_id] = []
            elif element.tag == W + "t" and element.text:
                for values in active_comments.values():
                    values.append(element.text)
            elif element.tag == W + "commentRangeEnd":
                comment_id = element.attrib.get(W + "id")
                if comment_id is None:
                    continue
                anchor = "".join(active_comments.pop(comment_id, [])).strip()
                feedback = comment_map.get(comment_id, "").strip()
                if feedback:
                    comment_anchors.append({
                        "commentId": comment_id,
                        "paragraphIndex": paragraph_index,
                        "anchorText": anchor or paragraph_text,
                        "feedback": feedback,
                    })

    raw_text = "\n\n".join(paragraphs).strip()
    task = detect_task(path.name, raw_text)
    subtype = detect_subtype(path.name, raw_text, task)
    return {
        "collection": collection,
        "fileName": path.name,
        "sourcePath": str(path.resolve()),
        "modifiedAt": datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(),
        "fileHash": sha256_bytes(raw_bytes),
        "textHash": normalized_text_hash(raw_text),
        "task": task,
        "subtype": subtype,
        "questionText": detect_question(raw_text),
        "rawText": raw_text,
        "paragraphs": paragraphs,
        "comments": comment_anchors,
        "stats": {
            "characters": len(raw_text),
            "paragraphs": len(paragraphs),
            "comments": len(comment_anchors),
        },
    }


def detect_task(file_name: str, text: str) -> str | None:
    sample = f"{file_name}\n{text[:5000]}".lower()
    task2_markers = (
        "discuss both views", "discuss both sides", "to what extent do you agree",
        "to what extent do you disagree", "advantages outweigh", "outweigh the disadvantages",
        "outweigh its disadvantages", "causes and solutions",
        "give your own opinion", "大作文",
    )
    task1_markers = (
        "the chart", "the graph", "the table", "the diagram", "the maps", "the map",
        "the process", "illustrates", "小作文", "柱状图", "饼图", "流程图", "地图",
    )
    if any(marker in sample for marker in task2_markers):
        return "TASK2"
    if any(marker in sample for marker in task1_markers):
        return "TASK1"
    return None


def detect_subtype(file_name: str, text: str, task: str | None) -> str | None:
    sample = f"{file_name}\n{text[:7000]}".lower()
    if task == "TASK2":
        if "discuss both views" in sample or "discuss both sides" in sample or "双边" in sample:
            return "DISCUSSION"
        if any(marker in sample for marker in (
            "advantages outweigh", "outweigh the disadvantages",
            "outweigh its disadvantages", "优缺点",
        )):
            return "ADVANTAGES_DISADVANTAGES"
        if "to what extent do you agree" in sample or "to what extent do you disagree" in sample or "程度同意" in sample:
            return "OPINION"
        if any(marker in sample for marker in ("what are the causes", "what problems", "what solutions", "报告")):
            return "PROBLEM_SOLUTION"
    if task == "TASK1":
        if "map" in sample or "地图" in sample:
            return "MAP"
        if "process" in sample or "流程图" in sample:
            return "PROCESS"
        if "pie" in sample or "饼图" in sample:
            return "PIE_CHART"
        if "bar" in sample or "柱状图" in sample:
            return "BAR_CHART"
        if "line" in sample or "线图" in sample:
            return "LINE_GRAPH"
        if "table" in sample or "表格" in sample:
            return "TABLE"
    return None


def detect_question(text: str) -> str | None:
    compact = re.sub(r"\s+", " ", text).strip()
    if not compact:
        return None
    endings = (
        r"Discuss both (?:views|sides).*?(?:opinion|view)\.",
        r"To what extent do you (?:agree|disagree).*?\?",
        r"Summari[sz]e the information.*?\.",
        r"What are .*?\?",
    )
    prefix = compact[:4500]
    for pattern in endings:
        match = re.search(pattern, prefix, flags=re.IGNORECASE)
        if match:
            start = max(0, prefix.rfind(".", 0, match.start()) + 1)
            return prefix[start:match.end()].strip()[:2000]
    first_paragraph = text.split("\n\n", 1)[0].strip()
    return first_paragraph[:2000] if first_paragraph else None


def collect_documents(directory: Path, collection: str, since: datetime | None) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    documents: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for path in sorted(directory.rglob("*.docx")):
        if path.name.startswith("~$"):
            continue
        if since and datetime.fromtimestamp(path.stat().st_mtime) < since:
            continue
        try:
            document = extract_document(path, collection)
            if document["rawText"]:
                documents.append(document)
            else:
                errors.append({"sourcePath": str(path.resolve()), "error": "No extractable text"})
        except (BadZipFile, KeyError, ET.ParseError, OSError) as exc:
            errors.append({"sourcePath": str(path.resolve()), "error": str(exc)})
    return documents, errors


def main() -> None:
    args = parse_args()
    teacher_dir = Path(args.teacher_dir).resolve()
    model_dir = Path(args.model_dir).resolve()
    output = Path(args.output).resolve()
    teacher_since = datetime.fromisoformat(args.teacher_since)

    teacher_documents, teacher_errors = collect_documents(teacher_dir, "TEACHER_REVIEW", teacher_since)
    model_documents, model_errors = collect_documents(model_dir, "MODEL_ESSAY", None)
    documents = teacher_documents + model_documents

    seen_text_hashes: set[str] = set()
    unique_documents: list[dict[str, Any]] = []
    duplicates: list[dict[str, str]] = []
    for document in documents:
        text_hash = document["textHash"]
        if text_hash in seen_text_hashes:
            duplicates.append({"sourcePath": document["sourcePath"], "textHash": text_hash})
            continue
        seen_text_hashes.add(text_hash)
        unique_documents.append(document)

    manifest = {
        "generatedAt": datetime.now().astimezone().isoformat(),
        "teacherSince": args.teacher_since,
        "summary": {
            "teacherDocuments": len(teacher_documents),
            "modelDocuments": len(model_documents),
            "uniqueDocuments": len(unique_documents),
            "duplicatesSkipped": len(duplicates),
            "errors": len(teacher_errors) + len(model_errors),
            "comments": sum(len(document["comments"]) for document in unique_documents),
        },
        "documents": unique_documents,
        "duplicates": duplicates,
        "errors": teacher_errors + model_errors,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest["summary"], ensure_ascii=False, indent=2))
    print(f"Manifest: {output}")


if __name__ == "__main__":
    main()
