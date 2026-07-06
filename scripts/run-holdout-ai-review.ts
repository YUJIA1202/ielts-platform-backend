import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import prisma from '../src/prisma'
import { createAndRunAiReview } from '../src/services/ai/aiReviewService'
import { preprocessEssay } from '../src/services/ai/preprocessor'
import { evaluateReviewOutput } from '../src/services/ai/reviewEvaluator'
import { ReviewOutput } from '../src/services/ai/types'

function argument(name: string) {
  const prefix = `${name}=`
  return process.argv.slice(2).find(value => value.startsWith(prefix))?.slice(prefix.length) || null
}

async function cleanupUser(userId: number) {
  const jobs = await prisma.aiReviewJob.findMany({ where: { userId }, select: { id: true } })
  const jobIds = jobs.map(job => job.id)
  const reviews = await prisma.aiReview.findMany({ where: { userId }, select: { id: true } })
  const reviewIds = reviews.map(review => review.id)
  const requests = await prisma.aiReviewRequest.findMany({ where: { userId }, select: { id: true } })
  const requestIds = requests.map(request => request.id)
  const events = jobIds.length
    ? await prisma.retrievalEvent.findMany({ where: { jobId: { in: jobIds } }, select: { id: true } })
    : []
  const eventIds = events.map(event => event.id)
  await prisma.$transaction(async tx => {
    if (eventIds.length) await tx.retrievalEventChunk.deleteMany({ where: { retrievalEventId: { in: eventIds } } })
    if (jobIds.length) await tx.retrievalEvent.deleteMany({ where: { jobId: { in: jobIds } } })
    if (reviewIds.length) {
      await tx.aiRewrite.deleteMany({ where: { reviewId: { in: reviewIds } } })
      await tx.aiSentenceAnnotation.deleteMany({ where: { reviewId: { in: reviewIds } } })
      await tx.aiGlobalFinding.deleteMany({ where: { reviewId: { in: reviewIds } } })
      await tx.aiReviewScore.deleteMany({ where: { reviewId: { in: reviewIds } } })
      await tx.aiReview.deleteMany({ where: { id: { in: reviewIds } } })
    }
    if (jobIds.length) {
      await tx.aiModelCall.deleteMany({ where: { jobId: { in: jobIds } } })
      await tx.aiReviewStageResult.deleteMany({ where: { jobId: { in: jobIds } } })
      await tx.aiReviewInputSnapshot.deleteMany({ where: { jobId: { in: jobIds } } })
      await tx.aiReviewJob.deleteMany({ where: { id: { in: jobIds } } })
    }
    if (requestIds.length) await tx.aiReviewRequest.deleteMany({ where: { id: { in: requestIds } } })
    await tx.user.delete({ where: { id: userId } })
  }, { timeout: 60_000 })
}

async function main() {
  const fixtureArgument = argument('--fixture')
  const outputArgument = argument('--output')
  if (!fixtureArgument || !outputArgument) throw new Error('Usage: --fixture=file --output=file')
  const fixturePath = path.resolve(process.cwd(), fixtureArgument)
  const outputPath = path.resolve(process.cwd(), outputArgument)
  const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'))
  const user = await prisma.user.create({
    data: { phone: `holdout_${Date.now()}`, username: 'AI holdout evaluation' },
    select: { id: true },
  })

  try {
    const result = await createAndRunAiReview({
      userId: user.id,
      task: fixture.task,
      subtype: fixture.subtype,
      questionText: fixture.questionText,
      essayText: fixture.essayText,
    })
    const [events, stages, modelCalls] = await Promise.all([
      prisma.retrievalEvent.findMany({
        where: { jobId: result.jobId },
        orderBy: { id: 'asc' },
        include: {
          chunks: {
            where: { usedInPrompt: true },
            orderBy: { rank: 'asc' },
            include: { chunk: { include: { document: { include: { source: true } } } } },
          },
        },
      }),
      prisma.aiReviewStageResult.findMany({
        where: { jobId: result.jobId },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.aiModelCall.findMany({
        where: { jobId: result.jobId },
        orderBy: { createdAt: 'asc' },
      }),
    ])
    const review: ReviewOutput = {
      overallBand: result.review.overallBand,
      summary: result.review.summary,
      priorityAdvice: result.review.priorityAdvice,
      scores: result.review.scores,
      globalFindings: result.review.findings,
      sentenceAnnotations: result.review.annotations,
      rewrites: result.review.rewrites,
    }
    const preprocessed = preprocessEssay({
      questionText: fixture.questionText,
      essayText: fixture.essayText,
      task: fixture.task,
      subtype: fixture.subtype,
    })
    const evaluation = evaluateReviewOutput({
      essay: preprocessed,
      review,
      referenceAnnotations: fixture.referenceAnnotations,
      expectScores: false,
    })
    const artifact = {
      generatedAt: new Date().toISOString(),
      fixture: fixturePath,
      provider: result.review.provider,
      model: result.review.model,
      evaluation,
      review,
      retrieval: events.map(event => ({
        strategy: event.strategy,
        target: JSON.parse(event.query),
        chunks: event.chunks.map(hit => ({
          id: hit.chunkId,
          rank: hit.rank,
          score: hit.similarityScore,
          type: hit.chunk.chunkType,
          sourceType: hit.chunk.document.source.sourceType,
          documentTitle: hit.chunk.document.title,
        })),
      })),
      stages: stages.map(stage => ({
        stage: stage.stage,
        targetIndex: stage.targetIndex,
        attempt: stage.attempt,
        validationStatus: stage.validationStatus,
        errorMessage: stage.errorMessage,
      })),
      modelCalls: modelCalls.map(call => ({
        callType: call.callType,
        provider: call.provider,
        model: call.model,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        latencyMs: call.latencyMs,
        status: call.status,
        errorMessage: call.errorMessage,
      })),
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), 'utf8')
    console.log(JSON.stringify({
      output: outputPath,
      provider: artifact.provider,
      model: artifact.model,
      annotations: review.sentenceAnnotations.length,
      rewrites: review.rewrites.length,
      evaluation,
      modelCalls: artifact.modelCalls,
      retrievalStrategies: [...new Set(artifact.retrieval.map(item => item.strategy))],
    }, null, 2))
  } finally {
    await cleanupUser(user.id)
  }
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
