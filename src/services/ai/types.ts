import {
  AiFindingCategory,
  AiIssueSeverity,
  AiIssueType,
  AiReviewScoreDimension,
  TaskType,
} from '@prisma/client'

export interface PreprocessedSentence {
  index: number
  text: string
  paragraphIndex: number
}

export interface PreprocessedParagraph {
  index: number
  text: string
  sentenceIndexes: number[]
}

export interface PreprocessedEssay {
  normalizedQuestion: string | null
  normalizedEssay: string
  sentences: PreprocessedSentence[]
  paragraphs: PreprocessedParagraph[]
  wordCount: number
  detectedTask: TaskType | null
  detectedSubtype: string | null
  detectedTopic: string | null
}

export interface RagChunk {
  id: number
  chunkText: string
  chunkType: string
  task: TaskType | null
  subtype: string | null
  topic: string | null
  score: number
}

export interface ReviewScoreOutput {
  dimension: AiReviewScoreDimension
  score: number | null
  rationale: string
  evidence?: string | null
}

export interface GlobalFindingOutput {
  category: AiFindingCategory
  severity: AiIssueSeverity
  title: string
  explanation: string
  suggestion?: string | null
}

export interface SentenceAnnotationOutput {
  sentenceIndex: number
  originalText: string
  issueType: AiIssueType
  subtype?: string | null
  severity: AiIssueSeverity
  explanation: string
  suggestion?: string | null
  rubricDimension?: AiReviewScoreDimension | null
}

export interface RewriteOutput {
  sentenceIndex?: number | null
  paragraphIndex?: number | null
  originalText: string
  rewrittenText: string
  reason?: string | null
}

export interface ReviewOutput {
  overallBand: number | null
  summary: string
  priorityAdvice?: string | null
  scores: ReviewScoreOutput[]
  globalFindings: GlobalFindingOutput[]
  sentenceAnnotations: SentenceAnnotationOutput[]
  rewrites: RewriteOutput[]
}

export interface ComposePromptInput {
  questionText: string | null
  essayText: string
  preprocessed: PreprocessedEssay
  ragChunks: RagChunk[]
}
