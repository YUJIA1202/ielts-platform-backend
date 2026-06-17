import {
  AiFindingCategory,
  AiIssueSeverity,
  AiIssueType,
  AiReviewScoreDimension,
} from '@prisma/client'
import { ReviewOutput } from './types'

const scoreDimensions = new Set(Object.values(AiReviewScoreDimension))
const findingCategories = new Set(Object.values(AiFindingCategory))
const issueTypes = new Set(Object.values(AiIssueType))
const severities = new Set(Object.values(AiIssueSeverity))

export function validateReviewOutput(value: unknown, sentenceIndexes: Set<number>): ReviewOutput {
  if (!value || typeof value !== 'object') {
    throw new Error('AI output must be an object')
  }

  const data = value as Record<string, any>
  const output: ReviewOutput = {
    overallBand: normalizeScore(data.overallBand),
    summary: requiredString(data.summary, 'summary'),
    priorityAdvice: optionalString(data.priorityAdvice),
    scores: arrayOf(data.scores, 'scores').map((item, index) => ({
      dimension: enumValue(item.dimension, scoreDimensions, `scores[${index}].dimension`) as AiReviewScoreDimension,
      score: normalizeScore(item.score),
      rationale: requiredString(item.rationale, `scores[${index}].rationale`),
      evidence: optionalString(item.evidence),
    })),
    globalFindings: arrayOf(data.globalFindings, 'globalFindings').map((item, index) => ({
      category: enumValue(item.category, findingCategories, `globalFindings[${index}].category`) as AiFindingCategory,
      severity: enumValue(item.severity || 'MEDIUM', severities, `globalFindings[${index}].severity`) as AiIssueSeverity,
      title: requiredString(item.title, `globalFindings[${index}].title`),
      explanation: requiredString(item.explanation, `globalFindings[${index}].explanation`),
      suggestion: optionalString(item.suggestion),
    })),
    sentenceAnnotations: arrayOf(data.sentenceAnnotations, 'sentenceAnnotations').map((item, index) => {
      const sentenceIndex = Number(item.sentenceIndex)
      if (!Number.isInteger(sentenceIndex) || !sentenceIndexes.has(sentenceIndex)) {
        throw new Error(`sentenceAnnotations[${index}].sentenceIndex does not match input sentences`)
      }
      return {
        sentenceIndex,
        originalText: requiredString(item.originalText, `sentenceAnnotations[${index}].originalText`),
        issueType: enumValue(item.issueType, issueTypes, `sentenceAnnotations[${index}].issueType`) as AiIssueType,
        subtype: optionalString(item.subtype),
        severity: enumValue(item.severity || 'MEDIUM', severities, `sentenceAnnotations[${index}].severity`) as AiIssueSeverity,
        explanation: requiredString(item.explanation, `sentenceAnnotations[${index}].explanation`),
        suggestion: optionalString(item.suggestion),
        rubricDimension: item.rubricDimension
          ? enumValue(item.rubricDimension, scoreDimensions, `sentenceAnnotations[${index}].rubricDimension`) as AiReviewScoreDimension
          : null,
      }
    }),
    rewrites: arrayOf(data.rewrites, 'rewrites').map((item, index) => {
      const sentenceIndex = item.sentenceIndex == null ? null : Number(item.sentenceIndex)
      if (sentenceIndex != null && (!Number.isInteger(sentenceIndex) || !sentenceIndexes.has(sentenceIndex))) {
        throw new Error(`rewrites[${index}].sentenceIndex does not match input sentences`)
      }
      return {
        sentenceIndex,
        paragraphIndex: item.paragraphIndex == null ? null : Number(item.paragraphIndex),
        originalText: requiredString(item.originalText, `rewrites[${index}].originalText`),
        rewrittenText: requiredString(item.rewrittenText, `rewrites[${index}].rewrittenText`),
        reason: optionalString(item.reason),
      }
    }),
  }

  return output
}

function normalizeScore(value: unknown): number | null {
  if (value == null || value === '') return null
  const score = Number(value)
  if (!Number.isFinite(score) || score < 0 || score > 9) {
    throw new Error(`Invalid score: ${value}`)
  }
  return Math.round(score * 2) / 2
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} is required`)
  }
  return value.trim()
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function arrayOf(value: unknown, path: string): any[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`)
  }
  return value
}

function enumValue(value: unknown, allowed: Set<string>, path: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`${path} is invalid`)
  }
  return value
}
