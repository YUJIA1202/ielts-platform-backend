# Excel Multi-scope Feedback V2 Implementation

Implemented on 2026-08-15.

## Invariants

- Preserve every complete global and paragraph review as an immutable assessment container.
- Decompose long reviews into ordered atomic findings without replacing the source review.
- Store one-to-many sentence, span, paragraph, and cross-scope evidence relationships.
- Keep evidence appendices as `EVIDENCE_QUOTE`, not teacher-opinion retrieval items.
- Never fabricate offsets for anchors that are not exact source substrings.
- Keep V1 data for rollback while enabling only validated V2 training documents.

## Added persistence models

- `KnowledgeTextUnit`
- `KnowledgeAssessment`
- `KnowledgeAssessmentFinding`
- `KnowledgeAssessmentEvidence`
- `KnowledgeRewriteExample`
- `KnowledgeSourceRecord`
- `KnowledgeDocument.questionId`

Migration: `20260815093000_add_multiscope_excel_feedback_v2`.

## Import result

| Metric | Count |
|---|---:|
| Documents | 97 |
| Paragraph units | 415 |
| Sentence units | 1,429 |
| Assessment containers | 13,250 |
| Atomic findings | 67,864 |
| Evidence relations | 58,174 |
| Resolved evidence | 57,456 |
| Unresolved evidence | 718 |
| Rewrite examples | 2,857 |
| Source records | 18,330 |
| Retrieval chunks | 4,671 |
| RAG-enabled V2 documents | 96 |

## Verification

```bash
python3 scripts/verify-rag-excel-task2.py --manifest data/rag-excel-task2-v2/manifest.json
npm run rag:verify-excel-task2-v2-import
npm run rag:verify-task2-import
npm run rag:promote-excel-task2-v2
```

The import verifier checks canonical-question linkage, text-unit offsets, finding offsets, evidence offsets, holdout isolation, needs-review isolation, and manifest/database count reconciliation.

The importer was rerun after completion and created 0 records while skipping all 97 documents, confirming idempotency.

## Active sources

- `EXPERIMENT_RAG_EXCEL_TASK2_V1`: retained, `allowedForRag=false` for all documents.
- `EXPERIMENT_RAG_EXCEL_TASK2_V2`: 96 documents enabled; no holdout is retained in this corpus because evaluation data will be provided separately. One multi-version review document remains disabled until its a/b drafts are split.
