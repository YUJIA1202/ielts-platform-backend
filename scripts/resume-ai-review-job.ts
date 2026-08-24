import 'dotenv/config'
import prisma from '../src/prisma'
import { runAiReviewJob } from '../src/services/ai/aiReviewService'

const jobId = Number(process.argv[2])
if (!Number.isInteger(jobId) || jobId <= 0) {
  throw new Error('Usage: tsx scripts/resume-ai-review-job.ts <jobId>')
}

runAiReviewJob(jobId)
  .then(review => {
    console.log(JSON.stringify({
      jobId,
      reviewId: review.id,
      overallBand: review.overallBand,
      scores: review.scores.map(score => ({ dimension: score.dimension, score: score.score })),
      annotations: review.annotations.length,
      resolvedAnnotations: review.annotations.filter(annotation => annotation.locationStatus === 'RESOLVED').length,
      rewrites: review.rewrites.length,
      frontendPath: `/dashboard/ai-review-demo/${review.id}`,
    }, null, 2))
  })
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
