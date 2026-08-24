import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import prisma from '../src/prisma'

const SOURCE_TITLE = 'EXPERIMENT_RAG_EXCEL_TASK2_V2'
const MANIFEST_PATH = path.resolve('data/rag-excel-task2-v2/manifest.json')

interface ManifestDocument {
  fileName: string
  essayText: string
  paragraphs: unknown[]
  sentences: unknown[]
  globalAssessments: unknown[]
  quality: { allowedForRag: boolean; split: string; status: string }
  stats: Record<string, number>
}

interface Manifest {
  summary: Record<string, number>
  documents: ManifestDocument[]
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8')) as Manifest
  const source = await prisma.knowledgeSource.findFirstOrThrow({ where: { title: SOURCE_TITLE } })
  const documents = await prisma.knowledgeDocument.findMany({
    where: { sourceId: source.id },
    select: {
      id: true,
      title: true,
      rawText: true,
      questionId: true,
      allowedForRag: true,
      excludeFromEval: true,
      completenessStatus: true,
      qualityNotes: true,
    },
    orderBy: { title: 'asc' },
  })

  const expectedByTitle = new Map(manifest.documents.map(document => [document.fileName, document]))
  const errors: string[] = []
  const totals = {
    documents: documents.length,
    questionLinked: 0,
    paragraphs: 0,
    sentences: 0,
    assessments: 0,
    globalAssessments: 0,
    paragraphAssessments: 0,
    sentenceAssessments: 0,
    wordAnnotations: 0,
    ancillaryAssessments: 0,
    findings: 0,
    evidence: 0,
    resolvedEvidence: 0,
    unresolvedEvidence: 0,
    evidenceQuotes: 0,
    rewrites: 0,
    sourceRecords: 0,
    chunks: 0,
    ragEnabled: 0,
    holdoutLeakage: 0,
  }

  for (const document of documents) {
    const expected = expectedByTitle.get(document.title)
    if (!expected) {
      errors.push(`${document.title}: missing from manifest`)
      continue
    }
    if (document.rawText !== expected.essayText) errors.push(`${document.title}: essay text mismatch`)
    if (document.questionId == null) errors.push(`${document.title}: canonical question missing`)
    else totals.questionLinked += 1
    if (document.allowedForRag) totals.ragEnabled += 1
    if (expected.quality.split === 'holdout' && document.allowedForRag) {
      totals.holdoutLeakage += 1
      errors.push(`${document.title}: holdout leakage`)
    }
    if (expected.quality.status === 'NEEDS_REVIEW' && document.allowedForRag) {
      errors.push(`${document.title}: needs-review document enabled for RAG`)
    }

    const units = await prisma.knowledgeTextUnit.findMany({
      where: { documentId: document.id },
      select: {
        id: true,
        unitType: true,
        stableKey: true,
        text: true,
        startOffset: true,
        endOffset: true,
      },
    })
    const unitsById = new Map(units.map(unit => [unit.id, unit]))
    totals.paragraphs += units.filter(unit => unit.unitType === 'PARAGRAPH').length
    totals.sentences += units.filter(unit => unit.unitType === 'SENTENCE').length
    for (const unit of units) {
      if (unit.startOffset == null || unit.endOffset == null) {
        errors.push(`${document.title}/${unit.stableKey}: missing unit offset`)
        continue
      }
      if (document.rawText.slice(unit.startOffset, unit.endOffset) !== unit.text) {
        errors.push(`${document.title}/${unit.stableKey}: unit offset mismatch`)
      }
    }

    const assessments = await prisma.knowledgeAssessment.findMany({
      where: { documentId: document.id },
      select: {
        id: true,
        sourceKey: true,
        rawFeedback: true,
        findings: {
          orderBy: { ordinal: 'asc' },
          select: {
            ordinal: true,
            content: true,
            kind: true,
            feedbackStartOffset: true,
            feedbackEndOffset: true,
            evidence: {
              select: {
                unitId: true,
                refKey: true,
                quotedText: true,
                startOffset: true,
                endOffset: true,
                locationStatus: true,
              },
            },
          },
        },
      },
    })
    totals.assessments += assessments.length
    for (const assessment of assessments) {
      if (assessment.sourceKey.startsWith('global-')) totals.globalAssessments += 1
      else if (assessment.sourceKey.startsWith('paragraph-')) totals.paragraphAssessments += 1
      else if (assessment.sourceKey.startsWith('sentence-')) totals.sentenceAssessments += 1
      else if (assessment.sourceKey.startsWith('word-')) totals.wordAnnotations += 1
      else if (assessment.sourceKey.startsWith('ancillary-')) totals.ancillaryAssessments += 1

      for (const [ordinal, finding] of assessment.findings.entries()) {
        totals.findings += 1
        if (finding.ordinal !== ordinal) errors.push(`${document.title}/${assessment.sourceKey}: finding ordinal mismatch`)
        const start = finding.feedbackStartOffset
        const end = finding.feedbackEndOffset
        if (start == null || end == null || assessment.rawFeedback.slice(start, end) !== finding.content) {
          errors.push(`${document.title}/${assessment.sourceKey}/f${ordinal}: feedback offset mismatch`)
        }
        if (finding.kind === 'EVIDENCE_QUOTE') totals.evidenceQuotes += 1

        for (const evidence of finding.evidence) {
          totals.evidence += 1
          if (evidence.locationStatus === 'RESOLVED') {
            totals.resolvedEvidence += 1
            const unit = evidence.unitId == null ? null : unitsById.get(evidence.unitId)
            if (!unit || evidence.startOffset == null || evidence.endOffset == null || evidence.quotedText == null) {
              errors.push(`${document.title}/${assessment.sourceKey}/f${ordinal}: invalid resolved evidence`)
              continue
            }
            if (document.rawText.slice(evidence.startOffset, evidence.endOffset) !== evidence.quotedText) {
              errors.push(`${document.title}/${assessment.sourceKey}/f${ordinal}: evidence offset mismatch`)
            }
          } else {
            totals.unresolvedEvidence += 1
          }
        }
      }
    }

    totals.rewrites += await prisma.knowledgeRewriteExample.count({ where: { documentId: document.id } })
    totals.sourceRecords += await prisma.knowledgeSourceRecord.count({ where: { documentId: document.id } })
    totals.chunks += await prisma.knowledgeChunk.count({ where: { documentId: document.id } })
  }

  const expected = {
    documents: manifest.summary.documents,
    paragraphs: manifest.summary.paragraphs,
    sentences: manifest.summary.sentences,
    globalAssessments: manifest.summary.globalAssessments,
    paragraphAssessments: manifest.summary.paragraphDimensionAssessments,
    sentenceAssessments: manifest.summary.sentenceDimensionAssessments,
    wordAnnotations: manifest.summary.wordAnnotations,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (totals[key as keyof typeof totals] !== value) {
      errors.push(`total ${key}: expected ${value}, got ${totals[key as keyof typeof totals]}`)
    }
  }
  if (totals.questionLinked !== totals.documents) errors.push('not every V2 document has a canonical question')

  console.log(JSON.stringify({ sourceId: source.id, expected, totals, errorCount: errors.length, errors: errors.slice(0, 100) }, null, 2))
  if (errors.length) process.exitCode = 1
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
