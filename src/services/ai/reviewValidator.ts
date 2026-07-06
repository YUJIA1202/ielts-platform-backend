import {
  AiAnnotationLevel,
  AiAnnotationLocationStatus,
  AiFindingCategory,
  AiIssueSeverity,
  AiIssueType,
  AiRevisionOperation,
  AiReviewScoreDimension,
} from '@prisma/client'
import { PreprocessedEssay, ReviewOutput } from './types'

const scoreDimensions = new Set(Object.values(AiReviewScoreDimension))
const findingCategories = new Set(Object.values(AiFindingCategory))
const issueTypes = new Set(Object.values(AiIssueType))
const severities = new Set(Object.values(AiIssueSeverity))
const annotationLevels = new Set(Object.values(AiAnnotationLevel))
const revisionOperations = new Set(Object.values(AiRevisionOperation))

export function validateReviewOutput(value: unknown, essay: PreprocessedEssay): ReviewOutput {
  if (!value || typeof value !== 'object') throw new Error('AI output must be an object')
  const data = value as Record<string, any>

  return {
    overallBand: normalizeScore(data.overallBand),
    summary: requiredString(data.summary, 'summary'),
    priorityAdvice: optionalString(data.priorityAdvice),
    scores: arrayOf(data.scores, 'scores').map((item, index) => ({
      dimension: scoreDimensionValue(item.dimension, `scores[${index}].dimension`),
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
    sentenceAnnotations: arrayOf(data.sentenceAnnotations, 'sentenceAnnotations')
      .map((item, index) => validateAnnotation(item, index, essay)),
    rewrites: arrayOf(data.rewrites, 'rewrites')
      .map((item, index) => validateRewrite(item, index, essay)),
  }
}

function validateAnnotation(item: any, index: number, essay: PreprocessedEssay) {
  const level = enumValue(
    item.level || 'SENTENCE',
    annotationLevels,
    `sentenceAnnotations[${index}].level`,
  ) as AiAnnotationLevel
  const sentenceIndex = nullableIndex(item.sentenceIndex)
  const sentence = sentenceIndex == null
    ? null
    : essay.sentences.find(candidate => candidate.index === sentenceIndex) || null
  if (sentenceIndex != null && !sentence) {
    throw new Error(`sentenceAnnotations[${index}].sentenceIndex does not match input sentences`)
  }
  if (level !== AiAnnotationLevel.PARAGRAPH && !sentence) {
    throw new Error(`sentenceAnnotations[${index}] requires a sentenceIndex for ${level}`)
  }

  const paragraphIndex = nullableIndex(item.paragraphIndex) || sentence?.paragraphIndex || null
  const paragraph = paragraphIndex == null
    ? null
    : essay.paragraphs.find(candidate => candidate.index === paragraphIndex) || null
  if (paragraphIndex != null && !paragraph) {
    throw new Error(`sentenceAnnotations[${index}].paragraphIndex does not match input paragraphs`)
  }

  const originalText = requiredString(item.originalText, `sentenceAnnotations[${index}].originalText`)
  const anchorText = optionalString(item.anchorText) || (level === AiAnnotationLevel.SENTENCE ? originalText : null)
  const occurrence = normalizeOccurrence(item.occurrence)
  const location = resolveLocation({ essay, sentence, paragraph, anchorText, occurrence, level })

  return {
    paragraphIndex,
    sentenceIndex,
    level,
    originalText,
    anchorText,
    startOffset: location.startOffset,
    endOffset: location.endOffset,
    occurrence,
    locationStatus: location.status,
    issueType: issueTypeValue(item.issueType, `sentenceAnnotations[${index}].issueType`),
    subtype: optionalString(item.subtype),
    severity: enumValue(item.severity || 'MEDIUM', severities, `sentenceAnnotations[${index}].severity`) as AiIssueSeverity,
    explanation: requiredString(item.explanation, `sentenceAnnotations[${index}].explanation`),
    suggestion: optionalString(item.suggestion),
    replacementText: optionalString(item.replacementText),
    rubricDimension: item.rubricDimension
      ? scoreDimensionValue(item.rubricDimension, `sentenceAnnotations[${index}].rubricDimension`)
      : null,
  }
}

function validateRewrite(item: any, index: number, essay: PreprocessedEssay) {
  const level = enumValue(item.level || 'SENTENCE', annotationLevels, `rewrites[${index}].level`) as AiAnnotationLevel
  const operation = enumValue(item.operation || 'REPLACE', revisionOperations, `rewrites[${index}].operation`) as AiRevisionOperation
  const sentenceIndex = nullableIndex(item.sentenceIndex)
  const sentence = sentenceIndex == null ? null : essay.sentences.find(candidate => candidate.index === sentenceIndex) || null
  if (sentenceIndex != null && !sentence) throw new Error(`rewrites[${index}].sentenceIndex does not match input sentences`)
  const paragraphIndex = nullableIndex(item.paragraphIndex) || sentence?.paragraphIndex || null
  const paragraph = paragraphIndex == null ? null : essay.paragraphs.find(candidate => candidate.index === paragraphIndex) || null
  if (paragraphIndex != null && !paragraph) throw new Error(`rewrites[${index}].paragraphIndex does not match input paragraphs`)

  const originalText = requiredString(item.originalText, `rewrites[${index}].originalText`)
  const anchorText = optionalString(item.anchorText) || originalText
  const occurrence = normalizeOccurrence(item.occurrence)
  const location = resolveLocation({ essay, sentence, paragraph, anchorText, occurrence, level })
  const operationLocation = operation === AiRevisionOperation.INSERT && location.endOffset != null
    ? { ...location, startOffset: location.endOffset }
    : location
  return {
    sentenceIndex,
    paragraphIndex,
    level,
    operation,
    anchorText,
    startOffset: operationLocation.startOffset,
    endOffset: operationLocation.endOffset,
    occurrence,
    originalText,
    rewrittenText: requiredString(item.rewrittenText, `rewrites[${index}].rewrittenText`),
    reason: optionalString(item.reason),
  }
}

function resolveLocation(input: {
  essay: PreprocessedEssay
  sentence: PreprocessedEssay['sentences'][number] | null
  paragraph: PreprocessedEssay['paragraphs'][number] | null
  anchorText: string | null
  occurrence: number
  level: AiAnnotationLevel
}) {
  const range = input.sentence || input.paragraph
  if (!range) return unresolvedLocation()
  if (!input.anchorText) {
    if (input.level === AiAnnotationLevel.SENTENCE || input.level === AiAnnotationLevel.PARAGRAPH) {
      return { startOffset: range.startOffset, endOffset: range.endOffset, status: AiAnnotationLocationStatus.RESOLVED }
    }
    return unresolvedLocation()
  }

  const localIndex = findOccurrence(range.text, input.anchorText, input.occurrence)
  if (localIndex < 0) return unresolvedLocation()
  const startOffset = range.startOffset + localIndex
  return {
    startOffset,
    endOffset: startOffset + input.anchorText.length,
    status: AiAnnotationLocationStatus.RESOLVED,
  }
}

function findOccurrence(text: string, needle: string, occurrence: number) {
  const lowerText = text.toLocaleLowerCase()
  const lowerNeedle = needle.toLocaleLowerCase()
  let from = 0
  let found = -1
  for (let current = 0; current < occurrence; current += 1) {
    found = lowerText.indexOf(lowerNeedle, from)
    if (found < 0) return -1
    from = found + lowerNeedle.length
  }
  return found
}

function unresolvedLocation() {
  return { startOffset: null, endOffset: null, status: AiAnnotationLocationStatus.UNRESOLVED }
}

function nullableIndex(value: unknown): number | null {
  if (value == null || value === '') return null
  const index = Number(value)
  return Number.isInteger(index) && index > 0 ? index : null
}

function normalizeOccurrence(value: unknown) {
  const occurrence = Number(value || 1)
  return Number.isInteger(occurrence) && occurrence > 0 ? occurrence : 1
}

function normalizeScore(value: unknown): number | null {
  if (value == null || value === '') return null
  const score = Number(value)
  if (!Number.isFinite(score) || score < 0 || score > 9) throw new Error(`Invalid score: ${value}`)
  return Math.round(score * 2) / 2
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} is required`)
  return value.trim()
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function arrayOf(value: unknown, path: string): any[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value
}

function enumValue(value: unknown, allowed: Set<string>, path: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) throw new Error(`${path} is invalid`)
  return value
}

function issueTypeValue(value: unknown, path: string): AiIssueType {
  if (typeof value !== 'string') throw new Error(`${path} is invalid`)
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_')
  const aliases: Record<string, AiIssueType> = {
    SPELLING: AiIssueType.GRAMMAR,
    PUNCTUATION: AiIssueType.GRAMMAR,
    WORD_CHOICE: AiIssueType.VOCABULARY,
    COLLOCATION: AiIssueType.VOCABULARY,
    ARGUMENTATION: AiIssueType.LOGIC,
    CLARITY: AiIssueType.STYLE,
    RELEVANCE: AiIssueType.TASK_RESPONSE,
  }
  const candidate = aliases[normalized] || normalized
  if (!issueTypes.has(candidate)) throw new Error(`${path} is invalid: ${value}`)
  return candidate as AiIssueType
}

function scoreDimensionValue(value: unknown, path: string): AiReviewScoreDimension {
  if (typeof value !== 'string') throw new Error(`${path} is invalid`)
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_')
  const aliases: Record<string, AiReviewScoreDimension> = {
    TR: AiReviewScoreDimension.TASK_RESPONSE,
    TA: AiReviewScoreDimension.TASK_RESPONSE,
    TASK_ACHIEVEMENT: AiReviewScoreDimension.TASK_RESPONSE,
    CC: AiReviewScoreDimension.COHERENCE_COHESION,
    COHERENCE_AND_COHESION: AiReviewScoreDimension.COHERENCE_COHESION,
    LR: AiReviewScoreDimension.LEXICAL_RESOURCE,
    GRA: AiReviewScoreDimension.GRAMMAR_RANGE_ACCURACY,
    GRAMMATICAL_RANGE_ACCURACY: AiReviewScoreDimension.GRAMMAR_RANGE_ACCURACY,
    GRAMMATICAL_RANGE_AND_ACCURACY: AiReviewScoreDimension.GRAMMAR_RANGE_ACCURACY,
    GRAMMAR_RANGE_AND_ACCURACY: AiReviewScoreDimension.GRAMMAR_RANGE_ACCURACY,
  }
  const candidate = aliases[normalized] || normalized
  if (!scoreDimensions.has(candidate)) throw new Error(`${path} is invalid: ${value}`)
  return candidate as AiReviewScoreDimension
}
