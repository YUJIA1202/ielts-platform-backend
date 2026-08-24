import 'dotenv/config'
import prisma from '../src/prisma'
import { createAndRunAiReview } from '../src/services/ai/aiReviewService'

async function cleanup(requestId: number, jobId: number, reviewId: number | null) {
  const events = await prisma.retrievalEvent.findMany({ where: { jobId }, select: { id: true } })
  const eventIds = events.map(event => event.id)
  await prisma.$transaction(async tx => {
    if (eventIds.length) {
      await tx.retrievalEventChunk.deleteMany({ where: { retrievalEventId: { in: eventIds } } })
      await tx.retrievalEvent.deleteMany({ where: { id: { in: eventIds } } })
    }
    if (reviewId) {
      await tx.aiRewrite.deleteMany({ where: { reviewId } })
      await tx.aiSentenceAnnotation.deleteMany({ where: { reviewId } })
      await tx.aiGlobalFinding.deleteMany({ where: { reviewId } })
      await tx.aiReviewScore.deleteMany({ where: { reviewId } })
      await tx.aiReview.delete({ where: { id: reviewId } })
    }
    await tx.aiModelCall.deleteMany({ where: { jobId } })
    await tx.aiReviewStageResult.deleteMany({ where: { jobId } })
    await tx.aiReviewInputSnapshot.deleteMany({ where: { jobId } })
    await tx.aiReviewJob.delete({ where: { id: jobId } })
    await tx.aiReviewRequest.delete({ where: { id: requestId } })
  }, { timeout: 60_000 })
}

async function main() {
  let user = await prisma.user.findFirst({ select: { id: true } })
  let temporaryUserId: number | null = null
  if (!user) {
    user = await prisma.user.create({
      data: {
        phone: `smoke_${Date.now()}`,
        username: 'AI RAG smoke test',
      },
      select: { id: true },
    })
    temporaryUserId = user.id
  }

  let requestId: number | null = null
  let jobId: number | null = null
  let reviewId: number | null = null
  try {
    const result = await createAndRunAiReview({
      userId: user.id,
      task: 'TASK2',
      subtype: 'discussion',
      questionText: 'Some people think competition is beneficial, while others believe cooperation is more important. Discuss both views and give your own opinion.',
      essayText: [
        'Some people believes competition can encourage individuals to work hardly.',
        'However, others argue cooperation helps people share knowledges and solve problems together.',
        'In my opinion, both approaches has benefits, but cooperation is more important in most situation.',
        'Therefore, schools should teaches students how to cooperate while still providing healthy competition.',
      ].join('\n\n'),
    })
    requestId = result.requestId
    jobId = result.jobId
    reviewId = result.review.id

    const events = await prisma.retrievalEvent.findMany({
      where: { jobId },
      orderBy: { id: 'asc' },
      include: {
        chunks: {
          orderBy: { rank: 'asc' },
          include: { chunk: { include: { document: { include: { source: true } } } } },
        },
      },
    })
    const stageSummary = events.map(event => ({
      strategy: event.strategy,
      retrieved: event.chunks.length,
      usedInPrompt: event.chunks.filter(hit => hit.usedInPrompt).length,
      channels: event.chunks.reduce<Record<string, number>>((counts, hit) => {
        const key = `${hit.chunk.document.source.sourceType}:${hit.chunk.chunkType}`
        counts[key] = (counts[key] || 0) + 1
        return counts
      }, {}),
    }))
    const uniquePromptChunkIds = new Set(events.flatMap(event => (
      event.chunks.filter(hit => hit.usedInPrompt).map(hit => hit.chunkId)
    )))
    const ragLeaks = events.flatMap(event => event.chunks)
      .filter(hit => !hit.chunk.document.allowedForRag)
      .map(hit => ({ chunkId: hit.chunkId, documentId: hit.chunk.documentId }))
    if (ragLeaks.length) {
      throw new Error(`RAG retrieved quarantined chunks: ${JSON.stringify(ragLeaks.slice(0, 20))}`)
    }
    const [stageResults, modelCalls] = await Promise.all([
      prisma.aiReviewStageResult.findMany({
        where: { jobId },
        orderBy: { createdAt: 'asc' },
        select: { stage: true, targetIndex: true, validationStatus: true },
      }),
      prisma.aiModelCall.findMany({
        where: { jobId },
        orderBy: { createdAt: 'asc' },
        select: { callType: true, provider: true, model: true, status: true },
      }),
    ])
    console.log(JSON.stringify({
      requestId,
      jobId,
      reviewId,
      provider: result.review.provider,
      overallBand: result.review.overallBand,
      scoreRows: result.review.scores.length,
      annotations: result.review.annotations.length,
      rewrites: result.review.rewrites.length,
      retrievalEvents: events.length,
      uniquePromptChunks: uniquePromptChunkIds.size,
      ragLeakCount: ragLeaks.length,
      stageResults,
      modelCalls,
      stages: stageSummary,
    }, null, 2))
  } finally {
    if (requestId && jobId) {
      await cleanup(requestId, jobId, reviewId)
      console.log('Temporary smoke-test review removed.')
    }
    if (temporaryUserId) {
      await prisma.user.delete({ where: { id: temporaryUserId } })
      console.log('Temporary smoke-test user removed.')
    }
  }
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
