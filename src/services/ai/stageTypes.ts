import { AiFindingCategory, AiIssueSeverity } from '@prisma/client'
import { SentenceAnnotationOutput, RewriteOutput } from './types'

export interface GlobalAnalysisOutput {
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

export interface ParagraphAnalysisOutput {
  paragraphIndex: number
  function: string
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
