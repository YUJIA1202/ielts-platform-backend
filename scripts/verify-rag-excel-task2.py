from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path


parser = argparse.ArgumentParser(description="Verify normalized IELTS Task 2 Excel manifest invariants.")
parser.add_argument("--manifest", type=Path, default=Path("data/rag-excel-task2-v1/manifest.json"))
args = parser.parse_args()

manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
hard_errors: list[str] = []
soft_issues: list[str] = []
dimension_counts = Counter()
quality_counts = Counter()
warning_counts = Counter()
finding_count = 0
explicit_evidence_count = 0
resolvable_evidence_count = 0
ambiguous_evidence_count = 0


def resolve_sid(ref: str, sentences: list[dict], context_version: str | None = None) -> tuple[str, dict | None]:
    normalized = ref.lower()
    exact = [sentence for sentence in sentences if sentence["sid"].lower() == normalized]
    if len(exact) == 1:
        return "RESOLVED", exact[0]
    suffix = [sentence for sentence in sentences if sentence["sid"].lower().endswith(f"-{normalized}")]
    candidates = suffix
    if not candidates:
        tail = normalized.rsplit("-", 1)[-1]
        candidates = [sentence for sentence in sentences if sentence["sid"].lower().endswith(tail)]
    if context_version and context_version != "default":
        contextual = [sentence for sentence in candidates if sentence.get("versionId") == context_version]
        if len(contextual) == 1:
            return "RESOLVED", contextual[0]
    if len(candidates) == 1:
        return "RESOLVED", candidates[0]
    if len(candidates) > 1:
        return "AMBIGUOUS", None
    return "MISSING", None


def verify_assessment(
    name: str,
    assessment: dict,
    default_scope: str,
    sentences: list[dict],
    context_version: str | None = None,
) -> None:
    global finding_count, explicit_evidence_count, resolvable_evidence_count, ambiguous_evidence_count
    feedback = assessment.get("feedback")
    if not feedback:
        return
    source = assessment.get("source")
    if not source or not source.get("sheet") or not source.get("row") or not source.get("column"):
        hard_errors.append(f"{name}: {default_scope} assessment missing source provenance")
    findings = assessment.get("findings") or []
    if not findings:
        hard_errors.append(f"{name}: {default_scope} assessment has no findings")
        return
    for expected_ordinal, finding in enumerate(findings):
        finding_count += 1
        if finding.get("ordinal") != expected_ordinal:
            hard_errors.append(f"{name}: {default_scope} finding ordinal mismatch")
        start = finding.get("feedbackStartOffset")
        end = finding.get("feedbackEndOffset")
        if start is None or end is None or feedback[start:end] != finding.get("content"):
            hard_errors.append(f"{name}: {default_scope} finding feedback offset mismatch")
        for ref in finding.get("evidenceSids") or []:
            explicit_evidence_count += 1
            status, _ = resolve_sid(ref, sentences, context_version)
            if status == "RESOLVED":
                resolvable_evidence_count += 1
            elif status == "AMBIGUOUS":
                ambiguous_evidence_count += 1
            else:
                hard_errors.append(f"{name}: evidence SID not found: {ref}")

for document in manifest["documents"]:
    name = document["fileName"]
    quality = document["quality"]
    quality_counts[quality["status"]] += 1
    for warning in quality["warnings"]:
        warning_counts[warning.split("=", 1)[0].split(":", 1)[-1]] += 1

    source = Path(document["sourcePath"])
    if not source.exists():
        hard_errors.append(f"{name}: source missing")
    elif hashlib.sha256(source.read_bytes()).hexdigest() != document["fileHash"]:
        hard_errors.append(f"{name}: source hash changed")

    essay = document["essayText"]
    for paragraph in document["paragraphs"]:
        start, end = paragraph["startOffset"], paragraph["endOffset"]
        if essay[start:end] != paragraph["text"]:
            hard_errors.append(f"{name}:p{paragraph['index'] + 1}: paragraph offset mismatch")
        for assessment in paragraph["dimensions"]:
            verify_assessment(
                name,
                assessment,
                "PARAGRAPH",
                document["sentences"],
                (paragraph.get("versionIds") or [None])[0] if len(paragraph.get("versionIds") or []) == 1 else None,
            )

    for assessment in document["globalAssessments"]:
        verify_assessment(name, assessment, "ESSAY", document["sentences"])

    for sentence in document["sentences"]:
        start, end = sentence["startOffset"], sentence["endOffset"]
        if essay[start:end] != sentence["text"]:
            hard_errors.append(f"{name}:{sentence['sid']}: offset mismatch")
        dimensions = [item["dimension"] for item in sentence["dimensions"]]
        dimension_counts[len(dimensions)] += 1
        if len(dimensions) != 4:
            soft_issues.append(f"{name}:{sentence['sid']}: {len(dimensions)} sentence dimensions")
        if len(set(dimensions)) != len(dimensions):
            hard_errors.append(f"{name}:{sentence['sid']}: duplicate dimension")
        for assessment in sentence["dimensions"]:
            verify_assessment(name, assessment, "SENTENCE", document["sentences"], sentence.get("versionId"))
        for annotation in sentence["wordAnnotations"]:
            verify_assessment(
                name,
                {
                    "feedback": annotation.get("feedback"),
                    "source": annotation.get("source"),
                    "findings": annotation.get("findings"),
                },
                "SPAN",
                document["sentences"],
                sentence.get("versionId"),
            )

    if quality["split"] == "holdout" and quality["allowedForRag"]:
        hard_errors.append(f"{name}: holdout leakage (allowedForRag=true)")
    if quality["status"] == "NEEDS_REVIEW" and quality["allowedForRag"]:
        hard_errors.append(f"{name}: needs-review document enabled for RAG")

report = {
    "documents": len(manifest["documents"]),
    "quality": dict(quality_counts),
    "sentenceDimensionCountDistribution": dict(sorted(dimension_counts.items())),
    "softIssueCount": len(soft_issues),
    "softIssueSamples": soft_issues[:20],
    "warningCategories": dict(warning_counts.most_common()),
    "assessmentFindings": finding_count,
    "explicitEvidenceRefs": explicit_evidence_count,
    "resolvableEvidenceRefs": resolvable_evidence_count,
    "ambiguousEvidenceRefs": ambiguous_evidence_count,
    "hardErrorCount": len(hard_errors),
    "hardErrors": hard_errors[:100],
}
print(json.dumps(report, ensure_ascii=False, indent=2))
raise SystemExit(1 if hard_errors else 0)
