import 'dotenv/config'
import prisma from '../src/prisma'

const WRITE_MODE = process.argv.includes('--write')
const SOURCE_TITLE = 'EXPERIMENT_RAG_EXCEL_TASK2_V2'

async function main() {
  const source = await prisma.knowledgeSource.findFirstOrThrow({ where: { title: SOURCE_TITLE } })
  const documents = await prisma.knowledgeDocument.findMany({
    where: { sourceId: source.id },
    select: { id: true, title: true, completenessStatus: true, qualityNotes: true, allowedForRag: true },
  })
  const eligible = documents.filter(document => document.completenessStatus === 'COMPLETE')
  const needsReview = documents.filter(document => document.completenessStatus !== 'COMPLETE')

  console.log(JSON.stringify({
    mode: WRITE_MODE ? 'WRITE' : 'DRY_RUN',
    sourceId: source.id,
    documents: documents.length,
    eligibleForRag: eligible.length,
    currentlyEnabled: documents.filter(document => document.allowedForRag).length,
    willEnable: eligible.filter(document => !document.allowedForRag).map(document => document.title),
    keptDisabled: needsReview.map(document => document.title),
  }, null, 2))
  if (!WRITE_MODE) return

  await prisma.$transaction(async tx => {
    for (const document of eligible) {
      await tx.knowledgeDocument.update({
        where: { id: document.id },
        data: {
          allowedForRag: true,
          excludeFromEval: true,
          qualityNotes: document.qualityNotes?.replace('split=holdout', 'split=train'),
        },
      })
    }
    for (const document of needsReview) {
      await tx.knowledgeDocument.update({
        where: { id: document.id },
        data: { allowedForRag: false, excludeFromEval: true },
      })
    }
  }, { timeout: 180_000 })

  const enabled = await prisma.knowledgeDocument.count({ where: { sourceId: source.id, allowedForRag: true } })
  console.log(JSON.stringify({ updated: true, enabled, disabled: documents.length - enabled }, null, 2))
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
