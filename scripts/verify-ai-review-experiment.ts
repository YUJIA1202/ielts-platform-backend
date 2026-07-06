import 'dotenv/config'
import prisma from '../src/prisma'
import { EXPERIMENT_SOURCE_TITLES } from './ai-review-experiment-common'

async function main() {
  const sources = await prisma.knowledgeSource.findMany({
    where: { title: { in: Object.values(EXPERIMENT_SOURCE_TITLES) } },
    select: {
      id: true,
      title: true,
      sourceType: true,
      _count: { select: { documents: true } },
    },
    orderBy: { title: 'asc' },
  })
  const sourceIds = sources.map(source => source.id)
  const documentsByTask = await prisma.knowledgeDocument.groupBy({
    by: ['task'],
    where: { sourceId: { in: sourceIds } },
    _count: { _all: true },
  })
  const chunksByType = await prisma.knowledgeChunk.groupBy({
    by: ['chunkType'],
    where: { document: { sourceId: { in: sourceIds } } },
    _count: { _all: true },
  })
  const chunksByTask = await prisma.knowledgeChunk.groupBy({
    by: ['task'],
    where: { document: { sourceId: { in: sourceIds } } },
    _count: { _all: true },
  })
  const scoredDocuments = await prisma.knowledgeDocument.count({
    where: { sourceId: { in: sourceIds }, band: { not: null } },
  })
  const embeddings = await prisma.knowledgeEmbedding.count({
    where: { chunk: { document: { sourceId: { in: sourceIds } } } },
  })

  console.log(JSON.stringify({
    sources,
    totals: {
      sources: sources.length,
      documents: sources.reduce((sum, source) => sum + source._count.documents, 0),
      chunks: chunksByType.reduce((sum, row) => sum + row._count._all, 0),
      scoredDocuments,
      embeddings,
    },
    documentsByTask,
    chunksByType,
    chunksByTask,
  }, null, 2))
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
