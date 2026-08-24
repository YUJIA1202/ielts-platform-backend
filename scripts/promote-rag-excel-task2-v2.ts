import 'dotenv/config'
import prisma from '../src/prisma'

const WRITE_MODE = process.argv.includes('--write')
const V1_TITLE = 'EXPERIMENT_RAG_EXCEL_TASK2_V1'
const V2_TITLE = 'EXPERIMENT_RAG_EXCEL_TASK2_V2'

async function main() {
  const [v1, v2] = await Promise.all([
    prisma.knowledgeSource.findFirstOrThrow({ where: { title: V1_TITLE } }),
    prisma.knowledgeSource.findFirstOrThrow({ where: { title: V2_TITLE } }),
  ])

  const [documents, questionLinked, paragraphs, sentences, assessments, holdoutLeakage, needsReviewLeakage] = await Promise.all([
    prisma.knowledgeDocument.count({ where: { sourceId: v2.id } }),
    prisma.knowledgeDocument.count({ where: { sourceId: v2.id, questionId: { not: null } } }),
    prisma.knowledgeTextUnit.count({ where: { document: { sourceId: v2.id }, unitType: 'PARAGRAPH' } }),
    prisma.knowledgeTextUnit.count({ where: { document: { sourceId: v2.id }, unitType: 'SENTENCE' } }),
    prisma.knowledgeAssessment.count({ where: { document: { sourceId: v2.id } } }),
    prisma.knowledgeDocument.count({
      where: { sourceId: v2.id, allowedForRag: true, qualityNotes: { contains: 'split=holdout' } },
    }),
    prisma.knowledgeDocument.count({
      where: { sourceId: v2.id, allowedForRag: true, completenessStatus: 'NEEDS_REVIEW' },
    }),
  ])

  const checks = {
    documents,
    questionLinked,
    paragraphs,
    sentences,
    assessments,
    holdoutLeakage,
    needsReviewLeakage,
  }
  const valid = documents === 97
    && questionLinked === 97
    && paragraphs === 415
    && sentences === 1429
    && assessments === 13250
    && holdoutLeakage === 0
    && needsReviewLeakage === 0

  console.log(JSON.stringify({ mode: WRITE_MODE ? 'WRITE' : 'DRY_RUN', valid, v1SourceId: v1.id, v2SourceId: v2.id, checks }, null, 2))
  if (!valid) throw new Error('V2 promotion checks failed')
  if (!WRITE_MODE) return

  const result = await prisma.$transaction(async tx => {
    const disabledV1 = await tx.knowledgeDocument.updateMany({
      where: { sourceId: v1.id, allowedForRag: true },
      data: { allowedForRag: false },
    })
    const disabledV1Batches = await tx.importBatch.updateMany({
      where: { isActive: true, notes: { contains: `"sourceTitle":"${V1_TITLE}"` } },
      data: { isActive: false },
    })
    const enabledV2 = await tx.knowledgeDocument.count({ where: { sourceId: v2.id, allowedForRag: true } })
    return { disabledV1Documents: disabledV1.count, disabledV1Batches: disabledV1Batches.count, enabledV2Documents: enabledV2 }
  })
  console.log(JSON.stringify({ promoted: true, ...result }, null, 2))
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
