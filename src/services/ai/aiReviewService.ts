import {
  AiReviewJobStatus,
  AiReviewRequestStatus,
  Prisma,
} from '@prisma/client'
import prisma from '../../prisma'
import { normalizeQuestionSubtype } from '../../utils/questionTaxonomy'
import { preprocessEssay } from './preprocessor'
import { AI_REVIEW_PROMPT_VERSION } from './promptComposer'
import { retrieveHierarchicalRagPlan } from './ragRetriever'
import { validateReviewOutput } from './reviewValidator'
import { runMultiStageReviewPipeline } from './multiStageReviewPipeline'

export async function createAndRunAiReview(input: {
  userId: number
  questionId?: number | null
  submissionId?: number | null
  questionText?: string | null
  essayText: string
  task?: 'TASK1' | 'TASK2' | null
  subtype?: string | null
  topic?: string | null
}) {
  const essayText = input.essayText?.trim()
  if (!essayText) {
    throw new Error('Essay text is required')
  }

  const question = input.questionId
    ? await prisma.question.findUnique({ where: { id: input.questionId } })
    : null
  if (input.questionId && !question) {
    throw new Error('Question not found')
  }
  const submission = input.submissionId
    ? await prisma.submission.findFirst({ where: { id: input.submissionId, userId: input.userId } })
    : null

  if (input.submissionId && !submission) {
    throw new Error('Submission not found or not accessible')
  }

  const questionText = input.questionText || question?.content || submission?.customPrompt || null
  const questionImageUrl = question?.imageUrl || submission?.imageUrl || null
  const request = await prisma.aiReviewRequest.create({
    data: {
      userId: input.userId,
      questionId: question?.id || null,
      submissionId: submission?.id || null,
      sourceType: submission ? 'FROM_SUBMISSION' : 'DIRECT_AI',
      task: input.task || question?.task || null,
      subtype: normalizeQuestionSubtype(input.task || question?.task, input.subtype || question?.subtype || null),
      topic: input.topic || question?.topic || null,
      questionText,
      questionImageUrl,
      essayText,
      status: AiReviewRequestStatus.PROCESSING,
    },
  })

  const job = await prisma.aiReviewJob.create({
    data: {
      userId: input.userId,
      requestId: request.id,
      status: AiReviewJobStatus.RUNNING,
      stage: 'preprocessing',
      startedAt: new Date(),
    },
  })

  try {
    const review = await runAiReviewJob(job.id)
    return { requestId: request.id, jobId: job.id, review }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI review failed'
    await prisma.aiReviewJob.update({
      where: { id: job.id },
      data: {
        status: AiReviewJobStatus.FAILED,
        stage: 'failed',
        errorCode: 'AI_REVIEW_FAILED',
        errorMessage: message,
        completedAt: new Date(),
      },
    })
    await prisma.aiReviewRequest.update({
      where: { id: request.id },
      data: { status: AiReviewRequestStatus.FAILED },
    })
    throw error
  }
}

export async function runAiReviewJob(jobId: number) {
  const job = await prisma.aiReviewJob.findUnique({
    where: { id: jobId },
    include: { request: true },
  })
  if (!job) throw new Error('AI review job not found')

  await prisma.aiReviewJob.update({ where: { id: jobId }, data: { stage: 'preprocessing' } })
  const preprocessed = preprocessEssay({
    questionText: job.request.questionText,
    essayText: job.request.essayText,
    task: job.request.task,
    subtype: job.request.subtype,
    topic: job.request.topic,
  })

  await prisma.aiReviewInputSnapshot.create({
    data: {
      jobId,
      normalizedQuestion: preprocessed.normalizedQuestion,
      normalizedEssay: preprocessed.normalizedEssay,
      sentenceJson: preprocessed.sentences as unknown as Prisma.InputJsonValue,
      paragraphJson: preprocessed.paragraphs as unknown as Prisma.InputJsonValue,
      wordCount: preprocessed.wordCount,
      detectedTask: preprocessed.detectedTask,
      detectedSubtype: preprocessed.detectedSubtype,
      detectedTopic: preprocessed.detectedTopic,
    },
  })

  await ensureDefaultPromptVersion()

  await prisma.aiReviewJob.update({ where: { id: jobId }, data: { stage: 'retrieving' } })
  const ragPlan = await retrieveHierarchicalRagPlan({
    jobId,
    questionText: job.request.questionText,
    preprocessed,
    maxPromptChunks: 90,
  })

  await prisma.aiReviewJob.update({ where: { id: jobId }, data: { stage: 'calling_model' } })
  const providerResult = await runMultiStageReviewPipeline({
    userId: job.userId,
    jobId,
    questionText: job.request.questionText,
    essay: preprocessed,
    ragPlan,
  })

  await prisma.aiReviewJob.update({ where: { id: jobId }, data: { stage: 'validating' } })
  const validated = validateReviewOutput(providerResult.output, preprocessed)

  await prisma.aiReviewJob.update({ where: { id: jobId }, data: { stage: 'saving' } })
  const review = await prisma.aiReview.create({
    data: {
      jobId,
      requestId: job.requestId,
      userId: job.userId,
      submissionId: job.request.submissionId,
      overallBand: validated.overallBand,
      summary: validated.summary,
      priorityAdvice: validated.priorityAdvice,
      provider: providerResult.provider,
      model: providerResult.model,
      promptVersion: AI_REVIEW_PROMPT_VERSION,
      rawOutput: providerResult.rawOutput as unknown as Prisma.InputJsonValue,
      scores: {
        create: validated.scores.map(score => ({
          dimension: score.dimension,
          score: score.score,
          rationale: score.rationale,
          evidence: score.evidence,
        })),
      },
      findings: {
        create: validated.globalFindings.map(finding => ({
          category: finding.category,
          severity: finding.severity,
          title: finding.title,
          explanation: finding.explanation,
          suggestion: finding.suggestion,
        })),
      },
      annotations: {
        create: validated.sentenceAnnotations.map(annotation => ({
          paragraphIndex: annotation.paragraphIndex,
          sentenceIndex: annotation.sentenceIndex,
          level: annotation.level,
          originalText: annotation.originalText,
          anchorText: annotation.anchorText,
          startOffset: annotation.startOffset,
          endOffset: annotation.endOffset,
          occurrence: annotation.occurrence,
          locationStatus: annotation.locationStatus,
          issueType: annotation.issueType,
          subtype: annotation.subtype,
          severity: annotation.severity,
          explanation: annotation.explanation,
          suggestion: annotation.suggestion,
          replacementText: annotation.replacementText,
          rubricDimension: annotation.rubricDimension,
        })),
      },
      rewrites: {
        create: validated.rewrites.map(rewrite => ({
          sentenceIndex: rewrite.sentenceIndex,
          paragraphIndex: rewrite.paragraphIndex,
          level: rewrite.level,
          operation: rewrite.operation,
          anchorText: rewrite.anchorText,
          startOffset: rewrite.startOffset,
          endOffset: rewrite.endOffset,
          occurrence: rewrite.occurrence,
          originalText: rewrite.originalText,
          rewrittenText: rewrite.rewrittenText,
          reason: rewrite.reason,
        })),
      },
    },
    include: aiReviewInclude,
  })

  await prisma.aiReviewJob.update({
    where: { id: jobId },
    data: {
      status: AiReviewJobStatus.COMPLETED,
      stage: 'completed',
      completedAt: new Date(),
    },
  })
  await prisma.aiReviewRequest.update({
    where: { id: job.requestId },
    data: { status: AiReviewRequestStatus.COMPLETED },
  })

  return review
}

export async function getAiReviewForUser(reviewId: number, userId: number, role?: string) {
  const review = await prisma.aiReview.findUnique({
    where: { id: reviewId },
    include: aiReviewInclude,
  })
  if (!review) return null
  if (role !== 'ADMIN' && review.userId !== userId) {
    throw new Error('Forbidden')
  }
  return review
}

export async function getAiReviewJobForUser(jobId: number, userId: number, role?: string) {
  const job = await prisma.aiReviewJob.findUnique({
    where: { id: jobId },
    include: { review: true },
  })
  if (!job) return null
  if (role !== 'ADMIN' && job.userId !== userId) {
    throw new Error('Forbidden')
  }
  return job
}

export async function listAiReviewsForUser(userId: number) {
  return prisma.aiReview.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      request: { select: { id: true, questionText: true, essayText: true, task: true, subtype: true, createdAt: true } },
      scores: true,
    },
  })
}

async function ensureDefaultPromptVersion() {
  const template = await prisma.aiPromptTemplate.upsert({
    where: { name_purpose: { name: 'IELTS AI Review', purpose: 'review' } },
    update: {},
    create: {
      name: 'IELTS AI Review',
      purpose: 'review',
    },
  })

  await prisma.aiPromptVersion.upsert({
    where: { templateId_version: { templateId: template.id, version: AI_REVIEW_PROMPT_VERSION } },
    update: { isActive: true },
    create: {
      templateId: template.id,
      version: AI_REVIEW_PROMPT_VERSION,
      content: 'See src/services/ai/promptComposer.ts for composed prompt template.',
      outputSchemaJson: {
        kind: 'ReviewOutput',
        version: AI_REVIEW_PROMPT_VERSION,
      } as Prisma.InputJsonValue,
      changelog: 'Hierarchical global, paragraph, and sentence retrieval with deduplicated evidence; scoring disabled.',
      isActive: true,
    },
  })
}

export const aiReviewInclude = {
  request: true,
  // Stage results are internal audit records and are not exposed through the user review endpoint.
  job: { include: { snapshot: true } },
  scores: true,
  findings: true,
  annotations: { orderBy: [{ sentenceIndex: 'asc' as const }, { id: 'asc' as const }] },
  rewrites: { orderBy: [{ sentenceIndex: 'asc' as const }, { id: 'asc' as const }] },
}
