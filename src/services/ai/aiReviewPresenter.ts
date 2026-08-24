import {
  AiAnnotationLevel,
  AiIssueSeverity,
  AiReviewScoreDimension,
  AiRewriteLayer,
  TaskType,
} from '@prisma/client'

type JsonRecord = Record<string, unknown>

interface SnapshotLike {
  normalizedQuestion?: string | null
  normalizedEssay?: string | null
  sentenceJson?: unknown
  paragraphJson?: unknown
  wordCount?: number | null
  detectedTask?: TaskType | null
  detectedSubtype?: string | null
  detectedTopic?: string | null
}

interface RequestLike {
  questionText?: string | null
  essayText?: string | null
  task?: TaskType | null
  subtype?: string | null
  topic?: string | null
}

interface ScoreLike {
  dimension: AiReviewScoreDimension
  score: number | null
  rationale: string
  evidence?: string | null
}

interface FindingLike {
  id?: number
  category: string
  severity: AiIssueSeverity
  title: string
  explanation: string
  suggestion?: string | null
}

interface AnnotationLike {
  id?: number
  paragraphIndex?: number | null
  sentenceIndex?: number | null
  level: AiAnnotationLevel
  originalText: string
  anchorText?: string | null
  startOffset?: number | null
  endOffset?: number | null
  occurrence?: number | null
  locationStatus: string
  issueType: string
  subtype?: string | null
  severity: AiIssueSeverity
  explanation: string
  suggestion?: string | null
  replacementText?: string | null
  rubricDimension?: AiReviewScoreDimension | null
}

interface RewriteLike {
  id?: number
  paragraphIndex?: number | null
  sentenceIndex?: number | null
  level: AiAnnotationLevel
  rewriteLayer?: AiRewriteLayer | null
  originalText: string
  rewrittenText: string
  reason?: string | null
  anchorText?: string | null
  startOffset?: number | null
  endOffset?: number | null
  occurrence?: number | null
}

interface ReviewLike {
  id: number
  overallBand?: number | null
  summary: string
  priorityAdvice?: string | null
  rawOutput?: unknown
  createdAt?: Date
  updatedAt?: Date
  request?: RequestLike | null
  job?: { snapshot?: SnapshotLike | null } | null
  scores?: ScoreLike[]
  findings?: FindingLike[]
  annotations?: AnnotationLike[]
  rewrites?: RewriteLike[]
}

interface TextUnit {
  index: number
  text: string
  paragraphIndex?: number
  sentenceIndexes?: number[]
  startOffset?: number | null
  endOffset?: number | null
}

interface ParagraphAnalysisLike {
  paragraphIndex: number
  function?: string
  tr?: string
  cc?: string
  lr?: string
  gra?: string
  topicSentence?: string
  development?: string
  cohesion?: string
  relationToQuestion?: string
  findings?: FindingLike[]
  revisedParagraph?: string | null
}

interface FullRewriteLike {
  preservedStudentPosition: boolean
  stanceChanged: boolean
  originalPosition: string
  finalPosition: string
  stanceChangeReason: string | null
  addedClaims: Array<{ claim: string; reason: string }>
  strategySummary: string
  fullRewrite: string
}

interface SentenceAnalysisLike {
  sentenceIndex: number
  overall?: string
  tr?: string
  cc?: string
  lr?: string
  gra?: string
}

const SCORE_LABELS: Record<AiReviewScoreDimension, string> = {
  OVERALL: '总分',
  TASK_RESPONSE: 'TR 任务回应',
  COHERENCE_COHESION: 'CC 连贯衔接',
  LEXICAL_RESOURCE: 'LR 词汇资源',
  GRAMMAR_RANGE_ACCURACY: 'GRA 语法准确性',
}

const REWRITE_LAYER_LABELS: Record<AiRewriteLayer, string> = {
  LANGUAGE: '语言层',
  COHERENCE: '段内逻辑层',
  TASK: 'TR 层',
  PARAGRAPH: '段级改写',
}

const SEVERITY_WEIGHT: Record<AiIssueSeverity, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
}

export function buildAiReviewPresentation(review: ReviewLike) {
  const snapshot = review.job?.snapshot || null
  const paragraphs = readTextUnits(snapshot?.paragraphJson)
  const sentences = readTextUnits(snapshot?.sentenceJson)
  const paragraphAnalyses = readParagraphAnalyses(review.rawOutput)
  const sentenceAnalyses = readSentenceAnalyses(review.rawOutput)
  const fullRewrite = readFullRewrite(review.rawOutput)
  const annotations = review.annotations || []
  const rewrites = review.rewrites || []

  const annotationsBySentence = groupByNullableNumber(annotations, annotation => annotation.sentenceIndex)
  const annotationsByParagraph = groupByNullableNumber(annotations, annotation => annotation.paragraphIndex)
  const rewritesBySentence = groupByNullableNumber(rewrites, rewrite => rewrite.sentenceIndex)
  const rewritesByParagraph = groupByNullableNumber(rewrites, rewrite => rewrite.paragraphIndex)

  return {
    version: 'ai-review-presentation-v2',
    question: {
      text: snapshot?.normalizedQuestion || review.request?.questionText || null,
      task: snapshot?.detectedTask || review.request?.task || null,
      subtype: snapshot?.detectedSubtype || review.request?.subtype || null,
      topic: snapshot?.detectedTopic || review.request?.topic || null,
    },
    essay: {
      text: snapshot?.normalizedEssay || review.request?.essayText || '',
      wordCount: snapshot?.wordCount ?? null,
      paragraphs,
      sentences,
    },
    tabs: {
      sentenceAnnotations: {
        kind: 'sentence-annotation-tab',
        sentences: sentences.map(sentence => {
          const items = annotationsBySentence.get(sentence.index) || []
          return {
            paragraphIndex: sentence.paragraphIndex || null,
            sentenceIndex: sentence.index,
            text: sentence.text,
            startOffset: sentence.startOffset ?? null,
            endOffset: sentence.endOffset ?? null,
            annotations: items,
            summary: summarizeAnnotations(items),
          }
        }),
      },
      overallScores: {
        kind: 'overall-score-tab',
        overallBand: review.overallBand ?? scoreFor(review.scores || [], AiReviewScoreDimension.OVERALL),
        summary: review.summary,
        priorityAdvice: review.priorityAdvice || null,
        dimensions: orderScores(review.scores || []).map(score => ({
          ...score,
          label: SCORE_LABELS[score.dimension],
          sentenceRefs: extractSentenceRefs(`${score.rationale} ${score.evidence || ''}`),
        })),
        findings: (review.findings || []).filter(finding => !isParagraphFinding(finding)).map(withFindingRefs),
      },
      paragraphReview: {
        kind: 'paragraph-review-tab',
        paragraphs: paragraphs.map(paragraph => {
          const analysis = paragraphAnalyses.get(paragraph.index)
          const stageFindings = analysis?.findings || []
          const storedFindings = (review.findings || []).filter(finding => paragraphFindingIndex(finding) === paragraph.index)
          const paragraphFindings = stageFindings.length ? stageFindings : storedFindings
          const paragraphRewrites = (rewritesByParagraph.get(paragraph.index) || [])
            .filter(rewrite => rewrite.level === AiAnnotationLevel.PARAGRAPH)
          return {
            paragraphIndex: paragraph.index,
            text: paragraph.text,
            sentenceIndexes: paragraph.sentenceIndexes || [],
            function: analysis?.function || null,
            dimensions: {
              TR: analysis?.tr || analysis?.relationToQuestion || null,
              CC: analysis?.cc || analysis?.cohesion || null,
              LR: analysis?.lr || null,
              GRA: analysis?.gra || null,
            },
            dimensionSentenceRefs: {
              TR: extractSentenceRefs(`${analysis?.tr || ''} ${analysis?.relationToQuestion || ''}`),
              CC: extractSentenceRefs(`${analysis?.cc || ''} ${analysis?.cohesion || ''}`),
              LR: extractSentenceRefs(analysis?.lr || ''),
              GRA: extractSentenceRefs(analysis?.gra || ''),
            },
            topicSentence: analysis?.topicSentence || null,
            development: analysis?.development || null,
            cohesion: analysis?.cohesion || null,
            relationToQuestion: analysis?.relationToQuestion || null,
            findings: paragraphFindings.map(withFindingRefs),
            annotations: annotationsByParagraph.get(paragraph.index) || [],
            paragraphRewrites,
          }
        }),
      },
      rewrites: {
        kind: 'rewrite-tab',
        sentences: sentences.map(sentence => {
          const sentenceRewrites = (rewritesBySentence.get(sentence.index) || [])
            .filter(rewrite => rewrite.level !== AiAnnotationLevel.PARAGRAPH)
          return {
            paragraphIndex: sentence.paragraphIndex || null,
            sentenceIndex: sentence.index,
            originalText: sentence.text,
            annotations: annotationsBySentence.get(sentence.index) || [],
            layers: groupRewritesByLayer(sentenceRewrites),
          }
        }),
        paragraphRewrites: rewrites
          .filter(rewrite => rewrite.level === AiAnnotationLevel.PARAGRAPH)
          .map(rewrite => ({
            ...rewrite,
            rewriteLayer: rewrite.rewriteLayer || AiRewriteLayer.PARAGRAPH,
            layerLabel: REWRITE_LAYER_LABELS[AiRewriteLayer.PARAGRAPH],
          })),
      },
      sentenceReview: {
        kind: 'sentence-review-tab',
        sentences: sentences.map(sentence => {
          const sentenceAnnotations = annotationsBySentence.get(sentence.index) || []
          const analysis = sentenceAnalyses.get(sentence.index)
          const annotationsByDimension = groupAnnotationsByDimension(sentenceAnnotations)
          const sentenceRewrites = (rewritesBySentence.get(sentence.index) || [])
            .filter(rewrite => rewrite.level !== AiAnnotationLevel.PARAGRAPH)
          return {
            paragraphIndex: sentence.paragraphIndex || null,
            sentenceIndex: sentence.index,
            originalText: sentence.text,
            annotations: sentenceAnnotations,
            overallEvaluation: analysis?.overall || null,
            dimensions: {
              TR: { evaluation: analysis?.tr || null, annotations: annotationsByDimension.TR },
              CC: { evaluation: analysis?.cc || null, annotations: annotationsByDimension.CC },
              LR: { evaluation: analysis?.lr || null, annotations: annotationsByDimension.LR },
              GRA: { evaluation: analysis?.gra || null, annotations: annotationsByDimension.GRA },
            },
            layers: groupRewritesByLayer(sentenceRewrites),
          }
        }),
      },
      paragraphRestructure: {
        kind: 'paragraph-restructure-tab',
        paragraphs: paragraphs.flatMap(paragraph => {
          const rewritesForParagraph = (rewritesByParagraph.get(paragraph.index) || [])
            .filter(rewrite => rewrite.level === AiAnnotationLevel.PARAGRAPH)
          const analysisRewrite = paragraphAnalyses.get(paragraph.index)?.revisedParagraph || null
          const rewrittenText = rewritesForParagraph[0]?.rewrittenText || analysisRewrite
          if (!rewrittenText || rewrittenText === paragraph.text) return []
          return [{
            paragraphIndex: paragraph.index,
            originalText: paragraph.text,
            rewrittenText,
            reason: rewritesForParagraph[0]?.reason || '根据本段的任务回应、展开与衔接问题进行整体重构。',
            sentenceRefs: paragraph.sentenceIndexes || [],
          }]
        }),
      },
      fullRewrite: {
        kind: 'full-rewrite-tab',
        originalText: snapshot?.normalizedEssay || review.request?.essayText || '',
        ...fullRewrite,
      },
    },
  }
}

function readTextUnits(value: unknown): TextUnit[] {
  return Array.isArray(value)
    ? value.map(item => asTextUnit(item)).filter((item): item is TextUnit => Boolean(item))
    : []
}

function asTextUnit(value: unknown): TextUnit | null {
  const item = asRecord(value)
  if (!item) return null
  const index = numberValue(item.index)
  const text = stringValue(item.text)
  if (!index || !text) return null
  const paragraphIndex = numberValue(item.paragraphIndex)
  const sentenceIndexes = Array.isArray(item.sentenceIndexes)
    ? item.sentenceIndexes.map(numberValue).filter((candidate): candidate is number => Boolean(candidate))
    : undefined
  return {
    index,
    text,
    paragraphIndex: paragraphIndex || undefined,
    sentenceIndexes,
    startOffset: numberValue(item.startOffset),
    endOffset: numberValue(item.endOffset),
  }
}

function readParagraphAnalyses(rawOutput: unknown) {
  const raw = asRecord(rawOutput)
  const analyses = new Map<number, ParagraphAnalysisLike>()
  if (!raw || !Array.isArray(raw.paragraphs)) return analyses
  for (const value of raw.paragraphs) {
    const item = asRecord(value)
    const paragraphIndex = item ? numberValue(item.paragraphIndex) : null
    if (!item || !paragraphIndex) continue
    analyses.set(paragraphIndex, {
      paragraphIndex,
      function: stringValue(item.function) || undefined,
      tr: stringValue(item.tr) || undefined,
      cc: stringValue(item.cc) || undefined,
      lr: stringValue(item.lr) || undefined,
      gra: stringValue(item.gra) || undefined,
      topicSentence: stringValue(item.topicSentence) || undefined,
      development: stringValue(item.development) || undefined,
      cohesion: stringValue(item.cohesion) || undefined,
      relationToQuestion: stringValue(item.relationToQuestion) || undefined,
      findings: Array.isArray(item.findings) ? item.findings.map(asFinding).filter((finding): finding is FindingLike => Boolean(finding)) : [],
      revisedParagraph: stringValue(item.revisedParagraph),
    })
  }
  return analyses
}

function readFullRewrite(rawOutput: unknown): FullRewriteLike | null {
  const raw = asRecord(rawOutput)
  const value = raw ? asRecord(raw.fullRewrite) : null
  if (!value) return null
  const fullRewrite = stringValue(value.fullRewrite)
  if (!fullRewrite) return null
  return {
    preservedStudentPosition: value.preservedStudentPosition === true,
    stanceChanged: value.stanceChanged === true,
    originalPosition: stringValue(value.originalPosition) || '',
    finalPosition: stringValue(value.finalPosition) || '',
    stanceChangeReason: stringValue(value.stanceChangeReason),
    addedClaims: Array.isArray(value.addedClaims)
      ? value.addedClaims.flatMap(item => {
          const record = asRecord(item)
          const claim = record ? stringValue(record.claim) : null
          const reason = record ? stringValue(record.reason) : null
          return claim && reason ? [{ claim, reason }] : []
        })
      : [],
    strategySummary: stringValue(value.strategySummary) || '',
    fullRewrite,
  }
}

function readSentenceAnalyses(rawOutput: unknown) {
  const raw = asRecord(rawOutput)
  const analyses = new Map<number, SentenceAnalysisLike>()
  if (!raw || !Array.isArray(raw.sentences)) return analyses
  for (const value of raw.sentences) {
    const item = asRecord(value)
    const sentenceIndex = item ? numberValue(item.sentenceIndex) : null
    if (!item || !sentenceIndex) continue
    analyses.set(sentenceIndex, {
      sentenceIndex,
      overall: stringValue(item.overall) || undefined,
      tr: stringValue(item.tr) || undefined,
      cc: stringValue(item.cc) || undefined,
      lr: stringValue(item.lr) || undefined,
      gra: stringValue(item.gra) || undefined,
    })
  }
  return analyses
}

function asFinding(value: unknown): FindingLike | null {
  const item = asRecord(value)
  if (!item) return null
  const category = stringValue(item.category)
  const severity = stringValue(item.severity) as AiIssueSeverity | null
  const explanation = stringValue(item.explanation)
  if (!category || !severity || !explanation) return null
  return {
    category,
    severity,
    title: stringValue(item.title) || category,
    explanation,
    suggestion: stringValue(item.suggestion),
  }
}

function summarizeAnnotations(items: AnnotationLike[]) {
  const byDimension = items.reduce<Record<string, number>>((acc, item) => {
    const key = item.rubricDimension || item.issueType || 'UNKNOWN'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
  const maxSeverity = items.reduce<AiIssueSeverity | null>((current, item) => {
    if (!current) return item.severity
    return SEVERITY_WEIGHT[item.severity] > SEVERITY_WEIGHT[current] ? item.severity : current
  }, null)
  return {
    count: items.length,
    byDimension,
    maxSeverity,
    hasUnresolvedLocation: items.some(item => item.locationStatus !== 'RESOLVED'),
  }
}

function groupAnnotationsByDimension(items: AnnotationLike[]) {
  const dimensions: Record<'TR' | 'CC' | 'LR' | 'GRA', AnnotationLike[]> = {
    TR: [], CC: [], LR: [], GRA: [],
  }
  for (const item of items) {
    const dimension = annotationDimension(item)
    dimensions[dimension].push(item)
  }
  return dimensions
}

function annotationDimension(item: AnnotationLike): 'TR' | 'CC' | 'LR' | 'GRA' {
  if (item.rubricDimension === AiReviewScoreDimension.TASK_RESPONSE || item.issueType === 'TASK_RESPONSE') return 'TR'
  if (item.rubricDimension === AiReviewScoreDimension.COHERENCE_COHESION || ['LOGIC', 'COHESION', 'STRUCTURE'].includes(item.issueType)) return 'CC'
  if (item.rubricDimension === AiReviewScoreDimension.GRAMMAR_RANGE_ACCURACY || item.issueType === 'GRAMMAR') return 'GRA'
  return 'LR'
}

function withFindingRefs(finding: FindingLike) {
  return {
    ...finding,
    sentenceRefs: extractSentenceRefs(`${finding.explanation} ${finding.suggestion || ''}`),
  }
}

function extractSentenceRefs(text: string) {
  const refs = new Set<number>()
  for (const match of text.matchAll(/S(\d+)\s*[-–—]\s*S?(\d+)/gi)) {
    const start = Number(match[1])
    const end = Number(match[2])
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || end - start > 40) continue
    for (let index = start; index <= end; index += 1) refs.add(index)
  }
  for (const match of text.matchAll(/S(\d+)/gi)) refs.add(Number(match[1]))
  return Array.from(refs).filter(Number.isInteger).sort((left, right) => left - right)
}

function groupRewritesByLayer(rewrites: RewriteLike[]) {
  const order = [AiRewriteLayer.LANGUAGE, AiRewriteLayer.COHERENCE, AiRewriteLayer.TASK]
  return order.map(layer => {
    const items = rewrites.filter(rewrite => normalizeRewriteLayer(rewrite) === layer)
    return {
      rewriteLayer: layer,
      label: REWRITE_LAYER_LABELS[layer],
      rewrites: items,
    }
  }).filter(group => group.rewrites.length > 0)
}

function normalizeRewriteLayer(rewrite: RewriteLike) {
  if (rewrite.rewriteLayer) return rewrite.rewriteLayer
  return rewrite.level === AiAnnotationLevel.PARAGRAPH ? AiRewriteLayer.PARAGRAPH : AiRewriteLayer.LANGUAGE
}

function orderScores(scores: ScoreLike[]) {
  const order = [
    AiReviewScoreDimension.TASK_RESPONSE,
    AiReviewScoreDimension.COHERENCE_COHESION,
    AiReviewScoreDimension.LEXICAL_RESOURCE,
    AiReviewScoreDimension.GRAMMAR_RANGE_ACCURACY,
    AiReviewScoreDimension.OVERALL,
  ]
  return [...scores].sort((a, b) => order.indexOf(a.dimension) - order.indexOf(b.dimension))
}

function scoreFor(scores: ScoreLike[], dimension: AiReviewScoreDimension) {
  return scores.find(score => score.dimension === dimension)?.score ?? null
}

function groupByNullableNumber<T>(items: T[], keyFn: (item: T) => number | null | undefined) {
  const grouped = new Map<number, T[]>()
  for (const item of items) {
    const key = keyFn(item)
    if (key == null) continue
    grouped.set(key, [...(grouped.get(key) || []), item])
  }
  return grouped
}

function isParagraphFinding(finding: FindingLike) {
  return paragraphFindingIndex(finding) != null
}

function paragraphFindingIndex(finding: FindingLike) {
  const match = finding.title.match(/^第\s*(\d+)\s*段/)
  return match ? Number(match[1]) : null
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
