import { AiReviewStage } from '@prisma/client'
import { PreprocessedEssay } from './types'

export interface ReviewStageTarget {
  stage: AiReviewStage
  targetIndexes: number[]
}

export interface ReviewStagePlan {
  global: ReviewStageTarget
  paragraphBatches: ReviewStageTarget[]
  sentenceBatches: ReviewStageTarget[]
  verification: ReviewStageTarget
}

export function buildReviewStagePlan(
  essay: PreprocessedEssay,
  options: { paragraphBatchSize?: number; sentenceBatchSize?: number } = {},
): ReviewStagePlan {
  const paragraphBatchSize = clamp(options.paragraphBatchSize || 2, 1, 4)
  const sentenceBatchSize = clamp(options.sentenceBatchSize || 6, 3, 10)
  return {
    global: { stage: AiReviewStage.GLOBAL_ANALYSIS, targetIndexes: [] },
    paragraphBatches: makeBatches(
      essay.paragraphs.map(paragraph => paragraph.index),
      paragraphBatchSize,
      AiReviewStage.PARAGRAPH_ANALYSIS,
    ),
    sentenceBatches: makeBatches(
      essay.sentences.map(sentence => sentence.index),
      sentenceBatchSize,
      AiReviewStage.SENTENCE_ANALYSIS,
    ),
    verification: { stage: AiReviewStage.VERIFICATION, targetIndexes: [] },
  }
}

function makeBatches(indexes: number[], batchSize: number, stage: AiReviewStage) {
  const batches: ReviewStageTarget[] = []
  for (let start = 0; start < indexes.length; start += batchSize) {
    batches.push({ stage, targetIndexes: indexes.slice(start, start + batchSize) })
  }
  return batches
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}
