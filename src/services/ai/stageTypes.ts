import { AiFindingCategory, AiIssueSeverity, AiReviewScoreDimension } from '@prisma/client'
import { ReviewScoreOutput, SentenceAnnotationOutput, RewriteOutput } from './types'

export interface GlobalAnalysisOutput {
  overallBand: number | null
  scores: ReviewScoreOutput[]
  summary: string
  priorityAdvice: string
  taskFulfilment: string
  positionAndThesis: string
  organization: string
  argumentDevelopment: string
  strengths: string[]
  priorityProblems: Array<{
    category: AiFindingCategory
    severity: AiIssueSeverity
    explanation: string
    suggestion?: string | null
  }>
  paragraphRoles: Array<{ paragraphIndex: number; intendedRole: string; effectiveness: string }>
}

export interface DimensionDeepDiveOutput {
  dimension: AiReviewScoreDimension
  score: number | null
  longEvaluation: string
}

export interface ParagraphAnalysisOutput {
  paragraphIndex: number
  function: string
  tr: string
  cc: string
  lr: string
  gra: string
  topicSentence: string
  development: string
  cohesion: string
  relationToQuestion: string
  findings: Array<{
    category: AiFindingCategory
    severity: AiIssueSeverity
    explanation: string
    suggestion?: string | null
  }>
  revisedParagraph?: string | null
}

export interface ParagraphBatchAnalysisOutput {
  paragraphs: ParagraphAnalysisOutput[]
}

export interface SentenceBatchAnalysisOutput {
  sentenceIndexes: number[]
  sentenceReviews: Array<{
    sentenceIndex: number
    overall: string
    tr: string
    cc: string
    lr: string
    gra: string
  }>
  annotations: SentenceAnnotationOutput[]
  rewrites: RewriteOutput[]
}

export interface VerificationOutput {
  accepted: boolean
  missedIssues: SentenceAnnotationOutput[]
  rejectedAnnotationIndexes: number[]
  duplicateAnnotationGroups: number[][]
  contradictoryFindings: string[]
  revisionProblems: string[]
  repairInstructions: string[]
}

export interface FullRewriteOutput {
  preservedStudentPosition: boolean
  stanceChanged: boolean
  originalPosition: string
  finalPosition: string
  stanceChangeReason: string | null
  addedClaims: Array<{
    claim: string
    reason: string
  }>
  strategySummary: string
  fullRewrite: string
}
