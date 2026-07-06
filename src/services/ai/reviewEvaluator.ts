import { AiAnnotationLocationStatus, AiReviewScoreDimension } from '@prisma/client'
import { PreprocessedEssay, ReviewOutput, SentenceAnnotationOutput } from './types'

export interface ReferenceAnnotation {
  startOffset: number
  endOffset: number
  issueType?: string | null
}

export interface ReviewEvaluationReport {
  structure: {
    requiredScoreDimensions: number
    presentScoreDimensions: number
    scoreDimensionCompleteness: number
    hasSummary: boolean
    hasPriorityAdvice: boolean
  }
  annotations: {
    total: number
    resolved: number
    unresolved: number
    locationResolutionRate: number
    exactLocationIntegrityRate: number
    annotatedSentenceCoverage: number
    duplicateCount: number
    invalidRangeCount: number
  }
  rewrites: {
    total: number
    located: number
    locationRate: number
  }
  reference?: {
    referenceCount: number
    matchedPredictionCount: number
    matchedReferenceCount: number
    precision: number
    recall: number
    f1: number
  }
  warnings: string[]
}

const rubricDimensions = [
  AiReviewScoreDimension.TASK_RESPONSE,
  AiReviewScoreDimension.COHERENCE_COHESION,
  AiReviewScoreDimension.LEXICAL_RESOURCE,
  AiReviewScoreDimension.GRAMMAR_RANGE_ACCURACY,
]

export function evaluateReviewOutput(input: {
  essay: PreprocessedEssay
  review: ReviewOutput
  referenceAnnotations?: ReferenceAnnotation[]
  expectScores?: boolean
}): ReviewEvaluationReport {
  const { essay, review } = input
  const resolved = review.sentenceAnnotations.filter(annotation => (
    annotation.locationStatus === AiAnnotationLocationStatus.RESOLVED
  ))
  const invalidRangeCount = resolved.filter(annotation => !hasValidRange(annotation, essay)).length
  const exactLocations = resolved.filter(annotation => hasExactLocation(annotation, essay)).length
  const annotatedSentenceIndexes = new Set(
    resolved.map(annotation => annotation.sentenceIndex).filter((index): index is number => index != null),
  )
  const duplicateCount = countDuplicateAnnotations(review.sentenceAnnotations)
  const presentDimensions = new Set(review.scores.map(score => score.dimension))
  const presentScoreDimensions = rubricDimensions.filter(dimension => presentDimensions.has(dimension)).length
  const locatedRewrites = review.rewrites.filter(rewrite => (
    isOffset(rewrite.startOffset) && isOffset(rewrite.endOffset) && rewrite.endOffset! >= rewrite.startOffset!
  )).length

  const report: ReviewEvaluationReport = {
    structure: {
      requiredScoreDimensions: rubricDimensions.length,
      presentScoreDimensions,
      scoreDimensionCompleteness: ratio(presentScoreDimensions, rubricDimensions.length),
      hasSummary: Boolean(review.summary.trim()),
      hasPriorityAdvice: Boolean(review.priorityAdvice?.trim()),
    },
    annotations: {
      total: review.sentenceAnnotations.length,
      resolved: resolved.length,
      unresolved: review.sentenceAnnotations.length - resolved.length,
      locationResolutionRate: ratio(resolved.length, review.sentenceAnnotations.length),
      exactLocationIntegrityRate: ratio(exactLocations, resolved.length),
      annotatedSentenceCoverage: ratio(annotatedSentenceIndexes.size, essay.sentences.length),
      duplicateCount,
      invalidRangeCount,
    },
    rewrites: {
      total: review.rewrites.length,
      located: locatedRewrites,
      locationRate: ratio(locatedRewrites, review.rewrites.length),
    },
    warnings: [],
  }

  if (input.referenceAnnotations) {
    report.reference = compareWithReference(resolved, input.referenceAnnotations)
  }

  if (report.annotations.unresolved > 0) report.warnings.push('Some annotations cannot be located in the submitted essay.')
  if (invalidRangeCount > 0) report.warnings.push('Some resolved annotations contain invalid character ranges.')
  if (duplicateCount > 0) report.warnings.push('Duplicate annotations were detected.')
  if (input.expectScores !== false && presentScoreDimensions < rubricDimensions.length) {
    report.warnings.push('One or more IELTS rubric dimensions are missing.')
  }
  if (review.sentenceAnnotations.length === 0) report.warnings.push('The review contains no inline annotations.')
  if (review.rewrites.length === 0) report.warnings.push('The review contains no revisions.')

  return report
}

function compareWithReference(
  predictions: SentenceAnnotationOutput[],
  references: ReferenceAnnotation[],
) {
  const usedReferences = new Set<number>()
  let matchedPredictionCount = 0

  for (const prediction of predictions) {
    if (!isOffset(prediction.startOffset) || !isOffset(prediction.endOffset)) continue
    const referenceIndex = references.findIndex((reference, index) => (
      !usedReferences.has(index)
      && (!reference.issueType || reference.issueType === prediction.issueType)
      && rangesOverlap(prediction.startOffset!, prediction.endOffset!, reference.startOffset, reference.endOffset)
    ))
    if (referenceIndex >= 0) {
      matchedPredictionCount += 1
      usedReferences.add(referenceIndex)
    }
  }

  const precision = ratio(matchedPredictionCount, predictions.length)
  const recall = ratio(usedReferences.size, references.length)
  return {
    referenceCount: references.length,
    matchedPredictionCount,
    matchedReferenceCount: usedReferences.size,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : round((2 * precision * recall) / (precision + recall)),
  }
}

function hasValidRange(annotation: SentenceAnnotationOutput, essay: PreprocessedEssay) {
  return isOffset(annotation.startOffset)
    && isOffset(annotation.endOffset)
    && annotation.startOffset! < annotation.endOffset!
    && annotation.endOffset! <= essay.normalizedEssay.length
}

function hasExactLocation(annotation: SentenceAnnotationOutput, essay: PreprocessedEssay) {
  if (!hasValidRange(annotation, essay) || !annotation.anchorText) return false
  return essay.normalizedEssay
    .slice(annotation.startOffset!, annotation.endOffset!)
    .toLocaleLowerCase() === annotation.anchorText.toLocaleLowerCase()
}

function countDuplicateAnnotations(annotations: SentenceAnnotationOutput[]) {
  const seen = new Set<string>()
  let duplicates = 0
  for (const annotation of annotations) {
    const key = [
      annotation.startOffset,
      annotation.endOffset,
      annotation.issueType,
      annotation.explanation.trim().toLocaleLowerCase(),
    ].join(':')
    if (seen.has(key)) duplicates += 1
    else seen.add(key)
  }
  return duplicates
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number) {
  return Math.max(startA, startB) < Math.min(endA, endB)
}

function isOffset(value: number | null | undefined): value is number {
  return Number.isInteger(value) && value! >= 0
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : round(numerator / denominator)
}

function round(value: number) {
  return Math.round(value * 10000) / 10000
}
