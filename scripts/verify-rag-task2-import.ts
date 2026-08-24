import 'dotenv/config'
import prisma from '../src/prisma'

const SOURCE_TITLES = [
  'EXPERIMENT_RAG_EXCEL_TASK2_V1',
  'EXPERIMENT_RAG_EXCEL_TASK2_V2',
  'EXPERIMENT_MODEL_DOCX_TASK2_V1',
  'EXPERIMENT_ESSAY_DOCX_QUARANTINE_V1',
]

async function main() {
  const sources = await prisma.knowledgeSource.findMany({
    where: { title: { in: SOURCE_TITLES } },
    select: {
      id: true,
      title: true,
      sourceType: true,
      documents: {
        select: {
          id: true,
          title: true,
          rawText: true,
          band: true,
          allowedForRag: true,
          excludeFromEval: true,
          completenessStatus: true,
          qualityNotes: true,
          chunks: { select: { id: true } },
          annotations: {
            select: {
              id: true,
              anchorText: true,
              startOffset: true,
              endOffset: true,
              locationStatus: true,
            },
          },
        },
      },
    },
    orderBy: { title: 'asc' },
  })

  const errors: string[] = []
  const summaries = []
  for (const source of sources) {
    let chunks = 0
    let annotations = 0
    let resolved = 0
    let ragEnabled = 0
    let quarantined = 0
    for (const document of source.documents) {
      chunks += document.chunks.length
      annotations += document.annotations.length
      ragEnabled += document.allowedForRag ? 1 : 0
      quarantined += document.completenessStatus !== 'COMPLETE' ? 1 : 0
      if (document.qualityNotes?.includes('split=holdout') && document.allowedForRag) {
        errors.push(`${source.title}/${document.title}: holdout leakage`)
      }
      if (document.completenessStatus !== 'COMPLETE' && document.allowedForRag) {
        errors.push(`${source.title}/${document.title}: quarantined document enabled for RAG`)
      }
      if (source.title === 'EXPERIMENT_MODEL_DOCX_TASK2_V1' && document.band != null) {
        errors.push(`${source.title}/${document.title}: unverified filename band persisted as verified band`)
      }
      for (const annotation of document.annotations) {
        if (annotation.locationStatus !== 'RESOLVED') continue
        resolved += 1
        if (annotation.startOffset == null || annotation.endOffset == null || annotation.anchorText == null) {
          errors.push(`${source.title}/${document.title}/annotation-${annotation.id}: resolved annotation has null location`)
          continue
        }
        const exact = document.rawText.slice(annotation.startOffset, annotation.endOffset)
        if (exact !== annotation.anchorText) {
          errors.push(`${source.title}/${document.title}/annotation-${annotation.id}: resolved anchor mismatch`)
        }
      }
    }
    summaries.push({
      sourceId: source.id,
      title: source.title,
      sourceType: source.sourceType,
      documents: source.documents.length,
      chunks,
      annotations,
      resolvedAnnotations: resolved,
      ragEnabled,
      quarantined,
    })
  }

  const batches = await prisma.importBatch.findMany({
    select: { id: true, label: true, parserVersion: true, importedCount: true, isActive: true },
    orderBy: { id: 'asc' },
  })
  console.log(JSON.stringify({ sources: summaries, batches, errorCount: errors.length, errors: errors.slice(0, 100) }, null, 2))
  if (errors.length) process.exitCode = 1
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
