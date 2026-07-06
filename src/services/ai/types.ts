import {
  AiAnnotationLevel,
  AiAnnotationLocationStatus,
  AiFindingCategory,
  AiIssueSeverity,
  AiIssueType,
  AiRevisionOperation,
  AiReviewScoreDimension,
  TaskType,
} from '@prisma/client'

export interface PreprocessedSentence {
  index: number
  text: string
  paragraphIndex: number
  startOffset: number
  endOffset: number
}

export interface PreprocessedParagraph {
  index: number
  text: string
  sentenceIndexes: number[]
  startOffset: number
  endOffset: number
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
  documentId: number
  chunkText: string
  chunkType: string
  sourceType: string
  documentTitle: string
  task: TaskType | null
  subtype: string | null
  topic: string | null
  score: number
  semanticScore?: number | null
}

export type RagRetrievalStage = 'GLOBAL' | 'PARAGRAPH' | 'SENTENCE'

export interface RagEvidenceGroup {
  stage: RagRetrievalStage
  targetIndex: number | null
  targetText: string | null
  chunks: RagChunk[]
}

export interface RagRetrievalPlan {
  groups: RagEvidenceGroup[]
  promptChunks: RagChunk[]
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
  paragraphIndex?: number | null
  sentenceIndex: number | null
  level: AiAnnotationLevel
  originalText: string
  anchorText?: string | null
  startOffset?: number | null
  endOffset?: number | null
  occurrence?: number | null
  locationStatus: AiAnnotationLocationStatus
  issueType: AiIssueType
  subtype?: string | null
  severity: AiIssueSeverity
  explanation: string
  suggestion?: string | null
  replacementText?: string | null
  rubricDimension?: AiReviewScoreDimension | null
}

export interface RewriteOutput {
  sentenceIndex?: number | null
  paragraphIndex?: number | null
  level: AiAnnotationLevel
  operation: AiRevisionOperation
  anchorText?: string | null
  startOffset?: number | null
  endOffset?: number | null
  occurrence?: number | null
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
  ragGroups?: RagEvidenceGroup[]
}
