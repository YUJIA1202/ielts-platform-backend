/**
 * Read-only reconciliation: manifest.json comments (13,413) vs KnowledgeAnnotation (12,440)
 *
 * Gap types:
 *   TYPE_A  MODEL_ESSAY comments — never imported as REVIEW_EXAMPLE chunks (by design)
 *   TYPE_C  TEACHER_REVIEW REVIEW_EXAMPLE chunks — not yet migrated to KnowledgeAnnotation
 *
 * Also simulates the 30% stratified human-review sampling across all 13,413 signals.
 *
 * NO WRITES — never touches any DB table.
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import prisma from '../src/prisma'

// ── Types ────────────────────────────────────────────────────────────────────

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

type GapType = 'TYPE_A_MODEL_ESSAY' | 'TYPE_C_MIGRATE_INCOMPLETE' | 'TYPE_B_IMPORT_FILTER' | 'COVERED'

type ReviewPriority = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
type SemanticRole =
  | 'ERROR_FEEDBACK' | 'REWRITE_SUGGESTION' | 'TEACHER_REWRITE' | 'MODEL_TEXT'
  | 'TEACHING_NOTE' | 'EXAMPLE_EXTENSION' | 'STRUCTURE_COMMENT' | 'GLOBAL_FEEDBACK' | 'UNKNOWN'
type TargetRole =
  | 'STUDENT_ESSAY' | 'MODEL_ESSAY' | 'TEACHER_REWRITE' | 'PROMPT'
  | 'PARAGRAPH_SAMPLE' | 'WHOLE_DOCUMENT' | 'UNKNOWN'
type SourceLayer =
  | 'WORD_COMMENT' | 'CHUNKTEXT_PARSED' | 'INLINE_COLORED_TEXT'
  | 'INLINE_BLACK_TEXT' | 'APPENDED_NOTE' | 'GLOBAL_NOTE' | 'UNKNOWN_SOURCE'

interface SignalClassification {
  sourceLayer: SourceLayer
  semanticRole: SemanticRole
  targetRole: TargetRole
  confidence: number
  reviewPriority: ReviewPriority
  needsManualReview: boolean
  autoEligible: boolean
  sampledForReview: boolean
  suitableForKnowledgeAnnotation: boolean
  betterForRawSignal: boolean
  highRiskReasons: string[]
}

interface MissingSignal {
  fileName: string
  collection: string
  originalCommentId: string
  anchorText: string
  feedbackSnippet: string
  gapType: GapType
  classification: SignalClassification
}

// ── High-risk file pattern ────────────────────────────────────────────────────

const HIGH_FILE_PATTERN = /我写的|范文|改写|拓展|补充|思路|资料|参考|讲义/

// ── Keyword banks (from migrate-annotations logic, extended) ─────────────────

const GRAMMAR_KW = ['语法','时态','单复数','冠词','介词','大写','小写','拼写','标点','逗号',
  '可数','不可数','词性','主谓','虚拟语气','比较级','从句','并列','平行结构',
  'grammar','spelling','tense','article','plural','preposition']
const VOCAB_KW = ['换成','替换','改成','可以用','建议','词汇','用词','搭配','短语',
  '同义词','近义词','word choice','replace']
const LOGIC_KW = ['逻辑','矛盾','前后','一致性','因果','说不通','inconsistent','logical']
const COHESION_KW = ['衔接','连接','过渡','transition','连贯','cohesion']
const STRUCTURE_KW = ['结构','段落','开头','结尾','布局','主体段','structure','paragraph']
const TASK_KW = ['题目','要求','任务','偏题','没有回应','审题','task response']
const STYLE_KW = ['口语','正式','文体','informal','formal','删','省','不需要','可以省']
const MODEL_KW = ['范文','我写的','改写后','修改版','改写版','完整版']
const TEACHING_KW = ['思路','举一反三','方法','讲解','规则','主谓宾','语法点']
const EXTEND_KW = ['拓展','补充','参考','更多版本','其他版本','变体','另一种写法']
const GLOBAL_FB_KW = ['整体','总结','总体来说','整篇','综合来看','最后','总的来说',
  'overall','in general','to summarize']

function kwMatch(text: string, kws: string[]): boolean {
  return kws.some(k => text.toLowerCase().includes(k))
}

function estimateSemanticRole(feedback: string, anchor: string, fileName: string): SemanticRole {
  if (kwMatch(fileName, MODEL_KW) || kwMatch(feedback, MODEL_KW)) return 'MODEL_TEXT'
  if (kwMatch(feedback, TEACHING_KW))  return 'TEACHING_NOTE'
  if (kwMatch(feedback, EXTEND_KW))    return 'EXAMPLE_EXTENSION'
  if (kwMatch(feedback, GLOBAL_FB_KW)) return 'GLOBAL_FEEDBACK'
  if (kwMatch(feedback, GRAMMAR_KW))   return 'ERROR_FEEDBACK'
  if (kwMatch(feedback, LOGIC_KW))     return 'ERROR_FEEDBACK'
  if (kwMatch(feedback, TASK_KW))      return 'ERROR_FEEDBACK'
  if (kwMatch(feedback, STRUCTURE_KW)) return 'STRUCTURE_COMMENT'
  if (kwMatch(feedback, COHESION_KW))  return 'STRUCTURE_COMMENT'
  if (kwMatch(feedback, VOCAB_KW)) {
    // "换成X" pattern suggests replacement/rewrite
    if (/换成|改成|建议用|修改/.test(feedback)) return 'REWRITE_SUGGESTION'
    return 'REWRITE_SUGGESTION'
  }
  if (kwMatch(feedback, STYLE_KW))     return 'REWRITE_SUGGESTION'
  return 'UNKNOWN'
}

function estimateTargetRole(collection: string, fileName: string, anchor: string, feedback: string): TargetRole {
  if (collection === 'MODEL_ESSAY') return 'MODEL_ESSAY'
  if (HIGH_FILE_PATTERN.test(fileName)) {
    // 含"我写的"/"范文" → 目标对象很可能是教师写的内容
    if (/我写的/.test(fileName)) return 'TEACHER_REWRITE'
    if (/范文/.test(fileName)) return 'MODEL_ESSAY'
    return 'UNKNOWN'
  }
  // Anchor is Chinese-dominant → teacher writing target unknown
  const cjkRatio = (s: string) => (s.match(/[㐀-鿿]/g)?.length ?? 0) / Math.max(1, s.length)
  if (anchor && cjkRatio(anchor) > 0.5) return 'UNKNOWN'
  // Default for TEACHER_REVIEW: likely student essay
  return 'STUDENT_ESSAY'
}

// ── Risk classification ───────────────────────────────────────────────────────

const NEVER_AUTO_CONVERT_SEMANTIC: SemanticRole[] = ['MODEL_TEXT','TEACHING_NOTE','EXAMPLE_EXTENSION']
const NEVER_AUTO_CONVERT_TARGET: TargetRole[] = ['MODEL_ESSAY','TEACHER_REWRITE','PARAGRAPH_SAMPLE','WHOLE_DOCUMENT']

function classifySignal(
  comment: ManifestComment,
  doc: ManifestDoc,
  gapType: GapType,
): SignalClassification {
  const fileName  = doc.fileName
  const feedback  = comment.feedback
  const anchor    = comment.anchorText ?? ''
  const anchorLen = anchor.trim().length

  const sr = estimateSemanticRole(feedback, anchor, fileName)
  const tr = estimateTargetRole(doc.collection, fileName, anchor, feedback)

  const sl: SourceLayer = gapType === 'TYPE_C_MIGRATE_INCOMPLETE' ? 'CHUNKTEXT_PARSED' : 'WORD_COMMENT'

  const highRiskReasons: string[] = []

  // ── HIGH risk conditions ────────────────────────────────────────────────────
  if (doc.collection === 'MODEL_ESSAY')        highRiskReasons.push('MODEL_ESSAY_doc')
  if (HIGH_FILE_PATTERN.test(fileName))        highRiskReasons.push('high_risk_filename')
  if (anchorLen === 0)                         highRiskReasons.push('no_anchor')
  if (anchorLen > 0 && anchorLen <= 3)         highRiskReasons.push('anchor_too_short')
  if (sr === 'UNKNOWN')                        highRiskReasons.push('semanticRole_UNKNOWN')
  if (tr === 'UNKNOWN')                        highRiskReasons.push('targetRole_UNKNOWN')
  if (NEVER_AUTO_CONVERT_TARGET.includes(tr))  highRiskReasons.push(`targetRole_${tr}_never_auto`)
  if (NEVER_AUTO_CONVERT_SEMANTIC.includes(sr)) highRiskReasons.push(`semanticRole_${sr}_never_auto`)
  if (tr === 'TEACHER_REWRITE')                highRiskReasons.push('targetRole_TEACHER_REWRITE')
  if (sr === 'GLOBAL_FEEDBACK')                highRiskReasons.push('semanticRole_GLOBAL_FEEDBACK')

  let reviewPriority: ReviewPriority
  let confidence: number

  if (highRiskReasons.length > 0) {
    reviewPriority = 'HIGH'
    confidence = 0.2
  } else if (
    // MEDIUM: colored text, inferred roles, paragraph-level, ambiguous feedback
    sl === 'INLINE_COLORED_TEXT' ||
    sr === 'STRUCTURE_COMMENT' ||
    sr === 'REWRITE_SUGGESTION' ||
    tr === 'PROMPT' ||
    feedback.length < 10 ||
    (feedback.length > 200 && /[，。！\n]/.test(feedback.slice(0, 100)))
  ) {
    reviewPriority = 'MEDIUM'
    confidence = 0.65
  } else if (
    // LOW: WORD_COMMENT + STUDENT_ESSAY + ERROR_FEEDBACK + locatable anchor
    sl === 'WORD_COMMENT' &&
    tr === 'STUDENT_ESSAY' &&
    (sr === 'ERROR_FEEDBACK') &&
    anchorLen > 3
  ) {
    reviewPriority = 'LOW'
    confidence = 0.9
  } else {
    reviewPriority = 'MEDIUM'
    confidence = 0.6
  }

  const needsManualReview = reviewPriority === 'HIGH' ||
    (reviewPriority === 'MEDIUM' && Math.random() < 0.5) // placeholder — real sampling done separately

  const autoEligible =
    (sl === 'WORD_COMMENT' || sl === 'CHUNKTEXT_PARSED') &&
    tr === 'STUDENT_ESSAY' &&
    (sr === 'ERROR_FEEDBACK' || sr === 'REWRITE_SUGGESTION' || sr === 'STRUCTURE_COMMENT') &&
    anchorLen > 3 &&
    confidence >= 0.9 &&
    doc.collection !== 'MODEL_ESSAY' &&
    !HIGH_FILE_PATTERN.test(fileName) &&
    highRiskReasons.length === 0

  const suitableForKnowledgeAnnotation = autoEligible
  const betterForRawSignal = !autoEligible

  return {
    sourceLayer: sl,
    semanticRole: sr,
    targetRole: tr,
    confidence,
    reviewPriority,
    needsManualReview: reviewPriority === 'HIGH' || reviewPriority === 'MEDIUM',
    autoEligible,
    sampledForReview: false, // set by sampling algorithm
    suitableForKnowledgeAnnotation,
    betterForRawSignal,
    highRiskReasons,
  }
}

// ── 30% Stratified sampling algorithm ────────────────────────────────────────

function applyStratifiedSampling(signals: MissingSignal[]): {
  sampled: Set<number>
  stats: Record<string, number>
} {
  const total = signals.length
  const target = Math.ceil(total * 0.30)

  const byPriority: Record<ReviewPriority, number[]> = { HIGH: [], MEDIUM: [], LOW: [], NONE: [] }
  signals.forEach((s, i) => byPriority[s.classification.reviewPriority].push(i))

  const sampled = new Set<number>()

  // Step 1: All HIGH
  byPriority.HIGH.forEach(i => sampled.add(i))

  // Step 2: If < 30%, sample MEDIUM to fill
  if (sampled.size < target) {
    const need = target - sampled.size
    const medShuffled = [...byPriority.MEDIUM].sort(() => Math.random() - 0.5)
    medShuffled.slice(0, need).forEach(i => sampled.add(i))
  }

  // Step 3: If still < 30%, sample LOW
  if (sampled.size < target) {
    const need = target - sampled.size
    const lowShuffled = [...byPriority.LOW].sort(() => Math.random() - 0.5)
    lowShuffled.slice(0, need).forEach(i => sampled.add(i))
  }

  // Step 4: Ensure minimum coverage per sourceLayer (at least 1)
  const byLayer: Record<string, number[]> = {}
  signals.forEach((s, i) => {
    const l = s.classification.sourceLayer
    if (!byLayer[l]) byLayer[l] = []
    byLayer[l].push(i)
  })
  for (const idxs of Object.values(byLayer)) {
    if (!idxs.some(i => sampled.has(i)) && idxs.length > 0) sampled.add(idxs[0])
  }

  // Step 5: Ensure minimum coverage per targetRole (at least 1)
  const byTarget: Record<string, number[]> = {}
  signals.forEach((s, i) => {
    const t = s.classification.targetRole
    if (!byTarget[t]) byTarget[t] = []
    byTarget[t].push(i)
  })
  for (const idxs of Object.values(byTarget)) {
    if (!idxs.some(i => sampled.has(i)) && idxs.length > 0) sampled.add(idxs[0])
  }

  const stats: Record<string, number> = {
    total,
    target30pct: target,
    actual: sampled.size,
    pct: Math.round((sampled.size / total) * 100),
    HIGH: byPriority.HIGH.length,
    MEDIUM: byPriority.MEDIUM.length,
    LOW: byPriority.LOW.length,
    NONE: byPriority.NONE.length,
  }
  return { sampled, stats }
}

// ── Clip helper ───────────────────────────────────────────────────────────────

function clip(s: string, n: number) {
  const c = s.replace(/\n/g, ' ').trim()
  return c.length > n ? c.slice(0, n) + '…' : c
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Load manifest ────────────────────────────────────────────────────────────
  const manifestPath = path.resolve('data/ai-review-experiment/manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const allDocs: ManifestDoc[] = manifest.documents

  // ── DB Queries (read-only) ────────────────────────────────────────────────────
  const dbDocs = await prisma.knowledgeDocument.findMany({
    select: {
      id: true, fileUrl: true, title: true,
      source: { select: { sourceType: true } },
      _count: { select: { chunks: true, annotations: true } },
    },
  })
  const dbByPath = new Map<string, typeof dbDocs[0]>()
  for (const d of dbDocs) { if (d.fileUrl) dbByPath.set(d.fileUrl, d) }

  const reGroups = await prisma.knowledgeChunk.groupBy({
    by: ['documentId'],
    where: { chunkType: 'REVIEW_EXAMPLE' },
    _count: { id: true },
  })
  const reByDocId = new Map(reGroups.map(r => [r.documentId, r._count.id]))

  // ── Gap analysis per document ────────────────────────────────────────────────
  interface DocGap {
    fileName: string
    collection: string
    docId: number
    manifestCount: number
    reChunkCount: number
    annotationCount: number
    typeAGap: number  // MODEL_ESSAY comments never imported
    typeBGap: number  // TEACHER_REVIEW comments filtered during import
    typeCGap: number  // TEACHER_REVIEW chunks not migrated
    totalGap: number
  }
  const gapDocs: DocGap[] = []
  let totalTypeA = 0, totalTypeB = 0, totalTypeC = 0

  for (const doc of allDocs) {
    const db = dbByPath.get(doc.sourcePath)
    if (!db) continue
    const mCount = doc.comments.length
    const reCount = reByDocId.get(db.id) ?? 0
    const annCount = db._count.annotations

    let typeA = 0, typeB = 0, typeC = 0

    if (doc.collection === 'MODEL_ESSAY') {
      typeA = mCount  // MODEL_ESSAY: never imported
    } else {
      // TEACHER_REVIEW
      if (mCount > reCount) typeB = mCount - reCount   // import filter
      if (reCount > annCount) typeC = reCount - annCount // migrate incomplete
    }

    const total = typeA + typeB + typeC
    if (total > 0) {
      gapDocs.push({ fileName: doc.fileName, collection: doc.collection,
        docId: db.id, manifestCount: mCount, reChunkCount: reCount,
        annotationCount: annCount, typeAGap: typeA, typeBGap: typeB,
        typeCGap: typeC, totalGap: total })
    }
    totalTypeA += typeA
    totalTypeB += typeB
    totalTypeC += typeC
  }

  // ── Collect missing signals for 20 representative samples ────────────────────
  // Select diverse gap documents
  const typeADocs = gapDocs.filter(d => d.typeAGap > 0).sort((a,b) => b.typeAGap - a.typeAGap)
  const typeBDocs = gapDocs.filter(d => d.typeBGap > 0).sort((a,b) => b.typeBGap - a.typeBGap)
  const typeCDocs = gapDocs.filter(d => d.typeCGap > 0).sort((a,b) => b.typeCGap - a.typeCGap)

  const missingSignals: MissingSignal[] = []
  const seen = new Set<string>()

  const addFromManifest = (doc: ManifestDoc, gapType: GapType, limit: number) => {
    const manifestDoc = allDocs.find(d => d.sourcePath === doc.sourcePath || d.fileName === doc.fileName)
    if (!manifestDoc) return
    for (const c of manifestDoc.comments.slice(0, limit)) {
      const key = `${doc.fileName}::${c.commentId}`
      if (seen.has(key)) continue
      seen.add(key)
      const cls = classifySignal(c, manifestDoc, gapType)
      missingSignals.push({
        fileName: doc.fileName,
        collection: doc.collection,
        originalCommentId: c.commentId,
        anchorText: c.anchorText ?? '',
        feedbackSnippet: clip(c.feedback, 80),
        gapType,
        classification: cls,
      })
    }
  }

  // For TYPE_C: get actual unannotated chunks from DB (more accurate)
  const typeCDocIds = typeCDocs.slice(0, 5).map(d => d.docId)
  const unannotatedChunks = typeCDocIds.length > 0
    ? await prisma.knowledgeChunk.findMany({
        where: {
          documentId: { in: typeCDocIds },
          chunkType: 'REVIEW_EXAMPLE',
          annotations: { none: {} },
        },
        select: { id: true, documentId: true, chunkText: true },
        orderBy: { id: 'asc' },
        take: 30,
      })
    : []

  const chunkDocMap = new Map<number, string>()
  for (const gd of typeCDocs) chunkDocMap.set(gd.docId, gd.fileName)

  // Build fake ManifestDoc for unannotated chunks
  for (const chunk of unannotatedChunks.slice(0, 8)) {
    const anchorMatch = chunk.chunkText.match(/\[学生原文\]\n([\s\S]*?)\n\n\[教师反馈\]/)
    const fbMatch    = chunk.chunkText.match(/\[教师反馈\]\n([\s\S]*)$/)
    const anchor = anchorMatch?.[1]?.trim() ?? ''
    const feedback = fbMatch?.[1]?.trim() ?? chunk.chunkText.slice(0, 100)
    const docFileName = chunkDocMap.get(chunk.documentId) ?? `docId=${chunk.documentId}`
    const fakeDoc = allDocs.find(d => {
      const db = dbByPath.get(d.sourcePath)
      return db?.id === chunk.documentId
    })
    const fakeComment: ManifestComment = {
      commentId: `chunk-${chunk.id}`,
      paragraphIndex: -1,
      anchorText: anchor,
      feedback,
    }
    const cls = classifySignal(fakeComment, fakeDoc ?? {
      collection: 'TEACHER_REVIEW', fileName: docFileName,
      sourcePath: '', task: null, rawText: '', paragraphs: [],
      comments: [], stats: { characters: 0, paragraphs: 0, comments: 0 },
    }, 'TYPE_C_MIGRATE_INCOMPLETE')
    missingSignals.push({
      fileName: docFileName,
      collection: 'TEACHER_REVIEW',
      originalCommentId: `chunk-${chunk.id}`,
      anchorText: anchor,
      feedbackSnippet: clip(feedback, 80),
      gapType: 'TYPE_C_MIGRATE_INCOMPLETE',
      classification: cls,
    })
  }

  // TYPE_A: MODEL_ESSAY comments
  for (const gd of typeADocs.slice(0, 5)) {
    addFromManifest(gd, 'TYPE_A_MODEL_ESSAY', 3)
  }

  // TYPE_B: Import filtered
  for (const gd of typeBDocs.slice(0, 3)) {
    addFromManifest(gd, 'TYPE_B_IMPORT_FILTER', 2)
  }

  // Ensure coverage of high-risk patterns
  // Files matching high-risk pattern
  const highRiskFileDocs = allDocs.filter(d =>
    HIGH_FILE_PATTERN.test(d.fileName) && d.comments.length > 0
  )
  for (const doc of highRiskFileDocs.slice(0, 3)) {
    addFromManifest(doc, 'TYPE_A_MODEL_ESSAY', 1)
  }

  // Trim to 20 samples
  const samples20 = missingSignals.slice(0, 20)

  // ── ALL signals classification (for risk stats) ──────────────────────────────
  // Classify all 13,413 manifest comments to compute population-level stats
  const allSignals: SignalClassification[] = []
  for (const doc of allDocs) {
    let gapType: GapType
    if (doc.collection === 'MODEL_ESSAY') {
      gapType = 'TYPE_A_MODEL_ESSAY'
    } else {
      const db = dbByPath.get(doc.sourcePath)
      const annCount = db?._count.annotations ?? 0
      const mCount = doc.comments.length
      gapType = annCount < mCount ? 'TYPE_C_MIGRATE_INCOMPLETE' : 'COVERED'
    }
    for (const c of doc.comments) {
      allSignals.push(classifySignal(c, doc, gapType))
    }
  }

  // ── Sampling simulation ───────────────────────────────────────────────────────
  // Build signal list for sampling (use index into allSignals)
  const signalsForSampling: MissingSignal[] = allDocs.flatMap(doc => {
    const gapType: GapType = doc.collection === 'MODEL_ESSAY' ? 'TYPE_A_MODEL_ESSAY' : 'COVERED'
    return doc.comments.map(c => ({
      fileName: doc.fileName,
      collection: doc.collection,
      originalCommentId: c.commentId,
      anchorText: c.anchorText ?? '',
      feedbackSnippet: clip(c.feedback, 40),
      gapType,
      classification: classifySignal(c, doc, gapType),
    }))
  })
  const { sampled, stats: samplingStats } = applyStratifiedSampling(signalsForSampling)
  signalsForSampling.forEach((s, i) => { if (sampled.has(i)) s.classification.sampledForReview = true })

  // ── Priority distribution across all 13,413 ──────────────────────────────────
  const priDist: Record<ReviewPriority, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 }
  for (const s of allSignals) priDist[s.reviewPriority]++

  const slDist: Record<string, number> = {}
  const srDist: Record<string, number> = {}
  const trDist: Record<string, number> = {}
  for (const s of allSignals) {
    slDist[s.sourceLayer]  = (slDist[s.sourceLayer]  ?? 0) + 1
    srDist[s.semanticRole] = (srDist[s.semanticRole] ?? 0) + 1
    trDist[s.targetRole]   = (trDist[s.targetRole]   ?? 0) + 1
  }

  // ── Sampling coverage per layer/role ─────────────────────────────────────────
  const sampledByLayer: Record<string, number> = {}
  const sampledBySR: Record<string, number> = {}
  const sampledByTR: Record<string, number> = {}
  signalsForSampling.forEach(s => {
    if (s.classification.sampledForReview) {
      sampledByLayer[s.classification.sourceLayer] = (sampledByLayer[s.classification.sourceLayer] ?? 0) + 1
      sampledBySR[s.classification.semanticRole]   = (sampledBySR[s.classification.semanticRole]   ?? 0) + 1
      sampledByTR[s.classification.targetRole]     = (sampledByTR[s.classification.targetRole]     ?? 0) + 1
    }
  })

  // ── OUTPUT ───────────────────────────────────────────────────────────────────

  const hr = '─'.repeat(72)
  const eq = '═'.repeat(72)

  console.log(`\n${eq}`)
  console.log(`  ANNOTATION GAP RECONCILIATION — DRY-RUN（只读，不写数据库）`)
  console.log(`  时间: ${new Date().toISOString()}`)
  console.log(`${eq}\n`)

  // §1 Gap Summary
  console.log(`${eq}\n  §1  差额来源分析\n${eq}`)
  console.log(`manifest 总 comments:           ${allDocs.reduce((s,d)=>s+d.comments.length,0)}`)
  console.log(`DB KnowledgeAnnotation:         12440  (from migrate-annotations write runs)`)
  console.log(`差额:                            ${totalTypeA + totalTypeB + totalTypeC}`)
  console.log()
  console.log(`TYPE_A (MODEL_ESSAY, never imported):    ${totalTypeA}`)
  console.log(`  → import 脚本只为 TEACHER_REVIEW 创建 REVIEW_EXAMPLE chunks`)
  console.log(`  → 931 条 MODEL_ESSAY comments 从未进入 KnowledgeChunk/KnowledgeAnnotation`)
  console.log()
  console.log(`TYPE_B (TEACHER_REVIEW, import 过滤):   ${totalTypeB}`)
  console.log(`  → chunkText 为空或长度 <20，import 脚本跳过`)
  console.log()
  console.log(`TYPE_C (REVIEW_EXAMPLE chunk 未迁移):   ${totalTypeC}`)
  console.log(`  → migrate-annotations 已跑全量（ImportBatch id=1+3 共 12,440 条）`)
  console.log(`  → 剩余差额可能由 import 阶段计数差异导致`)
  console.log()
  console.log(`型别合计: ${totalTypeA}+${totalTypeB}+${totalTypeC} = ${totalTypeA+totalTypeB+totalTypeC}`)

  const gapDocsSorted = [...gapDocs].sort((a,b) => b.totalGap - a.totalGap)
  console.log(`\n差额文档 Top 15（按差额大小）:`)
  console.log(`  ${'文件名'.padEnd(38)} collection       manifest  chunk  annot  gap`)
  console.log(`  ${hr}`)
  for (const gd of gapDocsSorted.slice(0, 15)) {
    const name = gd.fileName.slice(0, 36).padEnd(36)
    const col = gd.collection === 'MODEL_ESSAY' ? 'MODEL_ESSAY    ' : 'TEACHER_REVIEW'
    console.log(`  ${name}  ${col}  ${String(gd.manifestCount).padStart(5)}  ${String(gd.reChunkCount).padStart(5)}  ${String(gd.annotationCount).padStart(5)}  ${gd.totalGap}`)
  }

  // §2 Risk Stratification (全量 13,413)
  console.log(`\n${eq}\n  §2  风险分层（全量 13,413 条 WORD_COMMENT 信号）\n${eq}`)
  const total = allSignals.length
  const pct = (n: number) => `${((n/total)*100).toFixed(1)}%`
  console.log(`总信号数:          ${total}`)
  console.log(`HIGH  (100%复核):  ${priDist.HIGH.toString().padStart(5)}  (${pct(priDist.HIGH)})`)
  console.log(`MEDIUM (抽样复核): ${priDist.MEDIUM.toString().padStart(5)}  (${pct(priDist.MEDIUM)})`)
  console.log(`LOW   (少量抽样):  ${priDist.LOW.toString().padStart(5)}  (${pct(priDist.LOW)})`)
  console.log(`NONE:              ${priDist.NONE.toString().padStart(5)}  (${pct(priDist.NONE)})`)
  console.log()
  console.log(`sampledForReview（模拟）: ${samplingStats.actual} / ${total} = ${samplingStats.pct}%  (目标≥30%)`)
  console.log(`HIGH 本身即占:           ${priDist.HIGH} / ${total} = ${pct(priDist.HIGH)}`)
  if (priDist.HIGH / total >= 0.30) {
    console.log(`  → HIGH 已超过 30%，分层采样策略自动满足目标（不强行裁减 HIGH）`)
  } else {
    console.log(`  → HIGH 不足 30%，将从 MEDIUM 补足`)
  }

  // §3 Per-layer coverage
  console.log(`\n${eq}\n  §3  分层覆盖统计\n${eq}`)
  console.log(`\nsourceLayer 分布 + 复核覆盖率:`)
  for (const [k, v] of Object.entries(slDist).sort(([,a],[,b])=>b-a)) {
    const s = sampledByLayer[k] ?? 0
    console.log(`  ${k.padEnd(26)} ${String(v).padStart(5)}  复核 ${String(s).padStart(5)}  (${((s/v)*100).toFixed(0)}%)`)
  }

  console.log(`\nsemanticRole 分布 + 复核覆盖率:`)
  for (const [k, v] of Object.entries(srDist).sort(([,a],[,b])=>b-a)) {
    const s = sampledBySR[k] ?? 0
    console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}  复核 ${String(s).padStart(5)}  (${((s/v)*100).toFixed(0)}%)`)
  }

  console.log(`\ntargetRole 分布 + 复核覆盖率:`)
  for (const [k, v] of Object.entries(trDist).sort(([,a],[,b])=>b-a)) {
    const s = sampledByTR[k] ?? 0
    console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}  复核 ${String(s).padStart(5)}  (${((s/v)*100).toFixed(0)}%)`)
  }

  // §4 20 missing samples
  console.log(`\n${eq}\n  §4  20 条缺失信号样例（优先覆盖各类型）\n${eq}`)
  console.log(`字段说明: [N] gapType | fileName (collection)`)
  console.log(`  originalCommentId | anchorText | feedbackSnippet`)
  console.log(`  sl=sourceLayer  sr=semanticRole  tr=targetRole  conf=confidence`)
  console.log(`  priority=reviewPriority  autoEligible  suitableForAnnotation  betterForRaw`)
  console.log(`  reasons: [highRiskReasons]`)
  console.log()

  for (const [i, s] of samples20.entries()) {
    const c = s.classification
    console.log(`[${String(i+1).padStart(2)}] ${s.gapType.padEnd(28)} | ${s.fileName.slice(0,38)} (${s.collection})`)
    console.log(`     commentId=${s.originalCommentId.padEnd(6)}  anchor="${clip(s.anchorText,30)}"`)
    console.log(`     feedback: "${s.feedbackSnippet}"`)
    console.log(`     sl=${c.sourceLayer.padEnd(20)}  sr=${c.semanticRole.padEnd(20)}  tr=${c.targetRole}`)
    console.log(`     conf=${c.confidence.toFixed(2)}  priority=${c.reviewPriority.padEnd(7)}  autoEligible=${c.autoEligible}`)
    console.log(`     suitable4Annot=${c.suitableForKnowledgeAnnotation}  betterForRaw=${c.betterForRawSignal}  needsReview=${c.needsManualReview}`)
    if (c.highRiskReasons.length > 0) {
      console.log(`     ⚠ HIGH RISK: ${c.highRiskReasons.join(' | ')}`)
    }
    console.log()
  }

  // §5 Human review sample table (10 representative from the 30% pool)
  console.log(`${eq}\n  §5  人工复核样本表（10 条代表性样本，来自 30% 复核池）\n${eq}`)
  console.log(`这 10 条是给你直接回答"是/否/?"的确认表\n`)

  const reviewSamples = signalsForSampling
    .filter(s => s.classification.sampledForReview)
    .sort((a,b) => {
      const order = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 }
      return order[a.classification.reviewPriority] - order[b.classification.reviewPriority]
    })
    .slice(0, 10)

  for (const [i, s] of reviewSamples.entries()) {
    const c = s.classification
    console.log(`┌─ 样本 ${String(i+1).padStart(2)} ──────────────────────────────────────────────────────────┐`)
    console.log(`│ 文件: ${s.fileName.slice(0,52)}`)
    console.log(`│ collection=${s.collection}  priority=${c.reviewPriority}  autoEligible=${c.autoEligible}`)
    console.log(`│ rawText(anchor): "${clip(s.anchorText, 50)}"`)
    console.log(`│ feedback: "${s.feedbackSnippet}"`)
    console.log(`│ predicted: sl=${c.sourceLayer}  sr=${c.semanticRole}  tr=${c.targetRole}`)
    console.log(`│`)
    console.log(`│ 请确认:`)
    console.log(`│   Q1 这段是学生作文错误批注？(Y/N/?)`)
    console.log(`│   Q2 这段是教师范文/教师改写？(Y/N/?)`)
    console.log(`│   Q3 这段是举一反三/拓展说明？(Y/N/?)`)
    console.log(`│   Q4 批注针对：词句(WORD/PHRASE) / 段落(PARA) / 整篇(ESSAY)？`)
    console.log(`│   Q5 应进入 KnowledgeAnnotation？(Y/N/?)`)
    console.log(`│   Q6 只作为教学材料保留？(Y/N/?)`)
    console.log(`│   Q7 与某个特定 essay 版本有关？(Y/N/?)`)
    console.log(`│   Q8 应排除出评估集？(Y/N/?)`)
    console.log(`└─────────────────────────────────────────────────────────────────────┘`)
    console.log()
  }

  // §6 Never-auto-convert summary
  console.log(`${eq}\n  §6  永远不自动转 KnowledgeAnnotation 的 signal 汇总\n${eq}`)
  const neverConvert = allSignals.filter(s => !s.autoEligible)
  const canConvert   = allSignals.filter(s => s.autoEligible)
  console.log(`autoEligible=true:  ${canConvert.length}  (${((canConvert.length/total)*100).toFixed(1)}%) — 未来可考虑自动转，但第一阶段仍不执行`)
  console.log(`autoEligible=false: ${neverConvert.length}  (${((neverConvert.length/total)*100).toFixed(1)}%) — 永远不自动转，保留为 RawAnnotationSignal`)
  console.log()
  console.log(`永不自动转的原因统计（多原因可重叠）:`)
  const reasonCounts: Record<string, number> = {}
  allSignals.filter(s => s.highRiskReasons.length > 0).forEach(s => {
    s.highRiskReasons.forEach(r => { reasonCounts[r] = (reasonCounts[r] ?? 0) + 1 })
  })
  for (const [r, n] of Object.entries(reasonCounts).sort(([,a],[,b])=>b-a)) {
    console.log(`  ${r.padEnd(40)} ${n}`)
  }

  console.log(`\n${eq}`)
  console.log(`  RECONCILIATION 完成。未写入任何数据。`)
  console.log(`  下一步: 确认方案 → db push → 建 RawAnnotationSignal 表 → 导入信号`)
  console.log(`${eq}\n`)
}

main()
  .catch(err => { console.error('Fatal:', err); process.exit(1) })
  .finally(() => prisma.$disconnect())
