import prisma from '../src/prisma'

export const EXPERIMENT_SOURCE_TITLES = {
  TEACHER_REVIEW: 'EXPERIMENT_TEACHER_REVIEWS_202506',
  MODEL_ESSAY: 'EXPERIMENT_MODEL_ESSAYS',
} as const

export async function cleanupExperimentData() {
  const sources = await prisma.knowledgeSource.findMany({
    where: { title: { in: Object.values(EXPERIMENT_SOURCE_TITLES) } },
    select: { id: true },
  })
  const sourceIds = sources.map(source => source.id)
  if (!sourceIds.length) {
    return { sources: 0, documents: 0, chunks: 0, retrievalEvents: 0 }
  }

  const documentCount = await prisma.knowledgeDocument.count({ where: { sourceId: { in: sourceIds } } })
  const chunkCount = await prisma.knowledgeChunk.count({
    where: { document: { sourceId: { in: sourceIds } } },
  })
  const retrievalEvents = await prisma.retrievalEvent.findMany({
    where: { chunks: { some: { chunk: { document: { sourceId: { in: sourceIds } } } } } },
    select: { id: true },
  })
  const retrievalEventIds = retrievalEvents.map(event => event.id)

  await prisma.$transaction(async tx => {
    if (retrievalEventIds.length) {
      await tx.retrievalEventChunk.deleteMany({ where: { retrievalEventId: { in: retrievalEventIds } } })
      await tx.retrievalEvent.deleteMany({ where: { id: { in: retrievalEventIds } } })
    }
    await tx.knowledgeEmbedding.deleteMany({
      where: { chunk: { document: { sourceId: { in: sourceIds } } } },
    })
    await tx.knowledgeChunk.deleteMany({ where: { document: { sourceId: { in: sourceIds } } } })
    await tx.knowledgeDocument.deleteMany({ where: { sourceId: { in: sourceIds } } })
    await tx.knowledgeSource.deleteMany({ where: { id: { in: sourceIds } } })
  }, { timeout: 120_000 })

  return {
    sources: sourceIds.length,
    documents: documentCount,
    chunks: chunkCount,
    retrievalEvents: retrievalEventIds.length,
  }
}
