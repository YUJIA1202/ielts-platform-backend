/**
 * Import normalized IELTS Task 2 Excel experiment data into the existing
 * Knowledge* schema. Dry-run is the default; writes require --write.
 *
 * The importer is intentionally non-destructive and idempotent by source title
 * plus source file hash. NEEDS_REVIEW and holdout documents are imported for
 * auditability but remain disabled for RAG.
 */

import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  AiAnnotationLocationStatus,
  AiIssueSeverity,
  AnchorType,
  KnowledgeChunkType,
  KnowledgeSourceType,
  KnowledgeVisibility,
  Prisma,
  TaskType,
} from '@prisma/client'
import prisma from '../src/prisma'

const DEFAULT_MANIFEST = path.resolve('data/rag-excel-task2-v2/manifest.json')
const DEFAULT_SOURCE_TITLE = 'EXPERIMENT_RAG_EXCEL_TASK2_V2'
const WRITE_MODE = process.argv.includes('--write')
let activeBatchId: number | null = null

type Dimension = 'TR' | 'CC' | 'LR' | 'GRA' | 'OVERALL'

interface SourceCell {
  sheet: string
  row: number
  column: string
}

interface Finding {
  ordinal: number
  scope: string
  kind: string
  content: string
  feedbackStartOffset: number | null
  feedbackEndOffset: number | null
  evidenceSids: string[]
  confidence: number | null
  semanticStatus: string
}

interface Assessment {
  dimension: Dimension
  score?: number | null
  status?: string | null
  tags?: string[]
  feedback: string | null
  evidenceSids?: string[]
  findings?: Finding[]
  source?: SourceCell | null
}

interface Rewrite {
  source: 'AI' | 'TEACHER'
  layers: string[]
  text: string | null
  note: string | null
  raw: string
  provenance?: SourceCell | null
}

interface WordAnnotation {
  index: number
  anchorText: string | null
  sentenceText: string | null
  feedback: string
  findings?: Finding[]
  source?: SourceCell | null
}

interface Sentence {
  sid: string
  versionId?: string
  sidOccurrence?: number
  index: number
  paragraphIndex: number | null
  text: string
  source?: SourceCell | null
  startOffset: number
  endOffset: number
  wordAnnotations: WordAnnotation[]
  dimensions: Assessment[]
  aiRewrite: Rewrite | null
  teacherRewrite: Rewrite | null
}

interface Paragraph {
  index: number
  label: string | null
  text: string
  startOffset: number
  endOffset: number
  dimensions: Assessment[]
  versionIds?: string[]
  source?: SourceCell | null
}

interface ManifestDocument {
  documentKey: string
  fileName: string
  sourcePath: string
  fileHash: string
  task: 'TASK2'
  subtype: string | null
  questionText: string | null
  questionSource?: string | null
  questionSourceKey?: string | null
  essayText: string
  wordCount: number
  overallBand: number | null
  globalAssessments: Assessment[]
  globalOther: Array<Record<string, unknown>>
  paragraphs: Paragraph[]
  sentences: Sentence[]
  opinions: Array<Record<string, unknown>>
  teachingNotes: Array<Record<string, unknown>>
  expansions: Array<Record<string, unknown>>
  modelEssay: { status: string; wordCount: number; text: string | null; rows: Array<Record<string, unknown>> }
  modelAnalysis: Array<Record<string, unknown>>
  quality: {
    status: 'STRUCTURALLY_VALID' | 'NEEDS_REVIEW'
    warnings: string[]
    allowedForRag: boolean
    excludeFromEval: boolean
    split: 'train' | 'holdout'
    labelAuthority: string
  }
  stats: Record<string, number>
}

interface Manifest {
  schemaVersion: string
  parserVersion: string
  summary: Record<string, number>
  documents: ManifestDocument[]
  errors: Array<{ sourcePath: string; error: string }>
}

function argValue(name: string, fallback: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function argLimit() {
  const raw = argValue('--limit', '')
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid --limit: ${raw}`)
  return parsed
}

function sha256(input: string | Buffer) {
  return createHash('sha256').update(input).digest('hex')
}

function normalizeQuestion(text: string) {
  return text.normalize('NFKC').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()
}

function sourceKey(prefix: string, ...parts: Array<string | number | null | undefined>) {
  return `${prefix}-${sha256(parts.map(part => String(part ?? '')).join('|')).slice(0, 24)}`
}

function sourceFromRecord(record: Record<string, unknown>, fallbackSheet: string) {
  return {
    sheet: typeof record.__sourceSheet === 'string' ? record.__sourceSheet : fallbackSheet,
    row: typeof record.__sourceRow === 'number' ? record.__sourceRow : null,
    column: typeof record.__sourceColumn === 'string' ? record.__sourceColumn : null,
  }
}

function rawRecord(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith('__')))
}

function extractSidRefs(text: string) {
  const matches = text.match(/(?<![A-Za-z0-9])(?:(?!s\d{1,3}-)[A-Za-z_][A-Za-z0-9_]*-){0,2}s\d{1,3}(?![A-Za-z0-9])/gi) || []
  return [...new Set(matches.map(item => item.toLowerCase()))]
}

function splitFindings(text: string, defaultScope: string): Finding[] {
  const findings: Finding[] = []
  let evidenceAppendix = false
  const pattern = /[^。！？；;\n]+(?:[。！？；;]|\n+|$)/gs
  for (const match of text.matchAll(pattern)) {
    const raw = match[0]
    const content = raw.trim()
    if (!content) continue
    const start = (match.index || 0) + raw.length - raw.trimStart().length
    const refs = extractSidRefs(content)
    if (content.includes('完整原句定位')) evidenceAppendix = true
    const scope = refs.length === 1 ? 'SENTENCE' : refs.length > 1 ? 'CROSS_SCOPE' : defaultScope
    const kind = evidenceAppendix
      ? 'EVIDENCE_QUOTE'
      : /矛盾|冲突|不一致|无法协调|相反/.test(content)
      ? 'CONTRADICTION'
      : /建议|应当|应该|可改|可以改|更适合|需要改|宜写|宜改/.test(content)
        ? 'RECOMMENDATION'
        : /展开|论证|解释|证明|因果|支撑/.test(content)
          ? 'DEVELOPMENT'
          : /问题|错误|不足|没有|未能|无法|不自然|不准确|过强|偏题/.test(content)
            ? 'PROBLEM'
            : 'JUDGEMENT'
    findings.push({
      ordinal: findings.length,
      scope,
      kind,
      content,
      feedbackStartOffset: start,
      feedbackEndOffset: start + content.length,
      evidenceSids: refs,
      confidence: refs.length ? 1 : 0.85,
      semanticStatus: 'DETERMINISTIC',
    })
  }
  return findings.length ? findings : [{
    ordinal: 0,
    scope: defaultScope,
    kind: 'JUDGEMENT',
    content: text,
    feedbackStartOffset: 0,
    feedbackEndOffset: text.length,
    evidenceSids: extractSidRefs(text),
    confidence: 0.8,
    semanticStatus: 'DETERMINISTIC',
  }]
}

function estimateTokens(text: string) {
  const english = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)?.length || 0
  const cjk = text.match(/[\u3400-\u9fff]/g)?.length || 0
  return Math.max(1, Math.ceil(english * 1.35 + cjk * 1.1))
}

function dimensionIssueType(dimension: Dimension) {
  return ({
    TR: 'TASK_RESPONSE',
    CC: 'COHESION',
    LR: 'VOCABULARY',
    GRA: 'GRAMMAR',
    OVERALL: 'STRUCTURE',
  } as const)[dimension]
}

function severityForAssessment(assessment: Assessment): AiIssueSeverity {
  const status = (assessment.status || '').toUpperCase()
  if (status.includes('OK') || status.includes('GOOD')) return AiIssueSeverity.LOW
  if (status.includes('SERIOUS') || status.includes('MAJOR') || status.includes('HIGH')) return AiIssueSeverity.HIGH
  return AiIssueSeverity.MEDIUM
}

function inferWordIssueType(feedback: string) {
  const grammar = /语法|单复数|时态|冠词|主谓|介词|词性|从句|拼写|标点|大写|小写|grammar|spelling|tense/i
  const vocabulary = /搭配|词汇|用词|这个词|换成|改成|表达|word choice|collocation/i
  const cohesion = /衔接|连贯|过渡|cohesion|transition/i
  const logic = /逻辑|因果|矛盾|不合理|logic/i
  const task = /题目|审题|偏题|没有回应|task response/i
  if (grammar.test(feedback)) return 'GRAMMAR'
  if (task.test(feedback)) return 'TASK_RESPONSE'
  if (logic.test(feedback)) return 'LOGIC'
  if (cohesion.test(feedback)) return 'COHESION'
  if (vocabulary.test(feedback)) return 'VOCABULARY'
  return 'STYLE'
}

function occurrence(haystack: string, needle: string, index: number) {
  if (!needle || index < 0) return null
  let count = 0
  let cursor = 0
  while (cursor <= haystack.length) {
    const found = haystack.indexOf(needle, cursor)
    if (found < 0) return null
    if (found === index) return count
    count += 1
    cursor = found + Math.max(needle.length, 1)
  }
  return null
}

function locateSubspan(document: ManifestDocument, sentence: Sentence, anchorText: string | null) {
  if (!anchorText) {
    return {
      anchorType: AnchorType.TEACHER_NOTE,
      anchorText: sentence.text,
      startOffset: sentence.startOffset,
      endOffset: sentence.endOffset,
      occurrence: null,
      locationStatus: AiAnnotationLocationStatus.UNRESOLVED,
    }
  }
  let relative = sentence.text.indexOf(anchorText)
  if (relative < 0) relative = sentence.text.toLowerCase().indexOf(anchorText.toLowerCase())
  if (relative < 0) {
    return {
      anchorType: AnchorType.SPAN,
      anchorText,
      startOffset: null,
      endOffset: null,
      occurrence: null,
      locationStatus: AiAnnotationLocationStatus.UNRESOLVED,
    }
  }
  const startOffset = sentence.startOffset + relative
  return {
    anchorType: AnchorType.SPAN,
    anchorText: document.essayText.slice(startOffset, startOffset + anchorText.length),
    startOffset,
    endOffset: startOffset + anchorText.length,
    occurrence: occurrence(document.essayText, anchorText, startOffset),
    locationStatus: AiAnnotationLocationStatus.RESOLVED,
  }
}

function textFromRecord(record: Record<string, unknown>) {
  return Object.entries(record)
    .filter(([key, value]) => !key.startsWith('__') && Boolean(value))
    .map(([key, value]) => `[${key}]\n${value}`)
    .join('\n\n')
}

function reviewChunk(scope: string, original: string, assessments: Assessment[], rewrites: Array<Rewrite | null> = []) {
  const sections = [
    `[范围]\n${scope}`,
    `[学生原文]\n${original}`,
    ...assessments.filter(item => item.feedback).map(item =>
      `[${item.dimension}${item.score != null ? ` ${item.score}` : ''}]\n${item.feedback}`,
    ),
    ...rewrites.filter((item): item is Rewrite => Boolean(item?.text)).map(item =>
      `[${item.source}改写 ${item.layers.join('+') || 'UNSPECIFIED'}]\n${item.text}${item.note ? `\n说明: ${item.note}` : ''}`,
    ),
  ]
  return sections.join('\n\n')
}

function sourceNotes(document: ManifestDocument, parserVersion: string, batchHash: string) {
  return [
    `manifest_document_key=${document.documentKey}`,
    `source_sha256=${document.fileHash}`,
    `parser_version=${parserVersion}`,
    `manifest_sha256=${batchHash}`,
    `split=${document.quality.split}`,
    `label_authority=${document.quality.labelAuthority}`,
    ...document.quality.warnings.map(warning => `warning=${warning}`),
  ].join(' | ')
}

async function importDocument(
  sourceId: number,
  questionId: number | null,
  document: ManifestDocument,
  parserVersion: string,
  batchHash: string,
) {
  return prisma.$transaction(async tx => {
    const existing = await tx.knowledgeDocument.findFirst({
      where: {
        sourceId,
        fileUrl: document.sourcePath,
        qualityNotes: { contains: `source_sha256=${document.fileHash}` },
      },
      select: { id: true },
    })
    if (existing) return {
      status: 'skipped' as const,
      documentId: existing.id,
      chunks: 0,
      annotations: 0,
      assessments: 0,
      findings: 0,
      evidenceRefs: 0,
      rewriteExamples: 0,
      sourceRecords: 0,
    }

    const created = await tx.knowledgeDocument.create({
      data: {
        sourceId,
        questionId,
        title: document.fileName,
        rawText: document.essayText,
        fileUrl: document.sourcePath,
        task: TaskType.TASK2,
        subtype: document.subtype,
        // topic is a short semantic label (VARCHAR), not the full IELTS prompt.
        // The complete prompt is preserved in the manifest and RAG chunks.
        topic: null,
        band: document.overallBand,
        contentRole: 'REVIEW_EXAMPLE',
        completenessStatus: document.quality.status === 'STRUCTURALLY_VALID' ? 'COMPLETE' : 'NEEDS_REVIEW',
        probableTask: TaskType.TASK2,
        allowedForRag: document.quality.allowedForRag,
        excludeFromEval: document.quality.excludeFromEval,
        qualityNotes: sourceNotes(document, parserVersion, batchHash),
      },
    })

    let chunks = 0
    let annotations = 0
    let assessments = 0
    let findings = 0
    let evidenceRefs = 0
    let rewriteExamples = 0
    let sourceRecords = 0
    const addChunk = async (chunkText: string, chunkType: KnowledgeChunkType, subtype?: string | null) => {
      const chunk = await tx.knowledgeChunk.create({
        data: {
          documentId: created.id,
          chunkText,
          chunkType,
          task: TaskType.TASK2,
          subtype: subtype ?? document.subtype,
          band: document.overallBand,
          tokenCount: estimateTokens(chunkText),
        },
      })
      chunks += 1
      return chunk
    }

    type UnitRecord = {
      id: number
      stableKey: string
      versionId: string | null
      text: string
      startOffset: number | null
      endOffset: number | null
      paragraphIndex: number | null
      sentenceIndex: number | null
    }

    const paragraphUnits = new Map<number, UnitRecord>()
    const sentenceUnits = new Map<number, UnitRecord>()
    const sentenceUnitsByKey = new Map<string, UnitRecord>()

    for (const paragraph of document.paragraphs) {
      if (!paragraph.text) continue
      const versionId = paragraph.versionIds?.length === 1 ? paragraph.versionIds[0] : null
      const unit = await tx.knowledgeTextUnit.create({
        data: {
          documentId: created.id,
          unitType: 'PARAGRAPH',
          stableKey: `p${paragraph.index + 1}`,
          versionId,
          ordinal: paragraph.index,
          paragraphIndex: paragraph.index,
          text: paragraph.text,
          startOffset: paragraph.startOffset,
          endOffset: paragraph.endOffset,
          sourceSheet: paragraph.source?.sheet || '段落四维评价',
          sourceRow: paragraph.source?.row,
        },
      })
      paragraphUnits.set(paragraph.index, unit)
    }

    for (const sentence of document.sentences) {
      const parent = sentence.paragraphIndex == null ? null : paragraphUnits.get(sentence.paragraphIndex)
      const unit = await tx.knowledgeTextUnit.create({
        data: {
          documentId: created.id,
          parentId: parent?.id,
          unitType: 'SENTENCE',
          stableKey: sentence.sid.toLowerCase(),
          versionId: sentence.versionId || 'default',
          ordinal: sentence.index,
          paragraphIndex: sentence.paragraphIndex,
          sentenceIndex: sentence.index,
          text: sentence.text,
          startOffset: sentence.startOffset,
          endOffset: sentence.endOffset,
          sourceSheet: sentence.source?.sheet || '句子',
          sourceRow: sentence.source?.row,
        },
      })
      sentenceUnits.set(sentence.index, unit)
      sentenceUnitsByKey.set(unit.stableKey.toLowerCase(), unit)
    }

    const resolveSentenceRef = (ref: string, contextVersion?: string | null) => {
      const normalized = ref.toLowerCase()
      const exact = sentenceUnitsByKey.get(normalized)
      if (exact) return exact
      let candidates = [...sentenceUnitsByKey.values()].filter(unit => unit.stableKey.endsWith(`-${normalized}`))
      if (!candidates.length) {
        const tail = normalized.match(/s\d{1,3}$/)?.[0]
        if (tail) candidates = [...sentenceUnitsByKey.values()].filter(unit => unit.stableKey.endsWith(tail))
      }
      if (contextVersion && contextVersion !== 'default') {
        const contextual = candidates.filter(unit => unit.versionId === contextVersion)
        if (contextual.length === 1) return contextual[0]
      }
      return candidates.length === 1 ? candidates[0] : null
    }

    const addSourceRecord = async (
      recordKey: string,
      source: SourceCell | { sheet: string; row: number | null; column: string | null } | null | undefined,
      recordType: string,
      rawJson: unknown,
    ) => {
      await tx.knowledgeSourceRecord.create({
        data: {
          documentId: created.id,
          sourceKey: recordKey,
          sheetName: source?.sheet || 'UNKNOWN',
          rowIndex: source?.row ?? null,
          recordType,
          rawJson: rawJson as Prisma.InputJsonValue,
          sourceHash: sha256(JSON.stringify(rawJson)),
        },
      })
      sourceRecords += 1
    }

    const addAssessment = async (input: {
      key: string
      kind: string
      scope: string
      dimension?: string | null
      score?: number | null
      status?: string | null
      tags?: string[]
      feedback: string
      assessmentFindings?: Finding[]
      source?: SourceCell | null
      sourceColumn?: string | null
      rawJson?: unknown
      chunkId?: number | null
      primaryUnit?: UnitRecord | null
      primaryQuote?: string | null
      primaryStartOffset?: number | null
      primaryEndOffset?: number | null
      contextVersion?: string | null
    }) => {
      const assessment = await tx.knowledgeAssessment.create({
        data: {
          documentId: created.id,
          chunkId: input.chunkId,
          primaryUnitId: input.primaryUnit?.id,
          sourceKey: input.key,
          kind: input.kind,
          scope: input.scope,
          dimension: input.dimension,
          score: input.score,
          status: input.status,
          tags: input.tags?.length ? input.tags : undefined,
          rawFeedback: input.feedback,
          sourceSheet: input.source?.sheet,
          sourceRow: input.source?.row,
          sourceColumn: input.sourceColumn || input.source?.column,
          rawJson: input.rawJson == null ? undefined : input.rawJson as Prisma.InputJsonValue,
        },
      })
      assessments += 1

      const atomic = input.assessmentFindings?.length
        ? input.assessmentFindings
        : splitFindings(input.feedback, input.scope)
      for (const item of atomic) {
        const resolved = item.evidenceSids
          .map(ref => ({ ref, unit: resolveSentenceRef(ref, input.contextVersion) }))
        const onlyResolved = resolved.filter(entry => entry.unit)
        const primaryUnit = item.scope === 'SENTENCE' && onlyResolved.length === 1
          ? onlyResolved[0].unit
          : input.primaryUnit
        const finding = await tx.knowledgeAssessmentFinding.create({
          data: {
            assessmentId: assessment.id,
            primaryUnitId: primaryUnit?.id,
            ordinal: item.ordinal,
            scope: item.scope,
            kind: item.kind,
            content: item.content,
            feedbackStartOffset: item.feedbackStartOffset,
            feedbackEndOffset: item.feedbackEndOffset,
            confidence: item.confidence,
            semanticStatus: item.semanticStatus,
          },
        })
        findings += 1

        if (primaryUnit) {
          const hasCustomLocation = primaryUnit.id === input.primaryUnit?.id && input.primaryQuote !== undefined
          const quote = hasCustomLocation ? input.primaryQuote : primaryUnit.text
          const startOffset = hasCustomLocation ? input.primaryStartOffset ?? null : primaryUnit.startOffset
          const endOffset = hasCustomLocation ? input.primaryEndOffset ?? null : primaryUnit.endOffset
          await tx.knowledgeAssessmentEvidence.create({
            data: {
              findingId: finding.id,
              unitId: primaryUnit.id,
              refKey: primaryUnit.stableKey,
              role: 'PRIMARY_TARGET',
              quotedText: quote,
              startOffset,
              endOffset,
              locationStatus: startOffset != null && endOffset != null
                ? AiAnnotationLocationStatus.RESOLVED
                : AiAnnotationLocationStatus.UNRESOLVED,
              confidence: 1,
            },
          })
          evidenceRefs += 1
        }

        for (const entry of resolved) {
          if (entry.unit?.id === primaryUnit?.id) continue
          await tx.knowledgeAssessmentEvidence.create({
            data: {
              findingId: finding.id,
              unitId: entry.unit?.id,
              refKey: entry.ref,
              role: item.kind === 'CONTRADICTION' ? 'CONTRAST' : 'SUPPORTING_EVIDENCE',
              quotedText: entry.unit?.text,
              startOffset: entry.unit?.startOffset,
              endOffset: entry.unit?.endOffset,
              locationStatus: entry.unit
                ? AiAnnotationLocationStatus.RESOLVED
                : AiAnnotationLocationStatus.UNRESOLVED,
              confidence: entry.unit ? 1 : 0,
            },
          })
          evidenceRefs += 1
        }
      }

      if (input.source) {
        await addSourceRecord(
          `assessment-${input.key}`,
          input.source,
          `ASSESSMENT_${input.kind}`,
          input.rawJson ?? { feedback: input.feedback, dimension: input.dimension },
        )
      }
      return assessment
    }

    for (const paragraph of document.paragraphs) {
      if (!paragraph.source) continue
      await addSourceRecord(
        sourceKey('paragraph-text', document.documentKey, paragraph.index, paragraph.source.row),
        paragraph.source,
        'PARAGRAPH_TEXT',
        {
          index: paragraph.index,
          label: paragraph.label,
          text: paragraph.text,
          startOffset: paragraph.startOffset,
          endOffset: paragraph.endOffset,
        },
      )
    }
    for (const sentence of document.sentences) {
      if (!sentence.source) continue
      await addSourceRecord(
        sourceKey('sentence-text', document.documentKey, sentence.sid, sentence.source.row),
        sentence.source,
        'SENTENCE_TEXT',
        {
          sid: sentence.sid,
          versionId: sentence.versionId,
          paragraphIndex: sentence.paragraphIndex,
          text: sentence.text,
          startOffset: sentence.startOffset,
          endOffset: sentence.endOffset,
        },
      )
    }

    for (const paragraph of document.paragraphs) {
      if (!paragraph.text) continue
      await addChunk(`[题目]\n${document.questionText || ''}\n\n[学生段落 ${paragraph.index + 1}]\n${paragraph.text}`, KnowledgeChunkType.ESSAY_PARAGRAPH)
    }

    const globalText = reviewChunk('全文', document.essayText, document.globalAssessments)
    const globalChunk = await addChunk(globalText, KnowledgeChunkType.REVIEW_EXAMPLE)
    for (const assessment of document.globalAssessments) {
      if (!assessment.feedback) continue
      const assessmentKey = sourceKey('global', document.documentKey, assessment.dimension, assessment.source?.row)
      await tx.knowledgeAnnotation.create({
        data: {
          documentId: created.id,
          chunkId: globalChunk.id,
          commentId: `xe2-${sha256(`${document.documentKey}|global|${assessment.dimension}|${assessment.feedback}`).slice(0, 20)}`,
          anchorType: AnchorType.TEACHER_NOTE,
          sourceRef: assessment.evidenceSids?.join(',') || null,
          issueType: dimensionIssueType(assessment.dimension),
          severity: severityForAssessment(assessment),
          teacherFeedback: assessment.feedback,
          locationStatus: AiAnnotationLocationStatus.UNRESOLVED,
        },
      })
      annotations += 1
      await addAssessment({
        key: assessmentKey,
        kind: 'ASSESSMENT',
        scope: 'ESSAY',
        dimension: assessment.dimension,
        score: assessment.score,
        status: assessment.status,
        tags: assessment.tags,
        feedback: assessment.feedback,
        assessmentFindings: assessment.findings,
        source: assessment.source,
        rawJson: assessment,
        chunkId: globalChunk.id,
      })
    }

    for (const paragraph of document.paragraphs) {
      const paragraphAssessments = paragraph.dimensions.filter(item => item.feedback)
      if (!paragraph.text || !paragraphAssessments.length) continue
      const chunk = await addChunk(reviewChunk(`段落 ${paragraph.index + 1}: ${paragraph.label || ''}`, paragraph.text, paragraphAssessments), KnowledgeChunkType.REVIEW_EXAMPLE)
      for (const assessment of paragraphAssessments) {
        const primaryUnit = paragraphUnits.get(paragraph.index)
        const assessmentKey = sourceKey(
          'paragraph',
          document.documentKey,
          paragraph.index,
          assessment.dimension,
          assessment.source?.row,
        )
        await tx.knowledgeAnnotation.create({
          data: {
            documentId: created.id,
            chunkId: chunk.id,
            commentId: `xe2-${sha256(`${document.documentKey}|p${paragraph.index}|${assessment.dimension}|${assessment.feedback}`).slice(0, 20)}`,
            paragraphIndex: paragraph.index,
            anchorType: AnchorType.SPAN,
            anchorText: paragraph.text,
            startOffset: paragraph.startOffset,
            endOffset: paragraph.endOffset,
            occurrence: occurrence(document.essayText, paragraph.text, paragraph.startOffset),
            sourceRef: assessment.evidenceSids?.join(',') || null,
            issueType: dimensionIssueType(assessment.dimension),
            severity: severityForAssessment(assessment),
            teacherFeedback: assessment.feedback,
            locationStatus: AiAnnotationLocationStatus.RESOLVED,
          },
        })
        annotations += 1
        await addAssessment({
          key: assessmentKey,
          kind: 'ASSESSMENT',
          scope: 'PARAGRAPH',
          dimension: assessment.dimension,
          score: assessment.score,
          status: assessment.status,
          tags: assessment.tags,
          feedback: assessment.feedback!,
          assessmentFindings: assessment.findings,
          source: assessment.source,
          rawJson: { paragraph: paragraph.label, assessment },
          chunkId: chunk.id,
          primaryUnit,
          contextVersion: primaryUnit?.versionId,
        })
      }
    }

    for (const sentence of document.sentences) {
      const chunk = await addChunk(
        reviewChunk(
          `句子 ${sentence.sid}`,
          sentence.text,
          sentence.dimensions,
          [sentence.aiRewrite, sentence.teacherRewrite],
        ),
        KnowledgeChunkType.REVIEW_EXAMPLE,
      )
      const replacementText = sentence.teacherRewrite?.text || sentence.aiRewrite?.text || null
      const primaryUnit = sentenceUnits.get(sentence.index)
      for (const assessment of sentence.dimensions) {
        if (!assessment.feedback) continue
        const assessmentKey = sourceKey(
          'sentence',
          document.documentKey,
          sentence.sid,
          assessment.dimension,
          assessment.source?.row,
        )
        await tx.knowledgeAnnotation.create({
          data: {
            documentId: created.id,
            chunkId: chunk.id,
            commentId: `xe2-${sha256(`${document.documentKey}|${sentence.sid}|${assessment.dimension}|${assessment.feedback}`).slice(0, 20)}`,
            paragraphIndex: sentence.paragraphIndex,
            sentenceIndex: sentence.index,
            anchorType: AnchorType.SPAN,
            anchorText: sentence.text,
            startOffset: sentence.startOffset,
            endOffset: sentence.endOffset,
            occurrence: occurrence(document.essayText, sentence.text, sentence.startOffset),
            sourceRef: `${document.documentKey}:${sentence.sid}`,
            issueType: dimensionIssueType(assessment.dimension),
            issueSubtype: assessment.tags?.join(',') || null,
            severity: severityForAssessment(assessment),
            teacherFeedback: assessment.feedback,
            replacementText,
            locationStatus: AiAnnotationLocationStatus.RESOLVED,
          },
        })
        annotations += 1
        await addAssessment({
          key: assessmentKey,
          kind: 'ASSESSMENT',
          scope: 'SENTENCE',
          dimension: assessment.dimension,
          score: assessment.score,
          status: assessment.status,
          tags: assessment.tags,
          feedback: assessment.feedback,
          assessmentFindings: assessment.findings,
          source: assessment.source,
          rawJson: assessment,
          chunkId: chunk.id,
          primaryUnit,
          contextVersion: sentence.versionId,
        })
      }
      for (const word of sentence.wordAnnotations) {
        const location = locateSubspan(document, sentence, word.anchorText)
        const assessmentKey = sourceKey(
          'word',
          document.documentKey,
          sentence.sid,
          word.index,
          word.source?.row,
        )
        await tx.knowledgeAnnotation.create({
          data: {
            documentId: created.id,
            chunkId: chunk.id,
            commentId: `xe2-${sha256(`${document.documentKey}|${sentence.sid}|word${word.index}|${word.feedback}`).slice(0, 20)}`,
            paragraphIndex: sentence.paragraphIndex,
            sentenceIndex: sentence.index,
            ...location,
            sourceRef: `${document.documentKey}:${sentence.sid}:word${word.index}`,
            issueType: inferWordIssueType(word.feedback),
            severity: AiIssueSeverity.MEDIUM,
            teacherFeedback: word.feedback,
          },
        })
        annotations += 1
        await addAssessment({
          key: assessmentKey,
          kind: 'WORD_ANNOTATION',
          scope: word.anchorText ? 'SPAN' : 'SENTENCE',
          feedback: word.feedback,
          assessmentFindings: word.findings,
          source: word.source,
          rawJson: word,
          chunkId: chunk.id,
          primaryUnit,
          primaryQuote: location.anchorText,
          primaryStartOffset: location.startOffset,
          primaryEndOffset: location.endOffset,
          contextVersion: sentence.versionId,
        })
      }

      for (const rewrite of [sentence.aiRewrite, sentence.teacherRewrite]) {
        if (!rewrite?.text || !primaryUnit) continue
        const rewriteKey = sourceKey(
          'rewrite',
          document.documentKey,
          sentence.sid,
          rewrite.source,
          rewrite.provenance?.row,
        )
        await tx.knowledgeRewriteExample.create({
          data: {
            documentId: created.id,
            sourceUnitId: primaryUnit.id,
            sourceKey: rewriteKey,
            scope: 'SENTENCE',
            sourceType: rewrite.source,
            layers: rewrite.layers,
            originalText: sentence.text,
            rewrittenText: rewrite.text,
            reason: rewrite.note,
            sourceRefs: [sentence.sid],
            sourceSheet: rewrite.provenance?.sheet,
            sourceRow: rewrite.provenance?.row,
            sourceColumn: rewrite.provenance?.column,
            rawText: rewrite.raw,
            allowedForRag: document.quality.allowedForRag,
          },
        })
        rewriteExamples += 1
        if (rewrite.provenance) {
          await addSourceRecord(
            `rewrite-${rewriteKey}`,
            rewrite.provenance,
            `REWRITE_${rewrite.source}`,
            rewrite,
          )
        }
      }
    }

    for (const [label, records, chunkType, defaultScope, defaultKind] of [
      ['全文补充', document.globalOther, KnowledgeChunkType.ERROR_EXPLANATION, 'ESSAY', 'ASSESSMENT'],
      ['段落看法', document.opinions, KnowledgeChunkType.ERROR_EXPLANATION, 'PARAGRAPH', 'ASSESSMENT'],
      ['Teaching note', document.teachingNotes, KnowledgeChunkType.ERROR_EXPLANATION, 'QUESTION', 'TEACHING_NOTE'],
      ['段级 Expansion', document.expansions, KnowledgeChunkType.ERROR_EXPLANATION, 'PARAGRAPH', 'EXPANSION'],
      ['MODEL 为什么好', document.modelAnalysis, KnowledgeChunkType.TEMPLATE, 'ESSAY', 'MODEL_ANALYSIS'],
    ] as const) {
      for (const [recordIndex, record] of records.entries()) {
        const body = textFromRecord(record)
        if (!body) continue
        const chunk = await addChunk(`[${label}]\n${body}`, chunkType)
        const refs = extractSidRefs(body)
        const resolved = refs.map(ref => resolveSentenceRef(ref)).filter((unit): unit is UnitRecord => Boolean(unit))
        const paragraphIndexes = [...new Set(resolved.map(unit => unit.paragraphIndex).filter(index => index != null))]
        let scope = defaultScope
        let primaryUnit: UnitRecord | null = null
        if (defaultScope === 'PARAGRAPH' && paragraphIndexes.length === 1) {
          primaryUnit = paragraphUnits.get(paragraphIndexes[0]!) || null
        } else if (defaultScope === 'QUESTION' && resolved.length === 1) {
          scope = 'SENTENCE'
          primaryUnit = resolved[0]
        } else if (resolved.length > 1) {
          scope = 'CROSS_SCOPE'
        }
        const alternative = /另一种|其他思路|换一种|全文思路|推荐思路|提纲/.test(body)
        const kind = alternative ? 'ALTERNATIVE_APPROACH' : defaultKind
        const recordSource = sourceFromRecord(record, label)
        await addAssessment({
          key: sourceKey('ancillary', document.documentKey, label, recordSource.row, recordIndex),
          kind,
          scope,
          feedback: body,
          assessmentFindings: splitFindings(body, scope),
          source: recordSource.row == null ? null : {
            sheet: recordSource.sheet,
            row: recordSource.row,
            column: recordSource.column || 'ROW',
          },
          rawJson: rawRecord(record),
          chunkId: chunk.id,
          primaryUnit,
          contextVersion: primaryUnit?.versionId,
        })
      }
    }

    for (const [rowIndex, row] of document.modelEssay.rows.entries()) {
      const body = textFromRecord(row)
      if (body && document.modelEssay.status === 'COMPLETE') {
        await addChunk(`[MODEL 范文]\n${body}`, KnowledgeChunkType.TEMPLATE)
      }
      if (body) {
        const recordSource = sourceFromRecord(row, 'MODEL范文')
        await addSourceRecord(
          sourceKey('model-row', document.documentKey, recordSource.row, rowIndex),
          recordSource,
          'MODEL_ESSAY_ROW',
          rawRecord(row),
        )
      }
    }

    return {
      status: 'created' as const,
      documentId: created.id,
      chunks,
      annotations,
      assessments,
      findings,
      evidenceRefs,
      rewriteExamples,
      sourceRecords,
    }
  }, { timeout: 180_000 })
}

async function main() {
  const manifestPath = path.resolve(argValue('--manifest', DEFAULT_MANIFEST))
  const sourceTitle = argValue('--source-title', DEFAULT_SOURCE_TITLE)
  const limit = argLimit()
  const rawManifest = await fs.readFile(manifestPath)
  const manifest = JSON.parse(rawManifest.toString('utf8')) as Manifest
  const documents = limit ? manifest.documents.slice(0, limit) : manifest.documents

  const projections = documents.reduce((totals, document) => {
    totals.documents += 1
    totals.paragraphChunks += document.paragraphs.filter(item => item.text).length
    totals.reviewChunks += 1 + document.paragraphs.filter(item => item.text && item.dimensions.some(d => d.feedback)).length + document.sentences.length
    totals.ancillaryChunks += document.opinions.filter(item => textFromRecord(item)).length
    totals.ancillaryChunks += document.globalOther.filter(item => textFromRecord(item)).length
    totals.ancillaryChunks += document.teachingNotes.filter(item => textFromRecord(item)).length
    totals.ancillaryChunks += document.expansions.filter(item => textFromRecord(item)).length
    totals.ancillaryChunks += document.modelAnalysis.filter(item => textFromRecord(item)).length
    if (document.modelEssay.status === 'COMPLETE') {
      totals.ancillaryChunks += document.modelEssay.rows.filter(item => textFromRecord(item)).length
    }
    totals.annotations += document.globalAssessments.filter(item => item.feedback).length
    totals.annotations += document.paragraphs.reduce(
      (sum, item) => sum + (item.text ? item.dimensions.filter(d => d.feedback).length : 0),
      0,
    )
    totals.annotations += document.sentences.reduce((sum, item) => sum + item.dimensions.filter(d => d.feedback).length + item.wordAnnotations.length, 0)
    totals.assessments += document.globalAssessments.filter(item => item.feedback).length
    totals.assessments += document.paragraphs.reduce(
      (sum, item) => sum + (item.text ? item.dimensions.filter(d => d.feedback).length : 0),
      0,
    )
    totals.assessments += document.sentences.reduce(
      (sum, item) => sum + item.dimensions.filter(d => d.feedback).length + item.wordAnnotations.length,
      0,
    )
    totals.assessments += document.globalOther.filter(item => textFromRecord(item)).length
    totals.assessments += document.opinions.filter(item => textFromRecord(item)).length
    totals.assessments += document.teachingNotes.filter(item => textFromRecord(item)).length
    totals.assessments += document.expansions.filter(item => textFromRecord(item)).length
    totals.assessments += document.modelAnalysis.filter(item => textFromRecord(item)).length
    totals.textUnits += document.paragraphs.filter(item => item.text).length + document.sentences.length
    totals.rewriteExamples += document.sentences.reduce(
      (sum, item) => sum + Number(Boolean(item.aiRewrite?.text)) + Number(Boolean(item.teacherRewrite?.text)),
      0,
    )
    totals.quarantined += document.quality.status === 'NEEDS_REVIEW' ? 1 : 0
    totals.holdout += document.quality.split === 'holdout' ? 1 : 0
    totals.totalChunks = totals.paragraphChunks + totals.reviewChunks + totals.ancillaryChunks
    return totals
  }, {
    documents: 0,
    paragraphChunks: 0,
    reviewChunks: 0,
    ancillaryChunks: 0,
    totalChunks: 0,
    annotations: 0,
    assessments: 0,
    textUnits: 0,
    rewriteExamples: 0,
    quarantined: 0,
    holdout: 0,
  })

  console.log(JSON.stringify({
    mode: WRITE_MODE ? 'WRITE' : 'DRY_RUN',
    manifestPath,
    manifestSchema: manifest.schemaVersion,
    parserVersion: manifest.parserVersion,
    sourceTitle,
    sourceErrors: manifest.errors.length,
    projections,
    policy: {
      destructiveCleanup: false,
      needsReviewImportedButRagDisabled: true,
      holdoutImportedButRagDisabled: true,
      idempotency: 'sourcePath + source_sha256',
    },
  }, null, 2))

  if (!WRITE_MODE) return
  if (manifest.errors.length) throw new Error(`Manifest has ${manifest.errors.length} extraction errors`)

  const batchHash = sha256(rawManifest)
  const source = await prisma.knowledgeSource.findFirst({
    where: { title: sourceTitle, sourceType: KnowledgeSourceType.TEACHER_REVIEW },
  }) || await prisma.knowledgeSource.create({
    data: {
      sourceType: KnowledgeSourceType.TEACHER_REVIEW,
      title: sourceTitle,
      owner: 'IELTS Task 2 Excel experiment',
      visibility: KnowledgeVisibility.PRIVATE,
    },
  })
  const batch = await prisma.importBatch.create({
    data: {
      label: `rag-excel-task2-${new Date().toISOString().slice(0, 10)}`,
      sourceFileHash: batchHash,
      parserVersion: manifest.parserVersion,
      cleaningVersion: manifest.schemaVersion,
      notes: JSON.stringify({ sourceTitle, manifestPath, projections }),
    },
  })
  activeBatchId = batch.id

  const canonicalQuestions = new Map<string, number>()
  for (const question of await prisma.question.findMany({
    where: { task: TaskType.TASK2 },
    select: { id: true, content: true },
  })) {
    const normalized = normalizeQuestion(question.content)
    if (!canonicalQuestions.has(normalized)) canonicalQuestions.set(normalized, question.id)
  }

  let createdCanonicalQuestions = 0
  const ensureCanonicalQuestion = async (document: ManifestDocument) => {
    if (!document.questionText) return null
    const normalized = normalizeQuestion(document.questionText)
    const existingId = canonicalQuestions.get(normalized)
    if (existingId) return existingId
    const question = await prisma.question.create({
      data: {
        task: TaskType.TASK2,
        subtype: document.subtype,
        content: document.questionText,
        source: 'EXPERIMENT_EXCEL',
        sourceKey: `experiment-excel:${sha256(normalized).slice(0, 32)}`,
      },
      select: { id: true },
    })
    canonicalQuestions.set(normalized, question.id)
    createdCanonicalQuestions += 1
    return question.id
  }

  let created = 0
  let skipped = 0
  let chunks = 0
  let annotations = 0
  let assessments = 0
  let findings = 0
  let evidenceRefs = 0
  let rewriteExamples = 0
  let sourceRecords = 0
  for (const [index, document] of documents.entries()) {
    const questionId = await ensureCanonicalQuestion(document)
    const result = await importDocument(source.id, questionId, document, manifest.parserVersion, batchHash)
    if (result.status === 'created') created += 1
    else skipped += 1
    chunks += result.chunks
    annotations += result.annotations
    assessments += result.assessments
    findings += result.findings
    evidenceRefs += result.evidenceRefs
    rewriteExamples += result.rewriteExamples
    sourceRecords += result.sourceRecords
    if ((index + 1) % 10 === 0 || index === documents.length - 1) {
      console.log(`Processed ${index + 1}/${documents.length}`)
    }
  }
  await prisma.importBatch.update({
    where: { id: batch.id },
    data: { importedCount: created, isActive: created > 0 },
  })
  activeBatchId = null
  console.log(JSON.stringify({
    batchId: batch.id,
    sourceId: source.id,
    created,
    skipped,
    createdCanonicalQuestions,
    chunks,
    annotations,
    assessments,
    findings,
    evidenceRefs,
    rewriteExamples,
    sourceRecords,
  }, null, 2))
}

main()
  .catch(async error => {
    if (WRITE_MODE && activeBatchId != null) {
      await prisma.importBatch.update({ where: { id: activeBatchId }, data: { isActive: false } }).catch(() => undefined)
    }
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (WRITE_MODE) await prisma.$disconnect()
  })
