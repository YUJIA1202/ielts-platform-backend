/**
 * Read-only source quality reconciliation — dry-run
 *
 * §A  File classification with human overrides (ran/may/joan/大作文作业2 z)
 * §B  973-comment annotation gap re-classification
 * §C  Unannotated student draft DROP candidates
 * §D  30% stratified review pool statistics
 * §E  20 human confirmation samples
 *
 * NO WRITES — never touches any DB table or file.
 */

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import prisma from '../src/prisma'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ManifestComment {
  commentId: string
  paragraphIndex: number
  anchorText: string
  feedback: string
}

interface ManifestDoc {
  collection: string
  fileName: string
  sourcePath: string
  task: string | null
  rawText: string
  paragraphs: string[]
  comments: ManifestComment[]
  stats: { characters: number; paragraphs: number; comments: number }
}

interface DocxInspect {
  docxCommentCount: number
  totalTextRuns: number
  blueRuns: number
  coloredRuns: number
  highlightRuns: number
  colorValues: Record<string, number>
  blueExamples: string[]
  error?: string
}

type ReviewPriority = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
type SemanticRole =
  | 'ERROR_FEEDBACK' | 'REWRITE_SUGGESTION' | 'TEACHER_REWRITE' | 'MODEL_TEXT'
  | 'TEACHING_NOTE' | 'EXAMPLE_EXTENSION' | 'STRUCTURE_COMMENT' | 'GLOBAL_FEEDBACK' | 'UNKNOWN'
type TargetRole =
  | 'STUDENT_ESSAY' | 'MODEL_ESSAY' | 'TEACHER_REWRITE' | 'PROMPT'
  | 'PARAGRAPH_SAMPLE' | 'WHOLE_DOCUMENT' | 'UNKNOWN'
type SourceLayer =
  | 'WORD_COMMENT' | 'CHUNKTEXT_PARSED' | 'INLINE_COLORED_TEXT' | 'INLINE_BLUE_TEXT'
  | 'INLINE_BLACK_TEXT' | 'APPENDED_NOTE' | 'GLOBAL_NOTE' | 'UNKNOWN_SOURCE'
type DropCategory = 'DROP_HIGH_CONFIDENCE' | 'DROP_MEDIUM_CONFIDENCE' | 'DO_NOT_DROP'

interface ManualOverride {
  inferredRole: string
  manualOverrideRole: string
  doNotDrop: boolean
  doNotQuarantine: boolean
  excludeFromDropCandidate: boolean
  excludeFromEvalCandidate: boolean
  allowedForRagCandidate: boolean
  suitableForRawAnnotationSignal: boolean
  possibleAutoEligible: boolean
  contentValue: 'HIGH' | 'MEDIUM' | 'LOW'
  targetRoleHint: TargetRole
  semanticRoleHints: SemanticRole[]
  reviewPriority: ReviewPriority
  notes: string
}

interface DropCandidate {
  documentId: number
  title: string
  sourceType: string
  fileUrl: string
  task: string | null
  rawTextLength: number
  manifestCommentCount: number
  docxCommentCount: number
  coloredRunCount: number
  blueRunCount: number
  highlightCount: number
  chunkCount: number
  annotationCount: number
  embeddingCount: number
  matchesAssignmentPattern: boolean
  hasTeacherSignal: boolean
  isManualOverride: boolean
  dropConfidence: 'HIGH' | 'MEDIUM' | 'NONE'
  dropCategory: DropCategory
  reasons: string[]
  riskNote: string
  confirmQuestions: string[]
  excludeFromRag: boolean
  excludeFromEval: boolean
  moveToQuarantine: boolean
  hardDeleteCandidate: boolean
}

interface SignalClassification {
  sourceLayer: SourceLayer
  semanticRole: SemanticRole
  targetRole: TargetRole
  confidence: number
  reviewPriority: ReviewPriority
  needsManualReview: boolean
  autoEligible: boolean
  sampledForReview: boolean
  betterForRawSignal: boolean
  highRiskReasons: string[]
}

interface GapSignal {
  fileName: string
  collection: string
  sourceType: string
  originalCommentId: string
  anchorText: string
  feedbackSnippet: string
  gapType: 'TYPE_A_MODEL_ESSAY' | 'TYPE_B_IMPORT_FILTER' | 'TYPE_C_MIGRATE_INCOMPLETE' | 'COVERED'
  overrideApplied: boolean
  overrideNote: string
  classification: SignalClassification
}

// ─────────────────────────────────────────────────────────────────────────────
// Human override registry (人工确认结果)
// ─────────────────────────────────────────────────────────────────────────────

const MANUAL_OVERRIDES: Record<string, ManualOverride> = {
  'ran 双边.docx': {
    inferredRole: 'TEACHING_MATERIAL',
    manualOverrideRole: 'TEACHING_NOTE',
    doNotDrop: true,
    doNotQuarantine: true,
    excludeFromDropCandidate: true,
    excludeFromEvalCandidate: true,
    allowedForRagCandidate: false,
    suitableForRawAnnotationSignal: true,
    possibleAutoEligible: false,
    contentValue: 'MEDIUM',
    targetRoleHint: 'UNKNOWN',
    semanticRoleHints: ['TEACHING_NOTE', 'EXAMPLE_EXTENSION', 'STRUCTURE_COMMENT'],
    reviewPriority: 'HIGH',
    notes: '人工确认：教学用材料。targetRole不默认STUDENT_ESSAY。不转KnowledgeAnnotation。',
  },
  'may 程度同意2.docx': {
    inferredRole: 'TEACHING_MATERIAL',
    manualOverrideRole: 'TEACHING_NOTE',
    doNotDrop: true,
    doNotQuarantine: true,
    excludeFromDropCandidate: true,
    excludeFromEvalCandidate: true,
    allowedForRagCandidate: false,
    suitableForRawAnnotationSignal: true,
    possibleAutoEligible: false,
    contentValue: 'MEDIUM',
    targetRoleHint: 'UNKNOWN',
    semanticRoleHints: ['TEACHING_NOTE', 'EXAMPLE_EXTENSION'],
    reviewPriority: 'HIGH',
    notes: '人工确认：教学用材料。不默认转学生错误批注。更适合RawAnnotationSignal。',
  },
  'joan 拓展2.docx': {
    inferredRole: 'TEACHING_MATERIAL',
    manualOverrideRole: 'EXAMPLE_EXTENSION',
    doNotDrop: true,
    doNotQuarantine: true,
    excludeFromDropCandidate: true,
    excludeFromEvalCandidate: true,
    allowedForRagCandidate: false,
    suitableForRawAnnotationSignal: true,
    possibleAutoEligible: false,
    contentValue: 'MEDIUM',
    targetRoleHint: 'UNKNOWN',
    semanticRoleHints: ['TEACHING_NOTE', 'EXAMPLE_EXTENSION'],
    reviewPriority: 'HIGH',
    notes: '人工确认：教学用材料。标为TEACHING_NOTE/EXAMPLE_EXTENSION候选。不转KnowledgeAnnotation。',
  },
  '大作文作业2 z.docx': {
    inferredRole: 'HIGH_VALUE_STUDENT_REVIEW',
    manualOverrideRole: 'HIGH_VALUE_STUDENT_REVIEW',
    doNotDrop: true,
    doNotQuarantine: true,
    excludeFromDropCandidate: true,
    excludeFromEvalCandidate: true,
    allowedForRagCandidate: true,
    suitableForRawAnnotationSignal: true,
    possibleAutoEligible: true,
    contentValue: 'HIGH',
    targetRoleHint: 'STUDENT_ESSAY',
    semanticRoleHints: ['ERROR_FEEDBACK', 'REWRITE_SUGGESTION'],
    reviewPriority: 'HIGH',
    notes: '人工确认：高价值学生批改材料。文件名含"作业"但有大量批注改写。DO_NOT_DROP。possibleAutoEligible仅限高置信有anchor的student评论。',
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Python DOCX inspector (counts comments, colored/blue/highlight runs)
// ─────────────────────────────────────────────────────────────────────────────

const PYTHON_INSPECTOR = `
import sys, json
sys.stdout.reconfigure(encoding='utf-8')
from zipfile import ZipFile, BadZipFile
from xml.etree import ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WN = "{" + W + "}"
BLUE = {
    "0000ff","0070c0","4472c4","2e74b5","4f81bd",
    "1f497d","17375e","1f3864","003366","0563c1",
    "215868","1665c0","2f5496","003087",
}

result = {
    "docxCommentCount": 0,
    "totalTextRuns": 0,
    "blueRuns": 0,
    "coloredRuns": 0,
    "highlightRuns": 0,
    "colorValues": {},
    "blueExamples": [],
}

try:
    with ZipFile(sys.argv[1]) as z:
        names = z.namelist()
        if "word/document.xml" not in names:
            result["error"] = "no_document_xml"
        else:
            doc = ET.fromstring(z.read("word/document.xml"))
            if "word/comments.xml" in names:
                cmts = ET.fromstring(z.read("word/comments.xml"))
                result["docxCommentCount"] = len(cmts.findall(f".//{WN}comment"))
            for run in doc.findall(f".//{WN}r"):
                text = "".join(t.text or "" for t in run.findall(f"{WN}t")).strip()
                if not text:
                    continue
                result["totalTextRuns"] += 1
                rpr = run.find(f"{WN}rPr")
                if rpr is None:
                    continue
                hl = rpr.find(f"{WN}highlight")
                if hl is not None:
                    result["highlightRuns"] += 1
                cel = rpr.find(f"{WN}color")
                if cel is None:
                    continue
                val = (cel.get(f"{WN}val") or "").strip().lower().lstrip("#")
                if not val or val == "auto":
                    continue
                result["coloredRuns"] += 1
                result["colorValues"][val] = result["colorValues"].get(val, 0) + 1
                if val in BLUE:
                    result["blueRuns"] += 1
                    if len(result["blueExamples"]) < 3:
                        result["blueExamples"].append(text[:80])
except BadZipFile:
    result["error"] = "bad_zip"
except Exception as e:
    result["error"] = str(e)[:150]

print(json.dumps(result, ensure_ascii=False))
`

function writePythonHelper(): string {
  const p = path.join(os.tmpdir(), 'ielts_quality_inspector_v6.py')
  fs.writeFileSync(p, PYTHON_INSPECTOR, 'utf8')
  return p
}

function inspectDocx(pyFile: string, docxPath: string): DocxInspect {
  try {
    const out = execFileSync('python', [pyFile, docxPath], { encoding: 'utf8', timeout: 15_000 })
    const r = JSON.parse(out.trim()) as DocxInspect
    r.coloredRuns ??= 0
    r.highlightRuns ??= 0
    return r
  } catch {
    return { docxCommentCount: 0, totalTextRuns: 0, blueRuns: 0, coloredRuns: 0, highlightRuns: 0, colorValues: {}, blueExamples: [], error: 'inspect_failed' }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Patterns & keyword banks
// ─────────────────────────────────────────────────────────────────────────────

const HIGH_FILE_PATTERN = /我写的|范文|改写|拓展|补充|思路|资料|参考|讲义/
const ASSIGNMENT_PATTERN = /大作文作业|小作文作业|作业|\d{1,2}[.月\-]\d{1,2}[日号]?\s*(大作文|小作文)/
const TEACHER_SIGNAL_KW = ['建议','改成','表达','逻辑','结构','语法','词汇','这里','这个','重写','注意',
  '错误','修改','标注','改正','替换','换成','不对','有问题','点评','批改','评语','总结','加上','删掉']

const GRAMMAR_KW = ['语法','时态','单复数','冠词','介词','拼写','标点','主谓','从句','grammar','spelling','tense']
const VOCAB_KW = ['换成','替换','改成','可以用','词汇','用词','搭配','短语','word choice','replace']
const LOGIC_KW = ['逻辑','矛盾','前后','因果','inconsistent','logical']
const COHESION_KW = ['衔接','连接','过渡','transition','连贯','cohesion']
const STRUCTURE_KW = ['结构','段落','开头','结尾','布局','structure','paragraph']
const TASK_KW = ['题目','要求','任务','偏题','审题','task response']
const STYLE_KW = ['口语','正式','文体','informal','formal','删','省']
const MODEL_KW = ['范文','我写的','改写后','修改版']
const TEACHING_KW = ['思路','举一反三','方法','讲解','规则','语法点']
const EXTEND_KW = ['拓展','补充','参考','更多版本','变体','另一种写法']
const GLOBAL_FB_KW = ['整体','总结','总体来说','整篇','综合','overall','in general','to summarize']

function kwMatch(text: string, kws: string[]): boolean {
  return kws.some(k => text.toLowerCase().includes(k))
}

function clip(s: string, n: number): string {
  const c = (s ?? '').replace(/\n/g, ' ').trim()
  return c.length > n ? c.slice(0, n) + '…' : c
}

// ─────────────────────────────────────────────────────────────────────────────
// Semantic / target role estimation
// ─────────────────────────────────────────────────────────────────────────────

function estimateSemanticRole(feedback: string, _anchor: string, fileName: string): SemanticRole {
  if (kwMatch(fileName, MODEL_KW) || kwMatch(feedback, MODEL_KW)) return 'MODEL_TEXT'
  if (kwMatch(feedback, TEACHING_KW)) return 'TEACHING_NOTE'
  if (kwMatch(feedback, EXTEND_KW))   return 'EXAMPLE_EXTENSION'
  if (kwMatch(feedback, GLOBAL_FB_KW)) return 'GLOBAL_FEEDBACK'
  if (kwMatch(feedback, GRAMMAR_KW))  return 'ERROR_FEEDBACK'
  if (kwMatch(feedback, LOGIC_KW))    return 'ERROR_FEEDBACK'
  if (kwMatch(feedback, TASK_KW))     return 'ERROR_FEEDBACK'
  if (kwMatch(feedback, STRUCTURE_KW)) return 'STRUCTURE_COMMENT'
  if (kwMatch(feedback, COHESION_KW)) return 'STRUCTURE_COMMENT'
  if (kwMatch(feedback, VOCAB_KW) || kwMatch(feedback, STYLE_KW)) return 'REWRITE_SUGGESTION'
  return 'UNKNOWN'
}

function estimateTargetRole(
  collection: string,
  fileName: string,
  override: ManualOverride | undefined,
): TargetRole {
  if (override) return override.targetRoleHint
  // MODEL_ESSAY collection does NOT imply the document IS a model essay
  if (collection === 'MODEL_ESSAY') return 'UNKNOWN'
  if (HIGH_FILE_PATTERN.test(fileName)) {
    if (/我写的/.test(fileName)) return 'TEACHER_REWRITE'
    if (/范文/.test(fileName))   return 'MODEL_ESSAY'
    return 'UNKNOWN'
  }
  return 'STUDENT_ESSAY'
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal classifier
// ─────────────────────────────────────────────────────────────────────────────

const NEVER_AUTO_SR: SemanticRole[] = ['MODEL_TEXT', 'TEACHING_NOTE', 'EXAMPLE_EXTENSION']
const NEVER_AUTO_TR: TargetRole[] = ['MODEL_ESSAY', 'TEACHER_REWRITE', 'PARAGRAPH_SAMPLE', 'WHOLE_DOCUMENT']

function classifySignal(
  comment: ManifestComment,
  doc: ManifestDoc,
  gapType: string,
  override: ManualOverride | undefined,
): SignalClassification {
  const fileName = doc.fileName
  const feedback = comment.feedback ?? ''
  const anchor   = comment.anchorText ?? ''
  const anchorLen = anchor.trim().length

  const sl: SourceLayer = gapType === 'TYPE_C_MIGRATE_INCOMPLETE' ? 'CHUNKTEXT_PARSED' : 'WORD_COMMENT'
  const sr = estimateSemanticRole(feedback, anchor, fileName)
  const tr = estimateTargetRole(doc.collection, fileName, override)

  const highRiskReasons: string[] = []

  if (override)                               highRiskReasons.push(`manual_override:${override.manualOverrideRole}`)
  if (doc.collection === 'MODEL_ESSAY')       highRiskReasons.push('MODEL_ESSAY_doc')
  if (HIGH_FILE_PATTERN.test(fileName))       highRiskReasons.push('high_risk_filename')
  if (anchorLen === 0)                        highRiskReasons.push('no_anchor')
  if (anchorLen > 0 && anchorLen <= 3)        highRiskReasons.push('anchor_too_short')
  if (sr === 'UNKNOWN')                       highRiskReasons.push('semanticRole_UNKNOWN')
  if (tr === 'UNKNOWN')                       highRiskReasons.push('targetRole_UNKNOWN')
  if (NEVER_AUTO_TR.includes(tr))             highRiskReasons.push(`targetRole_${tr}_never_auto`)
  if (NEVER_AUTO_SR.includes(sr))             highRiskReasons.push(`semanticRole_${sr}_never_auto`)
  if (sr === 'GLOBAL_FEEDBACK')               highRiskReasons.push('semanticRole_GLOBAL_FEEDBACK')

  let reviewPriority: ReviewPriority
  let confidence: number

  if (override) {
    reviewPriority = override.reviewPriority
    confidence = 0.3
  } else if (highRiskReasons.length > 0) {
    reviewPriority = 'HIGH'
    confidence = 0.2
  } else if (
    sr === 'STRUCTURE_COMMENT' || sr === 'REWRITE_SUGGESTION' ||
    tr === 'PROMPT' || feedback.length < 10 ||
    (feedback.length > 200 && /[，。！\n]/.test(feedback.slice(0, 100)))
  ) {
    reviewPriority = 'MEDIUM'
    confidence = 0.65
  } else if (
    sl === 'WORD_COMMENT' && tr === 'STUDENT_ESSAY' &&
    sr === 'ERROR_FEEDBACK' && anchorLen > 3
  ) {
    reviewPriority = 'LOW'
    confidence = 0.9
  } else {
    reviewPriority = 'MEDIUM'
    confidence = 0.6
  }

  // autoEligible: teaching-material overrides force false; 大作文作业2 z allows normal check
  const forceNotAutoEligible = override !== undefined && !override.possibleAutoEligible
  const nonOverrideRisks = highRiskReasons.filter(r => !r.startsWith('manual_override'))

  const autoEligible = !forceNotAutoEligible && (
    (sl === 'WORD_COMMENT' || sl === 'CHUNKTEXT_PARSED') &&
    tr === 'STUDENT_ESSAY' &&
    (sr === 'ERROR_FEEDBACK' || sr === 'REWRITE_SUGGESTION' || sr === 'STRUCTURE_COMMENT') &&
    anchorLen > 3 &&
    confidence >= 0.9 &&
    doc.collection !== 'MODEL_ESSAY' &&
    !HIGH_FILE_PATTERN.test(fileName) &&
    nonOverrideRisks.length === 0
  )

  return {
    sourceLayer: sl,
    semanticRole: sr,
    targetRole: tr,
    confidence,
    reviewPriority,
    needsManualReview: reviewPriority === 'HIGH' || reviewPriority === 'MEDIUM',
    autoEligible,
    sampledForReview: false,
    betterForRawSignal: !autoEligible,
    highRiskReasons,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stratified 30% sampling
// ─────────────────────────────────────────────────────────────────────────────

function applyStratifiedSampling(signals: Array<{ classification: SignalClassification }>): {
  sampled: Set<number>
  stats: Record<string, number>
} {
  const total = signals.length
  const target = Math.ceil(total * 0.30)
  const byPri: Record<ReviewPriority, number[]> = { HIGH: [], MEDIUM: [], LOW: [], NONE: [] }
  signals.forEach((s, i) => byPri[s.classification.reviewPriority].push(i))

  const sampled = new Set<number>()
  byPri.HIGH.forEach(i => sampled.add(i))

  if (sampled.size < target) {
    const shuffled = [...byPri.MEDIUM].sort(() => Math.random() - 0.5)
    shuffled.slice(0, target - sampled.size).forEach(i => sampled.add(i))
  }
  if (sampled.size < target) {
    const shuffled = [...byPri.LOW].sort(() => Math.random() - 0.5)
    shuffled.slice(0, target - sampled.size).forEach(i => sampled.add(i))
  }

  // Ensure ≥1 per sourceLayer
  const byLayer: Record<string, number[]> = {}
  signals.forEach((s, i) => {
    const l = s.classification.sourceLayer
    ;(byLayer[l] ??= []).push(i)
  })
  for (const idxs of Object.values(byLayer)) {
    if (!idxs.some(i => sampled.has(i))) sampled.add(idxs[0])
  }

  return {
    sampled,
    stats: {
      total, target30pct: target, actual: sampled.size,
      pct: Math.round((sampled.size / total) * 100),
      HIGH: byPri.HIGH.length, MEDIUM: byPri.MEDIUM.length,
      LOW: byPri.LOW.length, NONE: byPri.NONE.length,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // ── 1. Load manifest ──────────────────────────────────────────────────────
  const manifestPath = path.resolve('data/ai-review-experiment/manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const allDocs: ManifestDoc[] = manifest.documents
  const manifestByPath = new Map(allDocs.map(d => [d.sourcePath, d]))
  const manifestByFile = new Map(allDocs.map(d => [d.fileName, d]))

  // ── 2. DB queries (read-only) ─────────────────────────────────────────────
  const dbDocs = await prisma.knowledgeDocument.findMany({
    select: {
      id: true, fileUrl: true, title: true,
      source: { select: { sourceType: true } },
      _count: { select: { chunks: true, annotations: true } },
    },
  })
  const dbByPath = new Map<string, typeof dbDocs[0]>()
  const dbById   = new Map<number, typeof dbDocs[0]>()
  for (const d of dbDocs) {
    if (d.fileUrl) dbByPath.set(d.fileUrl, d)
    dbById.set(d.id, d)
  }

  // chunk → docId map (for embedding count aggregation)
  const chunkRows = await prisma.knowledgeChunk.findMany({
    select: { id: true, documentId: true },
  })
  const chunkDocMap = new Map(chunkRows.map(c => [c.id, c.documentId]))

  const embGroups = await prisma.knowledgeEmbedding.groupBy({
    by: ['chunkId'],
    _count: { id: true },
  })
  const embByDocId = new Map<number, number>()
  for (const eg of embGroups) {
    const docId = chunkDocMap.get(eg.chunkId)
    if (docId !== undefined) embByDocId.set(docId, (embByDocId.get(docId) ?? 0) + eg._count.id)
  }

  // REVIEW_EXAMPLE chunk counts per doc
  const reGroups = await prisma.knowledgeChunk.groupBy({
    by: ['documentId'],
    where: { chunkType: 'REVIEW_EXAMPLE' },
    _count: { id: true },
  })
  const reByDocId = new Map(reGroups.map(r => [r.documentId, r._count.id]))

  function findManifestDoc(dbDoc: typeof dbDocs[0]): ManifestDoc | undefined {
    if (dbDoc.fileUrl) {
      const direct = manifestByPath.get(dbDoc.fileUrl)
      if (direct) return direct
    }
    if (dbDoc.title) return manifestByFile.get(dbDoc.title)
    return undefined
  }

  // ── 3. Python helper ──────────────────────────────────────────────────────
  const pyFile = writePythonHelper()

  // ─────────────────────────────────────────────────────────────────────────
  // §C: DROP candidate identification
  // ─────────────────────────────────────────────────────────────────────────

  const dropCandidates: DropCandidate[] = []

  for (const dbDoc of dbDocs) {
    const title    = dbDoc.title ?? ''
    const fileUrl  = dbDoc.fileUrl ?? ''
    const fileName = path.basename(fileUrl)
    const override = MANUAL_OVERRIDES[fileName]
    const mDoc     = findManifestDoc(dbDoc)
    const sourceType = dbDoc.source?.sourceType ?? 'UNKNOWN'

    const manifestCommentCount = mDoc?.comments.length ?? 0
    const annotationCount      = dbDoc._count.annotations
    const chunkCount           = dbDoc._count.chunks
    const embCount             = embByDocId.get(dbDoc.id) ?? 0
    const rawText              = mDoc?.rawText ?? ''

    const matchesAssignment = ASSIGNMENT_PATTERN.test(title) || ASSIGNMENT_PATTERN.test(fileName)

    // Human override → always DO_NOT_DROP
    if (override?.doNotDrop) {
      dropCandidates.push({
        documentId: dbDoc.id, title, sourceType, fileUrl, task: mDoc?.task ?? null,
        rawTextLength: rawText.length,
        manifestCommentCount,
        docxCommentCount: -1, coloredRunCount: -1, blueRunCount: -1, highlightCount: -1,
        chunkCount, annotationCount, embeddingCount: embCount,
        matchesAssignmentPattern: matchesAssignment,
        hasTeacherSignal: false, isManualOverride: true,
        dropConfidence: 'NONE', dropCategory: 'DO_NOT_DROP',
        reasons: [`manual_override:${override.manualOverrideRole}`, clip(override.notes, 70)],
        riskNote: 'human override — DO_NOT_DROP regardless of other signals',
        confirmQuestions: [],
        excludeFromRag: !override.allowedForRagCandidate,
        excludeFromEval: override.excludeFromEvalCandidate,
        moveToQuarantine: false, hardDeleteCandidate: false,
      })
      continue
    }

    // Only process files matching assignment pattern
    if (!matchesAssignment) continue

    const hasTeacherSignal = TEACHER_SIGNAL_KW.some(kw => rawText.includes(kw))

    // Has manifest comments or annotations → DO_NOT_DROP
    if (manifestCommentCount > 0 || annotationCount > 0) {
      const reasons: string[] = []
      if (manifestCommentCount > 0) reasons.push(`manifest_comments=${manifestCommentCount}`)
      if (annotationCount > 0)      reasons.push(`annotations=${annotationCount}`)
      dropCandidates.push({
        documentId: dbDoc.id, title, sourceType, fileUrl, task: mDoc?.task ?? null,
        rawTextLength: rawText.length,
        manifestCommentCount,
        docxCommentCount: -1, coloredRunCount: -1, blueRunCount: -1, highlightCount: -1,
        chunkCount, annotationCount, embeddingCount: embCount,
        matchesAssignmentPattern: true,
        hasTeacherSignal, isManualOverride: false,
        dropConfidence: 'NONE', dropCategory: 'DO_NOT_DROP',
        reasons,
        riskNote: '有comments或annotations，不能删除',
        confirmQuestions: ['Q: comments内容是否为学生作文批注？', 'Q: annotations是否正确导入？'],
        excludeFromRag: false, excludeFromEval: false, moveToQuarantine: false, hardDeleteCandidate: false,
      })
      continue
    }

    // Zero comments + zero annotations → inspect DOCX
    let inspect: DocxInspect = {
      docxCommentCount: 0, totalTextRuns: 0, blueRuns: 0,
      coloredRuns: 0, highlightRuns: 0, colorValues: {}, blueExamples: [],
    }
    if (fileUrl && fs.existsSync(fileUrl)) {
      inspect = inspectDocx(pyFile, fileUrl)
    }

    const docxCommentCount = inspect.docxCommentCount
    const coloredRunCount  = inspect.coloredRuns
    const blueRunCount     = inspect.blueRuns
    const highlightCount   = inspect.highlightRuns
    const hasDocxSignal    = docxCommentCount > 0 || coloredRunCount > 0 || blueRunCount > 0 || highlightCount > 0

    let dropCategory: DropCategory
    let dropConfidence: 'HIGH' | 'MEDIUM' | 'NONE'
    const reasons: string[] = ['assignment_title_pattern']
    const confirmQuestions: string[] = []

    if (hasDocxSignal || hasTeacherSignal) {
      dropCategory   = 'DO_NOT_DROP'
      dropConfidence = 'NONE'
      if (docxCommentCount > 0) reasons.push(`docx_comments=${docxCommentCount}`)
      if (coloredRunCount > 0)  reasons.push(`colored_runs=${coloredRunCount}`)
      if (blueRunCount > 0)     reasons.push(`blue_runs=${blueRunCount}`)
      if (highlightCount > 0)   reasons.push(`highlight_runs=${highlightCount}`)
      if (hasTeacherSignal)     reasons.push('teacher_signal_in_rawtext')
      confirmQuestions.push('Q: DOCX中的彩色/高亮内容是什么？教师批改还是学生格式？')
      confirmQuestions.push('Q: rawText中的教师信号词来源是否可靠？')
    } else {
      // All-clear: assignment pattern + no signals at all
      dropCategory   = 'DROP_HIGH_CONFIDENCE'
      dropConfidence = 'HIGH'
      reasons.push('manifest_comments=0', 'docx_comments=0', 'colored_runs=0', 'blue_runs=0',
        'annotations=0', 'no_teacher_signal_in_rawtext')
      if (inspect.error) reasons.push(`inspect_error:${inspect.error}`)
      confirmQuestions.push('Q: 确认这个文件是学生提交草稿，无教师批改？')
      confirmQuestions.push('Q: 确认可以排除出RAG知识库？')
      confirmQuestions.push('Q: 选择处理方式：soft_exclude / quarantine / hard_delete？')
    }

    // Medium confidence if rawText suspicious but not conclusive
    if (dropCategory === 'DROP_HIGH_CONFIDENCE' && rawText.length > 2000 && inspect.error) {
      dropCategory = 'DROP_MEDIUM_CONFIDENCE'
      dropConfidence = 'MEDIUM'
      confirmQuestions.push('Q: DOCX无法读取，请人工打开确认内容。')
    }

    dropCandidates.push({
      documentId: dbDoc.id, title, sourceType, fileUrl, task: mDoc?.task ?? null,
      rawTextLength: rawText.length,
      manifestCommentCount, docxCommentCount, coloredRunCount, blueRunCount, highlightCount,
      chunkCount, annotationCount, embeddingCount: embCount,
      matchesAssignmentPattern: true,
      hasTeacherSignal, isManualOverride: false,
      dropConfidence, dropCategory, reasons,
      riskNote: dropCategory === 'DROP_HIGH_CONFIDENCE'
        ? '当前不执行删除。等人工确认候选清单后再选择 soft_exclude / quarantine / hard_delete'
        : '需要人工打开文件确认内容后再决定',
      confirmQuestions,
      excludeFromRag:  dropCategory === 'DROP_HIGH_CONFIDENCE',
      excludeFromEval: dropCategory === 'DROP_HIGH_CONFIDENCE',
      moveToQuarantine: false,
      hardDeleteCandidate: dropCategory === 'DROP_HIGH_CONFIDENCE',
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // §B: 973 gap re-classification
  // ─────────────────────────────────────────────────────────────────────────

  interface GapDoc {
    fileName: string; collection: string; docId: number
    manifestCount: number; reChunkCount: number; annotationCount: number
    typeAGap: number; typeBGap: number; typeCGap: number; totalGap: number
    override: ManualOverride | undefined
  }

  const gapDocs: GapDoc[] = []
  let totalTypeA = 0, totalTypeB = 0, totalTypeC = 0
  let overrideTeachingMaterialCmts = 0, overrideHighValueCmts = 0

  for (const mDoc of allDocs) {
    const db = dbByPath.get(mDoc.sourcePath)
    if (!db) continue
    const fileName = mDoc.fileName
    const override = MANUAL_OVERRIDES[fileName]
    const mCount   = mDoc.comments.length
    const reCount  = reByDocId.get(db.id) ?? 0
    const annCount = db._count.annotations

    let typeA = 0, typeB = 0, typeC = 0
    if (mDoc.collection === 'MODEL_ESSAY') {
      typeA = mCount
    } else {
      if (mCount > reCount)   typeB = mCount - reCount
      if (reCount > annCount) typeC = reCount - annCount
    }
    const total = typeA + typeB + typeC
    if (total > 0) {
      gapDocs.push({ fileName, collection: mDoc.collection, docId: db.id,
        manifestCount: mCount, reChunkCount: reCount, annotationCount: annCount,
        typeAGap: typeA, typeBGap: typeB, typeCGap: typeC, totalGap: total, override })
      if (override) {
        if (override.manualOverrideRole === 'HIGH_VALUE_STUDENT_REVIEW') overrideHighValueCmts += total
        else overrideTeachingMaterialCmts += total
      }
    }
    totalTypeA += typeA
    totalTypeB += typeB
    totalTypeC += typeC
  }

  // All-signals classification for population-level stats (§D)
  const allSignals: Array<{ cls: SignalClassification; fileName: string; collection: string }> = []
  for (const mDoc of allDocs) {
    const override = MANUAL_OVERRIDES[mDoc.fileName]
    const gapType  = mDoc.collection === 'MODEL_ESSAY' ? 'TYPE_A_MODEL_ESSAY' : 'COVERED'
    for (const c of mDoc.comments) {
      allSignals.push({ cls: classifySignal(c, mDoc, gapType, override), fileName: mDoc.fileName, collection: mDoc.collection })
    }
  }

  const priDist: Record<ReviewPriority, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 }
  const slDist: Record<string, number> = {}
  const srDist: Record<string, number> = {}
  const trDist: Record<string, number> = {}
  for (const { cls } of allSignals) {
    priDist[cls.reviewPriority]++
    slDist[cls.sourceLayer]  = (slDist[cls.sourceLayer]  ?? 0) + 1
    srDist[cls.semanticRole] = (srDist[cls.semanticRole] ?? 0) + 1
    trDist[cls.targetRole]   = (trDist[cls.targetRole]   ?? 0) + 1
  }

  // ─────────────────────────────────────────────────────────────────────────
  // §D: 30% sampling on all gap signals
  // ─────────────────────────────────────────────────────────────────────────

  const gapSignals: GapSignal[] = []
  for (const mDoc of allDocs) {
    const override   = MANUAL_OVERRIDES[mDoc.fileName]
    const gapType: GapSignal['gapType'] =
      mDoc.collection === 'MODEL_ESSAY' ? 'TYPE_A_MODEL_ESSAY' : 'COVERED'
    const db = dbByPath.get(mDoc.sourcePath)
    const sourceType = db?.source?.sourceType ?? 'UNKNOWN'
    for (const c of mDoc.comments) {
      gapSignals.push({
        fileName: mDoc.fileName, collection: mDoc.collection, sourceType,
        originalCommentId: c.commentId,
        anchorText: c.anchorText ?? '',
        feedbackSnippet: clip(c.feedback, 60),
        gapType,
        overrideApplied: !!override,
        overrideNote: override ? clip(override.notes, 60) : '',
        classification: classifySignal(c, mDoc, gapType, override),
      })
    }
  }

  const { sampled, stats: sampStats } = applyStratifiedSampling(gapSignals)
  gapSignals.forEach((s, i) => { if (sampled.has(i)) s.classification.sampledForReview = true })

  const autoEligibleCount = allSignals.filter(s => s.cls.autoEligible).length
  const rawSignalCount    = allSignals.filter(s => s.cls.betterForRawSignal).length

  const sampledByLayer: Record<string, number> = {}
  const sampledBySR:    Record<string, number> = {}
  const sampledByTR:    Record<string, number> = {}
  gapSignals.forEach(s => {
    if (!s.classification.sampledForReview) return
    sampledByLayer[s.classification.sourceLayer]  = (sampledByLayer[s.classification.sourceLayer]  ?? 0) + 1
    sampledBySR[s.classification.semanticRole]    = (sampledBySR[s.classification.semanticRole]    ?? 0) + 1
    sampledByTR[s.classification.targetRole]      = (sampledByTR[s.classification.targetRole]      ?? 0) + 1
  })

  // ─────────────────────────────────────────────────────────────────────────
  // §E: 20 human confirmation samples
  // ─────────────────────────────────────────────────────────────────────────

  const samples20: GapSignal[] = []
  const seenKeys = new Set<string>()

  function addFromFile(fileName: string, limit: number) {
    for (const s of gapSignals.filter(x => x.fileName === fileName).slice(0, limit)) {
      const key = `${fileName}::${s.originalCommentId}`
      if (!seenKeys.has(key) && samples20.length < 20) { seenKeys.add(key); samples20.push(s) }
    }
  }

  // Priority 1: human override files
  addFromFile('ran 双边.docx', 2)
  addFromFile('may 程度同意2.docx', 2)
  addFromFile('joan 拓展2.docx', 2)
  addFromFile('大作文作业2 z.docx', 2)

  // Priority 2: DROP_HIGH_CONFIDENCE files (≤3 — most have 0 comments, add placeholder)
  const dropHighFiles = dropCandidates
    .filter(d => d.dropCategory === 'DROP_HIGH_CONFIDENCE')
    .slice(0, 4)
  for (const dc of dropHighFiles) {
    const fname = path.basename(dc.fileUrl)
    const existing = gapSignals.filter(s => s.fileName === fname)
    if (existing.length > 0) {
      addFromFile(fname, 1)
    } else if (samples20.length < 20) {
      // Placeholder for a zero-comment drop candidate
      samples20.push({
        fileName: fname, collection: dc.sourceType === 'MODEL_ESSAY' ? 'MODEL_ESSAY' : 'TEACHER_REVIEW',
        sourceType: dc.sourceType,
        originalCommentId: 'N/A',
        anchorText: '',
        feedbackSnippet: '[无comments — 无批注学生草稿DROP候选]',
        gapType: 'COVERED',
        overrideApplied: false, overrideNote: '',
        classification: {
          sourceLayer: 'UNKNOWN_SOURCE', semanticRole: 'UNKNOWN', targetRole: 'STUDENT_ESSAY',
          confidence: 0.1, reviewPriority: 'HIGH', needsManualReview: true,
          autoEligible: false, sampledForReview: true, betterForRawSignal: false,
          highRiskReasons: ['DROP_HIGH_CONFIDENCE', 'no_comments', 'no_color', 'assignment_pattern'],
        },
      })
      seenKeys.add(`${fname}::N/A`)
    }
  }

  // Priority 3: DO_NOT_DROP assignment files (have comments)
  const doNotDropAssignment = dropCandidates
    .filter(d => d.dropCategory === 'DO_NOT_DROP' && !d.isManualOverride && d.manifestCommentCount > 0)
  for (const dc of doNotDropAssignment.slice(0, 2)) {
    addFromFile(path.basename(dc.fileUrl), 1)
  }

  // Priority 4: MODEL_ESSAY with student names
  const studentNameDocs = allDocs.filter(d =>
    d.collection === 'MODEL_ESSAY' && /ran|may|joan|fl/.test(d.fileName) && d.comments.length > 0
  )
  for (const mDoc of studentNameDocs.slice(0, 2)) {
    addFromFile(mDoc.fileName, 1)
  }

  // Priority 5: TYPE_B (import filtered)
  const typeBSignals = gapSignals.filter(s => s.gapType === 'TYPE_B_IMPORT_FILTER')
  for (const s of typeBSignals.slice(0, 2)) {
    const key = `${s.fileName}::${s.originalCommentId}`
    if (!seenKeys.has(key) && samples20.length < 20) { seenKeys.add(key); samples20.push(s) }
  }

  // Fill remainder from HIGH priority gap signals not yet seen
  for (const s of gapSignals) {
    if (samples20.length >= 20) break
    if (s.classification.reviewPriority !== 'HIGH') continue
    const key = `${s.fileName}::${s.originalCommentId}`
    if (!seenKeys.has(key)) { seenKeys.add(key); samples20.push(s) }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OUTPUT
  // ─────────────────────────────────────────────────────────────────────────

  const eq = '═'.repeat(76)
  const hr = '─'.repeat(76)
  const total = allSignals.length
  const pct   = (n: number) => `${((n / total) * 100).toFixed(1)}%`

  console.log(`\n${eq}`)
  console.log(`  SOURCE QUALITY RECONCILIATION — DRY-RUN（只读，不写任何数据）`)
  console.log(`  时间: ${new Date().toISOString()}`)
  console.log(`  human overrides: ran双边 / may程度同意2 / joan拓展2 / 大作文作业2 z`)
  console.log(`${eq}\n`)

  // ────────────────────────────────────────────────────────────────────────
  // §A: File classification
  // ────────────────────────────────────────────────────────────────────────
  console.log(`${eq}\n  §A  人工确认文件分类表\n${eq}`)
  console.log(`  ${'文件名'.padEnd(28)} ${'old sourceType'.padEnd(16)} ${'inferredRole'.padEnd(24)} ${'overrideRole'.padEnd(28)} cmts`)
  console.log(`  ${hr}`)
  for (const [fname, ov] of Object.entries(MANUAL_OVERRIDES)) {
    const mDoc = manifestByFile.get(fname)
    const db   = mDoc ? dbByPath.get(mDoc.sourcePath) : undefined
    const stype = db?.source?.sourceType ?? '?'
    const cmts  = mDoc?.comments.length ?? 0
    console.log(`  ${fname.slice(0, 26).padEnd(28)} ${stype.padEnd(16)} ${ov.inferredRole.padEnd(24)} ${ov.manualOverrideRole.padEnd(28)} ${cmts}`)
    console.log(`    → ${ov.notes.slice(0, 72)}`)
  }
  console.log()
  console.log(`  规则说明:`)
  console.log(`  • sourceType=MODEL_ESSAY ≠ "范文"（目录分类不等于内容类型）`)
  console.log(`  • 文件名含学生名 ≠ 学生作文（可能是教学材料）`)
  console.log(`  • 文件名含"作业" ≠ DROP候选（如大作文作业2 z有高价值批注）`)
  console.log(`  • 蓝色≠错误  黑色≠学生原文  WORD_COMMENT≠ERROR_FEEDBACK`)

  // ────────────────────────────────────────────────────────────────────────
  // §B: 973 gap re-classification
  // ────────────────────────────────────────────────────────────────────────
  console.log(`\n${eq}\n  §B  973 条差额重新分类（human override 融合）\n${eq}`)

  const manifestTotal = allDocs.reduce((s, d) => s + d.comments.length, 0)
  const gapTotal = totalTypeA + totalTypeB + totalTypeC
  console.log(`manifest 总 comments:                   ${manifestTotal}`)
  console.log(`DB KnowledgeAnnotation:                 12440`)
  console.log(`差额合计:                                ${gapTotal}`)
  console.log()
  console.log(`TYPE_A (MODEL_ESSAY, never imported):   ${totalTypeA}`)

  const modelEssayStudentNameDocs = allDocs.filter(d =>
    d.collection === 'MODEL_ESSAY' && /ran|may|joan|fl/.test(d.fileName)
  )
  const modelEssayStudentNameCmts = modelEssayStudentNameDocs.reduce((s, d) => s + d.comments.length, 0)
  console.log(`  其中 human override 教学材料(ran+may+joan):  ${overrideTeachingMaterialCmts}`)
  console.log(`  其中 human override 高价值学生批改(大作业2z): ${overrideHighValueCmts}`)
  console.log(`  其中含学生名(ran/may/joan/fl)的MODEL_ESSAY:   ${modelEssayStudentNameCmts} (${modelEssayStudentNameDocs.length}个文件)`)
  console.log(`  其他MODEL_ESSAY comments:                    ${totalTypeA - modelEssayStudentNameCmts}`)
  console.log()
  console.log(`TYPE_B (import 过滤 — 极短anchor/feedback):  ${totalTypeB}`)
  console.log(`  → 可作 RawAnnotationSignal 候选，但价值有限（多为极短内容）`)
  console.log(`  → 不直接补进 KnowledgeAnnotation`)
  console.log()
  console.log(`TYPE_C (migrate 未完成):                      ${totalTypeC}`)
  console.log(`  → migrate 已全量运行，TYPE_C=0`)
  console.log()
  console.log(`差额去向分类:`)
  console.log(`  教学材料 comments (ran+may+joan):             ${overrideTeachingMaterialCmts}  → RawSignal, targetRole=UNKNOWN`)
  console.log(`  高价值学生批改 (大作文作业2 z):                ${overrideHighValueCmts}  → RawSignal, targetRole优先STUDENT_ESSAY`)
  console.log(`  MODEL_ESSAY含学生名 (需确认):                  ${modelEssayStudentNameCmts}  → targetRole=UNKNOWN, needsManualReview=true`)
  console.log(`  其他MODEL_ESSAY:                              ${totalTypeA - modelEssayStudentNameCmts}  → targetRole=UNKNOWN, needsManualReview=true`)
  console.log(`  TYPE_B import filter:                         ${totalTypeB}  → RawSignal候选, priority=MEDIUM`)
  console.log()
  console.log(`可进入 RawAnnotationSignal 的信号总量（估算）:  ~${totalTypeA + totalTypeB} 条`)

  const gapDocsSorted = [...gapDocs].sort((a, b) => b.totalGap - a.totalGap)
  console.log(`\n差额文档 Top 15（按差额大小）:`)
  console.log(`  ${'文件名'.padEnd(36)} collection       cmts  chunk  ann  gap  override`)
  console.log(`  ${hr}`)
  for (const gd of gapDocsSorted.slice(0, 15)) {
    const name = gd.fileName.slice(0, 34).padEnd(36)
    const col  = gd.collection === 'MODEL_ESSAY' ? 'MODEL_ESSAY    ' : 'TEACHER_REVIEW'
    const ov   = gd.override ? `[${gd.override.manualOverrideRole.slice(0, 16)}]` : ''
    console.log(`  ${name} ${col} ${String(gd.manifestCount).padStart(4)} ${String(gd.reChunkCount).padStart(5)} ${String(gd.annotationCount).padStart(4)} ${String(gd.totalGap).padStart(3)}  ${ov}`)
  }

  // ────────────────────────────────────────────────────────────────────────
  // §C: DROP candidates
  // ────────────────────────────────────────────────────────────────────────
  console.log(`\n${eq}\n  §C  作业类无批注文件 DROP 候选（当前不执行任何删除）\n${eq}`)

  const dropHigh = dropCandidates.filter(d => d.dropCategory === 'DROP_HIGH_CONFIDENCE')
  const dropMed  = dropCandidates.filter(d => d.dropCategory === 'DROP_MEDIUM_CONFIDENCE')
  const doNotDrop = dropCandidates.filter(d => d.dropCategory === 'DO_NOT_DROP')

  console.log(`扫描作业类文件合计:      ${dropCandidates.length}`)
  console.log(`DROP_HIGH_CONFIDENCE:   ${dropHigh.length}`)
  console.log(`DROP_MEDIUM_CONFIDENCE: ${dropMed.length}`)
  console.log(`DO_NOT_DROP:            ${doNotDrop.length}`)
  console.log()

  if (dropHigh.length > 0) {
    console.log(`── DROP_HIGH_CONFIDENCE（${dropHigh.length}个文件）─────────────────────────────`)
    for (const d of dropHigh) {
      console.log(`  [docId=${d.documentId}] ${d.title.slice(0, 44)}`)
      console.log(`    sourceType=${d.sourceType}  task=${d.task ?? 'null'}  rawText=${d.rawTextLength}chars`)
      console.log(`    manifest_cmts=${d.manifestCommentCount}  docx_cmts=${d.docxCommentCount}  colored=${d.coloredRunCount}  blue=${d.blueRunCount}  hl=${d.highlightCount}`)
      console.log(`    chunks=${d.chunkCount}  annotations=${d.annotationCount}  embeddings=${d.embeddingCount}`)
      console.log(`    理由: ${d.reasons.slice(0, 5).join(' | ')}`)
      console.log(`    ⚠ ${d.riskNote}`)
      console.log(`    excludeFromRag=${d.excludeFromRag}  excludeFromEval=${d.excludeFromEval}  hardDeleteCandidate=${d.hardDeleteCandidate}`)
      for (const q of d.confirmQuestions) console.log(`    ${q}`)
      console.log()
    }
  }

  if (dropMed.length > 0) {
    console.log(`── DROP_MEDIUM_CONFIDENCE（${dropMed.length}个文件）─────────────────────────`)
    for (const d of dropMed) {
      console.log(`  [docId=${d.documentId}] ${d.title.slice(0, 44)}`)
      console.log(`    sourceType=${d.sourceType}  cmts=${d.manifestCommentCount}  colored=${d.coloredRunCount}  teacherSignal=${d.hasTeacherSignal}`)
      console.log(`    理由: ${d.reasons.join(' | ')}`)
      for (const q of d.confirmQuestions) console.log(`    ${q}`)
      console.log()
    }
  }

  if (doNotDrop.length > 0) {
    console.log(`── DO_NOT_DROP（${doNotDrop.length}个文件）`)
    for (const d of doNotDrop.slice(0, 12)) {
      const ov = d.isManualOverride ? ` [OVERRIDE]` : ''
      console.log(`  [docId=${d.documentId}] ${d.title.slice(0, 44)}${ov}  理由: ${d.reasons.slice(0, 2).join(' | ')}`)
    }
    if (doNotDrop.length > 12) console.log(`  ... 另有 ${doNotDrop.length - 12} 个`)
  }

  // Delete strategy comparison
  console.log(`\n── 三种后续处理策略比较（当前不执行）──`)
  console.log(`  Option 1 Soft exclude [推荐]:`)
  console.log(`    不删原始Word，不删DB记录`)
  console.log(`    写入质量字段: allowedForRag=false, excludeFromEval=true, contentRole=UNANNOTATED_STUDENT_DRAFT`)
  console.log(`    优点: 最安全，完全可恢复`)
  console.log(`  Option 2 Quarantine:`)
  console.log(`    把原始DOCX移到 quarantine/ 文件夹，DB暂不删`)
  console.log(`    下次重新导入时跳过`)
  console.log(`  Option 3 Hard delete:`)
  console.log(`    删DB记录 + 删/移文件，风险最大`)
  console.log(`    当前不执行，必须先备份 + 人工确认候选清单`)

  // ────────────────────────────────────────────────────────────────────────
  // §D: 30% review pool stats
  // ────────────────────────────────────────────────────────────────────────
  console.log(`\n${eq}\n  §D  30% 人工复核池统计（全量 ${total} 条信号）\n${eq}`)
  console.log(`总信号数:              ${total}`)
  console.log(`HIGH  (100%复核):      ${String(priDist.HIGH).padStart(5)}  (${pct(priDist.HIGH)})`)
  console.log(`MEDIUM (抽样复核):     ${String(priDist.MEDIUM).padStart(5)}  (${pct(priDist.MEDIUM)})`)
  console.log(`LOW   (少量抽样):      ${String(priDist.LOW).padStart(5)}  (${pct(priDist.LOW)})`)
  console.log(`NONE:                  ${String(priDist.NONE).padStart(5)}  (${pct(priDist.NONE)})`)
  console.log()
  console.log(`sampledForReview（模拟）: ${sampStats.actual} / ${total} = ${sampStats.pct}%  (目标≥30%)`)
  console.log(`autoEligible=true:        ${autoEligibleCount}  (${((autoEligibleCount / total) * 100).toFixed(1)}%)  — 当前阶段不转换`)
  console.log(`betterForRawSignal:       ${rawSignalCount}  (${((rawSignalCount / total) * 100).toFixed(1)}%)  — 保留为RawAnnotationSignal`)
  console.log()
  if (priDist.HIGH / total >= 0.30) {
    console.log(`  ✓ HIGH(${pct(priDist.HIGH)}) 本身超过30%，分层采样目标自动满足`)
  }
  console.log()
  console.log(`sourceLayer 分布 + 复核覆盖:`)
  for (const [k, v] of Object.entries(slDist).sort(([, a], [, b]) => b - a)) {
    const s = sampledByLayer[k] ?? 0
    console.log(`  ${k.padEnd(26)} ${String(v).padStart(5)}  复核 ${String(s).padStart(5)}  (${((s / v) * 100).toFixed(0)}%)`)
  }
  console.log(`\nsemanticRole 分布 + 复核覆盖:`)
  for (const [k, v] of Object.entries(srDist).sort(([, a], [, b]) => b - a)) {
    const s = sampledBySR[k] ?? 0
    console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}  复核 ${String(s).padStart(5)}  (${((s / v) * 100).toFixed(0)}%)`)
  }
  console.log(`\ntargetRole 分布 + 复核覆盖:`)
  for (const [k, v] of Object.entries(trDist).sort(([, a], [, b]) => b - a)) {
    const s = sampledByTR[k] ?? 0
    console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}  复核 ${String(s).padStart(5)}  (${((s / v) * 100).toFixed(0)}%)`)
  }

  // ────────────────────────────────────────────────────────────────────────
  // §E: 20 human confirmation samples
  // ────────────────────────────────────────────────────────────────────────
  console.log(`\n${eq}\n  §E  20 条人工确认样例\n${eq}`)
  console.log(`  Q1 学生作文错误批注？  Q2 教师范文/改写？  Q3 举一反三/拓展？`)
  console.log(`  Q4 应进KnowledgeAnnotation？  Q5 仅作教学材料？  Q6 excludeFromEval？`)
  console.log()

  for (const [i, s] of samples20.entries()) {
    const c = s.classification
    const ovTag = s.overrideApplied ? ` ★OVERRIDE:${MANUAL_OVERRIDES[s.fileName]?.manualOverrideRole}` : ''
    console.log(`┌─ 样本 ${String(i + 1).padStart(2)} ─────────────────────────────────────────────────────────────┐`)
    console.log(`│ ${s.fileName.slice(0, 54)}${ovTag}`)
    console.log(`│ collection=${s.collection}  sourceType=${s.sourceType}  gapType=${s.gapType}`)
    console.log(`│ anchor:   "${clip(s.anchorText, 52)}"`)
    console.log(`│ feedback: "${s.feedbackSnippet}"`)
    console.log(`│ sl=${c.sourceLayer.padEnd(18)}  sr=${c.semanticRole.padEnd(20)}  tr=${c.targetRole}`)
    console.log(`│ priority=${c.reviewPriority.padEnd(7)}  conf=${c.confidence.toFixed(2)}  autoEligible=${c.autoEligible}`)
    if (s.overrideApplied) console.log(`│ ★ ${s.overrideNote}`)
    if (c.highRiskReasons.length > 0) console.log(`│ ⚠ ${c.highRiskReasons.slice(0, 4).join(' | ')}`)
    console.log(`│ Q1=?  Q2=?  Q3=?  Q4=?  Q5=?  Q6=?`)
    console.log(`└──────────────────────────────────────────────────────────────────────┘`)
    console.log()
  }

  // ────────────────────────────────────────────────────────────────────────
  // Final summary
  // ────────────────────────────────────────────────────────────────────────
  const dropHighCount = dropCandidates.filter(d => d.dropCategory === 'DROP_HIGH_CONFIDENCE').length
  const dropMedCount  = dropCandidates.filter(d => d.dropCategory === 'DROP_MEDIUM_CONFIDENCE').length
  const doNotDropCount = dropCandidates.filter(d => d.dropCategory === 'DO_NOT_DROP').length
  const overrideDNDCount = dropCandidates.filter(d => d.isManualOverride).length

  console.log(`${eq}`)
  console.log(`  汇报（只读分析完成，未写入任何数据）`)
  console.log(`${eq}`)
  console.log(`1. ran/may/joan: 已标记为教学材料，targetRole=UNKNOWN，DO_NOT_DROP，不转KnowledgeAnnotation`)
  console.log(`2. 大作文作业2 z: 高价值学生批改材料，DO_NOT_DROP，DO_NOT_QUARANTINE，已正确排除出删除候选 ✓`)
  console.log(`3. 973条差额: TYPE_A=${totalTypeA}, TYPE_B=${totalTypeB}, TYPE_C=${totalTypeC}`)
  console.log(`   ~ ${totalTypeA + totalTypeB} 条适合进入 RawAnnotationSignal`)
  console.log(`4. autoEligible=true: ${autoEligibleCount} 条 (${((autoEligibleCount / total) * 100).toFixed(1)}%)  — 当前阶段不转换`)
  console.log(`5. 必须人工复核: ${sampStats.actual} 条 (${sampStats.pct}%)  ✓ 已满足≥30%目标`)
  console.log(`6. DROP_HIGH_CONFIDENCE 候选: ${dropHighCount} 个文件（无批注无彩色无教师信号的作业类文件）`)
  console.log(`7. DROP_MEDIUM_CONFIDENCE: ${dropMedCount} 个文件（需人工打开确认）`)
  console.log(`8. DO_NOT_DROP: ${doNotDropCount} 个文件（含${overrideDNDCount}个human override + 有comments的作业文件）`)
  console.log(`9. 大作文作业2 z: 已正确排除出删除候选 ✓`)
  console.log(`10. 推荐删除策略: Option 1 Soft exclude（最安全）`)
  console.log(`    先人工确认§C的DROP_HIGH_CONFIDENCE清单，再通过质量字段标记排除，不直接删DB`)
  console.log()
  console.log(`下一步（等用户确认§E样例后）:`)
  console.log(`  a. 用户确认§E 20条样例的Q1-Q6`)
  console.log(`  b. 用户确认§C DROP_HIGH_CONFIDENCE候选清单`)
  console.log(`  c. 确认后 → prisma db push → 建RawAnnotationSignal表`)
  console.log(`  d. 运行 rag:classify-quality --write（写入文档级质量字段）`)
  console.log(`${eq}\n`)
}

main()
  .catch(err => { console.error('Fatal:', err); process.exit(1) })
  .finally(() => prisma.$disconnect())
