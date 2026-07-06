/**
 * Read-only DOCX annotation signal audit (dry-run)
 *
 * Empirically answers:
 *   Q1. Does the pipeline read word/comments.xml?
 *   Q2. Does it preserve blue text (w:color)?
 *   Q3. Where do the 12,440 KnowledgeAnnotations come from?
 *   Q4. What annotation signals exist in DOCX but are NOT captured?
 *   Q5. Option A vs B for fixing the gap?
 *
 * NO WRITES — zero DB mutations.
 */

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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

interface DocxInspect {
  docxCommentCount: number
  totalTextRuns: number
  blueRuns: number
  colorValues: Record<string, number>
  blueExamples: string[]
  error?: string
}

interface DbStats {
  docId: number
  chunkTotal: number
  chunkReviewExample: number
  annotationCount: number
}

interface SampleResult {
  idx: number
  category: string
  fileName: string
  collection: string
  task: string | null
  rawTextChars: number
  paragraphCount: number
  manifestCommentCount: number
  docxCommentCount: number
  commentCountMatch: boolean
  totalTextRuns: number
  blueRuns: number
  bluePercent: number
  topColors: string
  blueExamples: string[]
  docxError?: string
  dbDocId: number
  dbChunkTotal: number
  dbChunkReviewExample: number
  dbAnnotationCount: number
  inlineAnnotationEst: number
  inlineExamples: string[]
  gaps: string[]
}

// ── Python DOCX Inspector ─────────────────────────────────────────────────────

// Inline Python code: parse DOCX ZIP directly, count word/comments.xml entries
// and detect runs with blue color properties (w:rPr/w:color).
const PYTHON_INSPECTOR = `
import sys, json
sys.stdout.reconfigure(encoding='utf-8')
from zipfile import ZipFile, BadZipFile
from xml.etree import ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WN = "{" + W + "}"

# Blue colors commonly used by teachers in Word
BLUE = {
    "0000ff","0070c0","4472c4","2e74b5","4f81bd",
    "1f497d","17375e","1f3864","003366","0563c1",
    "215868","1665c0","2f5496","003087",
}

result = {
    "docxCommentCount": 0,
    "totalTextRuns": 0,
    "blueRuns": 0,
    "colorValues": {},
    "blueExamples": [],
}

try:
    with ZipFile(sys.argv[1]) as z:
        doc = ET.fromstring(z.read("word/document.xml"))
        if "word/comments.xml" in z.namelist():
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
        cel = rpr.find(f"{WN}color")
        if cel is None:
            continue
        val = (cel.get(f"{WN}val") or "").strip().lower().lstrip("#")
        if not val or val == "auto":
            continue
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
  const p = path.join(os.tmpdir(), 'ielts_audit_inspector_v6.py')
  fs.writeFileSync(p, PYTHON_INSPECTOR, 'utf8')
  return p
}

function inspectDocx(pyFile: string, docxPath: string): DocxInspect {
  try {
    const out = execFileSync('python', [pyFile, docxPath], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    return JSON.parse(out.trim()) as DocxInspect
  } catch (err) {
    return {
      docxCommentCount: 0,
      totalTextRuns: 0,
      blueRuns: 0,
      colorValues: {},
      blueExamples: [],
      error: String(err).slice(0, 120),
    }
  }
}

// ── Sample Selection (stratified) ────────────────────────────────────────────

function selectSamples(docs: ManifestDoc[]): Array<ManifestDoc & { sampleCategory: string }> {
  const teacher = docs.filter(d => d.collection === 'TEACHER_REVIEW')
  const model   = docs.filter(d => d.collection === 'MODEL_ESSAY')
  const sorted  = [...teacher].sort((a, b) => b.comments.length - a.comments.length)

  const seen   = new Set<string>()
  const result: Array<ManifestDoc & { sampleCategory: string }> = []

  const add = (d: ManifestDoc, cat: string) => {
    if (!seen.has(d.sourcePath) && result.length < 20) {
      seen.add(d.sourcePath)
      result.push({ ...d, sampleCategory: cat })
    }
  }

  // A: TEACHER_REVIEW — highest comment count (top 5)
  sorted.slice(0, 5).forEach(d => add(d, 'A_HIGH_COMMENT'))

  // B: TEACHER_REVIEW — medium comment count (4 docs at ~50th percentile)
  const mid = Math.floor(sorted.length / 2)
  sorted.slice(mid, mid + 4).forEach(d => add(d, 'B_MED_COMMENT'))

  // C: TEACHER_REVIEW — very low comment count (1–3 comments, 3 docs)
  sorted
    .filter(d => d.comments.length >= 1 && d.comments.length <= 3)
    .slice(0, 3)
    .forEach(d => add(d, 'C_LOW_COMMENT'))

  // D: TEACHER_REVIEW — zero comments (3 docs)
  sorted
    .filter(d => d.comments.length === 0)
    .slice(0, 3)
    .forEach(d => add(d, 'D_NO_COMMENT'))

  // E: MODEL_ESSAY (5 docs)
  model.slice(0, 5).forEach(d => add(d, 'E_MODEL_ESSAY'))

  return result
}

// ── DB Queries ────────────────────────────────────────────────────────────────

async function loadDbStats(sourcePaths: string[]): Promise<Map<string, DbStats>> {
  const dbDocs = await prisma.knowledgeDocument.findMany({
    where: { fileUrl: { in: sourcePaths } },
    select: {
      id: true,
      fileUrl: true,
      _count: { select: { chunks: true, annotations: true } },
    },
  })

  const docIds = dbDocs.map(d => d.id)
  const reCounts = await prisma.knowledgeChunk.groupBy({
    by: ['documentId'],
    where: { documentId: { in: docIds }, chunkType: 'REVIEW_EXAMPLE' },
    _count: { id: true },
  })
  const reMap = new Map(reCounts.map(r => [r.documentId, r._count.id]))

  const out = new Map<string, DbStats>()
  for (const d of dbDocs) {
    if (d.fileUrl) {
      out.set(d.fileUrl, {
        docId: d.id,
        chunkTotal: d._count.chunks,
        chunkReviewExample: reMap.get(d.id) ?? 0,
        annotationCount: d._count.annotations,
      })
    }
  }
  return out
}

async function loadGlobalAnnotationStats() {
  const total = await prisma.knowledgeAnnotation.count()
  const byAnchorType = await prisma.knowledgeAnnotation.groupBy({
    by: ['anchorType'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  })
  const byIssueType = await prisma.knowledgeAnnotation.groupBy({
    by: ['issueType'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  })
  const reviewExampleChunks = await prisma.knowledgeChunk.count({
    where: { chunkType: 'REVIEW_EXAMPLE' },
  })
  return { total, byAnchorType, byIssueType, reviewExampleChunks }
}

// ── Inline Annotation Heuristic ───────────────────────────────────────────────

function estimateInlineAnnotations(doc: ManifestDoc): { count: number; examples: string[] } {
  if (doc.collection !== 'TEACHER_REVIEW') return { count: 0, examples: [] }

  const cjkRatio = (s: string) =>
    (s.match(/[㐀-鿿⺀-⻿豈-﫿]/g)?.length ?? 0) / Math.max(1, s.length)

  let count = 0
  const examples: string[] = []

  for (const p of doc.paragraphs) {
    const t = p.trim()
    if (!t) continue
    // Paragraphs that are short (<= 120 chars) and >40% CJK are likely
    // inline teacher notes intermixed with student essay content.
    if (t.length <= 120 && cjkRatio(t) > 0.40) {
      count++
      if (examples.length < 3) examples.push(t.slice(0, 60))
    }
  }
  return { count, examples }
}

// ── Build Sample Result ────────────────────────────────────────────────────────

function buildSampleResult(
  idx: number,
  doc: ManifestDoc & { sampleCategory: string },
  insp: DocxInspect,
  db: DbStats | undefined,
): SampleResult {
  const dbS = db ?? { docId: -1, chunkTotal: 0, chunkReviewExample: 0, annotationCount: 0 }
  const { count: inlineCount, examples: inlineExamples } = estimateInlineAnnotations(doc)

  const bluePercent = insp.totalTextRuns > 0
    ? (insp.blueRuns / insp.totalTextRuns) * 100
    : 0

  const topColors = Object.entries(insp.colorValues)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ')

  const gaps: string[] = []
  if (insp.blueRuns > 0)
    gaps.push(`BLUE_TEXT(${insp.blueRuns} runs — color info lost in pipeline)`)
  if (inlineCount > 0)
    gaps.push(`INLINE_NOTES(~${inlineCount} short CJK paragraphs mixed into rawText)`)
  if (insp.docxCommentCount !== doc.comments.length && !insp.error)
    gaps.push(`COMMENT_COUNT_MISMATCH(docx=${insp.docxCommentCount} manifest=${doc.comments.length})`)

  return {
    idx,
    category: doc.sampleCategory,
    fileName: doc.fileName,
    collection: doc.collection,
    task: doc.task,
    rawTextChars: doc.stats.characters,
    paragraphCount: doc.paragraphs.length,
    manifestCommentCount: doc.comments.length,
    docxCommentCount: insp.docxCommentCount,
    commentCountMatch: !insp.error && insp.docxCommentCount === doc.comments.length,
    totalTextRuns: insp.totalTextRuns,
    blueRuns: insp.blueRuns,
    bluePercent,
    topColors,
    blueExamples: insp.blueExamples,
    docxError: insp.error,
    dbDocId: dbS.docId,
    dbChunkTotal: dbS.chunkTotal,
    dbChunkReviewExample: dbS.chunkReviewExample,
    dbAnnotationCount: dbS.annotationCount,
    inlineAnnotationEst: inlineCount,
    inlineExamples,
    gaps,
  }
}

// ── Formatting Helpers ────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  if (d === 0) return 'N/A'
  return `${((n / d) * 100).toFixed(0)}%`
}

function padR(s: string, n: number) { return s.padEnd(n) }
function padL(s: string, n: number) { return s.padStart(n) }

// ── Print: Section 1 — Pipeline Code Analysis ────────────────────────────────

function printSection1() {
  console.log(`
${'═'.repeat(72)}
  §1  PIPELINE CODE ANALYSIS（基于源码，非推断）
${'═'.repeat(72)}

脚本调用链：
  [1] extract-ai-review-experiment.py   ← 提取 DOCX → manifest.json
  [2] import-ai-review-experiment.ts    ← manifest.json → DB (KnowledgeChunk)
  [3] migrate-annotations-dry-run.ts    ← REVIEW_EXAMPLE chunks → KnowledgeAnnotation

────────────────────────────────────────────────────────────────────────
Q1  word/comments.xml  是否被读取？   ✅ YES

    extract-ai-review-experiment.py:48-57  load_comments():
      ① ZipFile.namelist() 检查 "word/comments.xml" 是否存在
      ② ET.fromstring() 解析所有 <w:comment> 元素
      ③ 提取 commentId, 每个 comment 的纯文本 (node_text)
      ④ extract_document() 遍历段落中 commentRangeStart/End，
         捕获 anchorText（被圈住的原文）
      ⑤ 存入 manifest.json 的 documents[N].comments[] 数组

    import-ai-review-experiment.ts:92-109  makeChunks():
      ① 读取 document.comments[]
      ② 每条生成一个 KnowledgeChunk(chunkType=REVIEW_EXAMPLE)
         chunkText 格式 = "[学生原文]\\n{anchor}\\n\\n[教师反馈]\\n{feedback}"

    migrate-annotations-dry-run.ts:306-311:
      ① 读取 chunkType=REVIEW_EXAMPLE 的 KnowledgeChunk
      ② 解析 [学生原文]/[教师反馈] 标记
      ③ 写入 KnowledgeAnnotation（commentId="mv6-{8位hash}"）

    结论：Word 右侧 comments → manifest.json → REVIEW_EXAMPLE chunk
          → KnowledgeAnnotation，链路完整。

────────────────────────────────────────────────────────────────────────
Q2  蓝色文字（w:color）是否被保留？   ❌ NO

    node_text() 函数（第 36-45 行）仅处理：
      w:t, w:tab, w:br, w:cr

    从不读取：
      w:rPr（run 属性）
      w:color（文字颜色）
      w:highlight（高亮）
      w:bold / w:italic / w:underline

    结果：蓝色文字的文字内容进入了 rawText，
    但颜色/样式信息在 extract 阶段 100% 丢失，
    无法从 manifest.json 或数据库中恢复。

────────────────────────────────────────────────────────────────────────
Q3  12,440 条 KnowledgeAnnotation 来自何处？

    全部来自 REVIEW_EXAMPLE chunks（即 Word 右侧 comments 的结构化版本）
    链路：word/comments.xml → manifest.comments[]
          → KnowledgeChunk(REVIEW_EXAMPLE)
          → KnowledgeAnnotation

    commentId 格式 = "mv6-{sha256(chunkId|anchor|feedback).slice(0,8)}"
    （非 Word 原始 comment ID，是 migrate 脚本的内容哈希）

    manifest 总 comments = 13,413
    DB KnowledgeAnnotation ≈ 12,440
    差额 ≈ 973 条 ← migrate 默认 SAMPLE_LIMIT=500（dry-run），
                     需 --full 才处理全量

────────────────────────────────────────────────────────────────────────
Q4  当前未捕获的 annotation signal 类型：

    ❌ 蓝色文字（w:color 着色，教师改写/标注/强调的核心信号）
    ❌ 行内教师批注（写在文档正文而非 comment 框，混入 rawText）
    ❌ 高亮文字（w:highlight，教师用颜色标出关注区域）
    ❌ 删除线（w:strike，教师划掉的原文）
    ❌ Comment 作者/时间戳（谁注释、何时注释）
    ❌ Comment 回复链（学生/教师间的往返讨论）
    ❌ 段落内 startOffset/endOffset（仅有 paragraphIndex，无字符位置）
    ❌ 字体变化（w:rFonts）带来的视觉区分信号
`)
}

// ── Print: Section 2 — Manifest Stats ────────────────────────────────────────

function printSection2(docs: ManifestDoc[], annoStats: Awaited<ReturnType<typeof loadGlobalAnnotationStats>>) {
  const tr = docs.filter(d => d.collection === 'TEACHER_REVIEW')
  const me = docs.filter(d => d.collection === 'MODEL_ESSAY')
  const trWithC = tr.filter(d => d.comments.length > 0)
  const totalC = docs.reduce((s, d) => s + d.comments.length, 0)
  const avgC = trWithC.length > 0
    ? (trWithC.reduce((s, d) => s + d.comments.length, 0) / trWithC.length).toFixed(1)
    : '0'

  // Bucket distribution
  const buckets: [string, number][] = [
    ['0', tr.filter(d => d.comments.length === 0).length],
    ['1–10', tr.filter(d => d.comments.length >= 1 && d.comments.length <= 10).length],
    ['11–30', tr.filter(d => d.comments.length >= 11 && d.comments.length <= 30).length],
    ['31–50', tr.filter(d => d.comments.length >= 31 && d.comments.length <= 50).length],
    ['51–70', tr.filter(d => d.comments.length >= 51 && d.comments.length <= 70).length],
    ['71+', tr.filter(d => d.comments.length >= 71).length],
  ]

  console.log(`
${'═'.repeat(72)}
  §2  MANIFEST.JSON + DATABASE 全局统计
${'═'.repeat(72)}

manifest.json:
  总文档数              ${docs.length}
    TEACHER_REVIEW      ${tr.length}
    MODEL_ESSAY         ${me.length}
  总 comments 数        ${totalC}
  有 comments 的文档    ${trWithC.length} / ${tr.length} (TEACHER_REVIEW)
  无 comments 的文档    ${tr.length - trWithC.length} / ${tr.length}
  每文档平均 comments   ${avgC} 条（仅统计有 comment 的文档）

  TEACHER_REVIEW comment 数量分布：
${buckets.map(([label, cnt]) => `    ${padR(label, 8)} ${cnt} 文档  ${'█'.repeat(Math.round(cnt / 3))}`).join('\n')}

DATABASE (KnowledgeAnnotation 全局):
  总 KnowledgeAnnotation  ${annoStats.total}
  总 REVIEW_EXAMPLE chunks ${annoStats.reviewExampleChunks}

  manifest 总 comments    ${totalC}
  DB annotations          ${annoStats.total}
  缺口                    ${totalC - annoStats.total}
    ← migrate-annotations --full 尚未运行（默认 SAMPLE_LIMIT=500 dry-run）

  anchorType 分布:
${annoStats.byAnchorType.map(r => `    ${padR(String(r.anchorType), 14)} ${padL(String(r._count.id), 6)}`).join('\n')}

  issueType 分布 (top 8):
${annoStats.byIssueType.slice(0, 8).map(r => `    ${padR(String(r.issueType ?? 'null'), 16)} ${padL(String(r._count.id), 6)}`).join('\n')}
`)
}

// ── Print: Section 3 — Sample Audits ─────────────────────────────────────────

function printSection3(samples: SampleResult[]) {
  console.log(`${'═'.repeat(72)}
  §3  20 样本 DOCX 直接解析（原始 ZIP，不依赖 manifest 缓存）
${'═'.repeat(72)}
列说明:  [N] CATEGORY | fileName
         collection  task  rawTextChars  paragraphs
         ── manifest comments | docx comments (match?)
         ── DB: docId  chunks  REVIEW_EXAMPLE  annotations
         ── comment→annotation coverage
         ── blue: blueRuns/totalRuns (%)  topColors  captured=NO
         ── inline teacher paragraphs (heuristic): ~N
`)

  for (const s of samples) {
    const commentMatch = s.docxError ? '⚠ inspect_err' : s.commentCountMatch ? '✅ match' : '❗ MISMATCH'
    const coverageStr = s.manifestCommentCount > 0
      ? `${s.dbAnnotationCount}/${s.manifestCommentCount} (${pct(s.dbAnnotationCount, s.manifestCommentCount)})`
      : `${s.dbAnnotationCount}/0`

    console.log(`[${String(s.idx).padStart(2, '0')}] ${padR(s.category, 16)} | ${s.fileName.slice(0, 46)}`)
    console.log(`     collection=${s.collection}  task=${s.task ?? 'null'}  chars=${s.rawTextChars}  ¶=${s.paragraphCount}`)
    console.log(`     ── manifest comments: ${s.manifestCommentCount}  |  docx comments: ${s.docxCommentCount}  ${commentMatch}`)
    console.log(`     ── DB: id=${s.dbDocId}  chunks=${s.dbChunkTotal}  RE=${s.dbChunkReviewExample}  annotations=${s.dbAnnotationCount}`)
    console.log(`     ── comment→annotation coverage: ${coverageStr}`)
    console.log(`     ── blue: ${s.blueRuns}/${s.totalTextRuns} runs (${s.bluePercent.toFixed(1)}%)  colors=[${s.topColors || 'none'}]  captured=NO`)
    console.log(`     ── inline ~${s.inlineAnnotationEst} short CJK ¶s`)

    if (s.blueExamples.length > 0) {
      console.log(`     ── blue text examples: "${s.blueExamples.map(e => e.slice(0, 40)).join('" | "')}"`)
    }
    if (s.inlineExamples.length > 0) {
      console.log(`     ── inline examples: "${s.inlineExamples.map(e => e.slice(0, 40)).join('" | "')}"`)
    }
    if (s.docxError) {
      console.log(`     ── ❗ inspect error: ${s.docxError.slice(0, 80)}`)
    }
    if (s.gaps.length > 0) {
      console.log(`     ── GAPS: ${s.gaps.join('  |  ')}`)
    }
    console.log()
  }
}

// ── Print: Section 4 — Coverage Summary ──────────────────────────────────────

function printSection4(samples: SampleResult[], allDocs: ManifestDoc[]) {
  const teacherSamples = samples.filter(s => s.collection === 'TEACHER_REVIEW')
  const withBlue = samples.filter(s => s.blueRuns > 0)
  const totalBlueRuns = samples.reduce((s, r) => s + r.blueRuns, 0)
  const totalRuns = samples.reduce((s, r) => s + r.totalTextRuns, 0)

  const commentMatchCount = samples.filter(s => !s.docxError && s.commentCountMatch).length
  const hasInspectError = samples.filter(s => !!s.docxError).length

  const totalManifestComments = allDocs.reduce((s, d) => s + d.comments.length, 0)

  console.log(`
${'═'.repeat(72)}
  §4  ANNOTATION SIGNAL 覆盖率总结
${'═'.repeat(72)}

┌─────────────────────────────────────┬────────────┬──────────────────┐
│ Signal 类型                          │ 是否被捕获 │ 覆盖情况         │
├─────────────────────────────────────┼────────────┼──────────────────┤
│ Word 右侧 comments (word/comments)  │ ✅ YES     │ ${padR(`${totalManifestComments} → ${totalManifestComments} in manifest`, 16)} │
│ comments → KnowledgeAnnotation      │ ✅ 部分    │ 待 --full 完成   │
│ 蓝色文字 (w:color)                  │ ❌ NO      │ 0% (信号丢失)   │
│ 行内教师批注（正文中）              │ ❌ 无区分  │ 混入 rawText     │
│ 高亮文字 (w:highlight)              │ ❌ NO      │ 0% (信号丢失)   │
│ 删除线 (w:strike)                   │ ❌ NO      │ 0% (信号丢失)   │
│ 段内字符偏移 (start/endOffset)      │ ❌ 未提取  │ paragraphIndex 有│
│ Comment 作者/时间戳                  │ ❌ NO      │ 未存储           │
└─────────────────────────────────────┴────────────┴──────────────────┘

蓝色文字：20 样本中发现蓝色 text run 的文档数 = ${withBlue.length}/${samples.length}
  总蓝色 runs = ${totalBlueRuns}，总 text runs = ${totalRuns}
  蓝色占比 = ${totalRuns > 0 ? ((totalBlueRuns / totalRuns) * 100).toFixed(1) : 0}%（在 20 样本中）

comments 一致性验证：
  manifest 与 DOCX 直接解析一致 = ${commentMatchCount}/${samples.length - hasInspectError}
  解析报错 = ${hasInspectError}

⚠ 重要约束（用户已确认）：
  - 蓝色文字 ≠ 错误，只代表"教师触碰/修改/标注/强调"，含义由上下文决定
  - 右侧 comments 和蓝色文字 ≠ 已被完整处理（当前只处理了前者）
  - 行内批注与学生正文混在 rawText 中，当前无法自动区分
`)
}

// ── Print: Section 5 — Human Confirmation Table ──────────────────────────────

function printSection5(samples: SampleResult[]) {
  console.log(`
${'═'.repeat(72)}
  §5  人工确认表（每样本 11 个问题）
${'═'.repeat(72)}

请填写下表，每格回答：Y(是) / N(否) / ? (不确定) / 填写具体数字

┌────┬──────────────────────────────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐
│ #  │ 文件名 (截断至26字符)         │ Q1 │ Q2 │ Q3 │ Q4 │ Q5 │ Q6 │ Q7 │ Q8 │ Q9 │Q10 │Q11 │
├────┼──────────────────────────────┼────┼────┼────┼────┼────┼────┼────┼────┼────┼────┼────┤`)

  for (const s of samples) {
    const name = s.fileName.slice(0, 26).padEnd(26)
    console.log(`│${padL(String(s.idx), 3)} │ ${name} │    │    │    │    │    │    │    │    │    │    │    │`)
  }

  console.log(`└────┴──────────────────────────────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘

问题说明（11列对应）:
  Q1: 该文件的蓝色文字（如有）是教师改写/强调，还是其他含义？(改写=R / 强调=E / 无蓝色=N / 混合=M)
  Q2: 除 Word 右侧 comments 外，是否有行内批注（直接写在正文）？(Y/N/?)
  Q3: 该文件是否包含多篇作文（而非单篇）？(Y/N/?)
  Q4: 学生作文是否完整（有引言+主体+结尾）？(Y/N/PARTIAL)
  Q5: 是否有 IELTS 题目/题干？(Y/N/?)
  Q6: 批注是否针对词/短语（非整段）？(Y=词级 / N=段级 / MIXED)
  Q7: 蓝色文字是否与 Word comment 的 anchor 有重叠？(Y/N/?)
  Q8: 文件名/内容是否含版本标记（初稿/修改稿/范文）？(Y/N/?)
  Q9: 该文件是否是教学笔记/讲义而非真实作文？(Y/N/?)
  Q10: 该文件是否应排除在 RAG 之外？(Y/N/MAYBE)
  Q11: 其他发现（简短文字）
`)
}

// ── Print: Section 6 — Schema Recommendation ──────────────────────────────────

function printSection6() {
  console.log(`
${'═'.repeat(72)}
  §6  SCHEMA 方案比较：Option A vs Option B
${'═'.repeat(72)}

当前问题：蓝色文字信号 + 行内批注 未被结构化存储。
两种修复思路：

────────────────────────────────────────────────────────────────────────
Option A：扩展 KnowledgeAnnotation 表，增加新字段

  新字段建议：
    sourceLayer    String?  // "WORD_COMMENT" | "BLUE_TEXT" | "INLINE_PARAGRAPH" | "HIGHLIGHT"
    annotationScope String? // "WORD" | "PHRASE" | "SENTENCE" | "PARAGRAPH" | "ESSAY"
    colorCode      String?  // 原始颜色值（如 "0070c0"）
    authorName     String?  // comment 作者（Word 元数据）
    commentedAt    DateTime? // comment 创建时间

  优点：
    ✅ 不增加新表，JOIN 简单
    ✅ KnowledgeAnnotation 语义一致（"一条批注"）
    ✅ 迁移路径清晰：补充现有 WORD_COMMENT 的字段 + 新增 BLUE_TEXT 记录

  缺点：
    ❌ 表变宽（~5 新字段），NULL 比率高
    ❌ "BLUE_TEXT" 记录没有 commentId/feedback，结构不同于 WORD_COMMENT
    ❌ 若后续还有新 signal（图片批注、笔迹等），表会持续变宽

────────────────────────────────────────────────────────────────────────
Option B：新建 RawAnnotationSignal 表（原始信号层）

  表结构：
    id            Int      @id @default(autoincrement())
    documentId    Int
    signalType    String   // "WORD_COMMENT" | "BLUE_RUN" | "INLINE_PARA" | "HIGHLIGHT"
    colorCode     String?  // 仅 BLUE_RUN
    anchorText    String?  // 被标注的原文
    feedbackText  String?  // 仅 WORD_COMMENT
    paragraphIdx  Int?
    runIdx        Int?
    authorName    String?
    commentedAt   DateTime?
    rawXmlRef     String?  // word/document.xml 的 xpath（可选）
    importBatchId Int?
    createdAt     DateTime @default(now())

  优点：
    ✅ 保留原始信号，零信息损失
    ✅ 不污染已结构化的 KnowledgeAnnotation
    ✅ 可作为"待处理原料"，渐进式解析

  缺点：
    ❌ 增加一张表，JOIN 变多
    ❌ 与 KnowledgeAnnotation 的关系需要额外建模（1:N mapping 表？）
    ❌ 工程量较大（需同时修改 Python 脚本 + 新建 importBatch 流程）

────────────────────────────────────────────────────────────────────────
推荐方案：

  近期（当前目标）：
    ✅ 推荐 Option A（扩展 KnowledgeAnnotation）
    理由：当前核心任务是让 Word comments 覆盖到 KnowledgeAnnotation，
    蓝色文字还需人工样本确认含义才能写入。
    先补 sourceLayer + annotationScope 两个字段，成本低、风险小。

  中期（如需保留原始信号）：
    ✅ 推荐 Option B，但仅在 Python extract 阶段就记录（而非后处理）
    即：在 extract-ai-review-experiment.py 解析时同步提取蓝色 run 并存
    入 manifest.json 的新字段，然后 import 时写入新表。

  当前操作：两者都不执行，等人工确认（§5）结果后再决定。
`)
}

// ── Print: Section 7 — KnowledgeEssayUnit Recommendation ─────────────────────

function printSection7() {
  console.log(`
${'═'.repeat(72)}
  §7  KnowledgeEssayUnit 表：是否需要？
${'═'.repeat(72)}

背景：KnowledgeDocument 当前既是"文件容器"又被视为"一篇作文"，
这两个角色不一致（一个 Word 文件可能含多篇作文、多版本、教学笔记）。

是否需要新增 KnowledgeEssayUnit 表（每行 = 一篇作文的逻辑单元）？

────────────────────────────────────────────────────────────────────────
需要 KnowledgeEssayUnit 的场景：

  ① 同一文件含多篇作文（RAG 应按作文检索，而非按文件）
  ② 同题多版本（初稿/修改稿/范文需关联到同一 promptHash）
  ③ 评估集 holdout 需要以"作文"为单位分层采样（非文件）
  ④ completenessStatus / contentRole 应是作文级别属性，非文件级别

不需要 KnowledgeEssayUnit 的场景（当前可先不加）：

  ① analyze-essay-units-dry-run.ts 结果：只有 10 个 HIGH 置信度多作文文件
     (MEDIUM 222 个大多是误报，真实多作文文件很少)
  ② 当前 RAG 以 KnowledgeChunk 为检索单元（已经细粒度了）
  ③ 引入新表会带来大量外键/迁移工作，而收益未经验证

────────────────────────────────────────────────────────────────────────
结论（暂定）：

  ❌ 暂不新增 KnowledgeEssayUnit 表

  理由：
    1. 真正的多作文文件数很少（~10 个 HIGH confidence）
    2. 先通过 qualityNotes + completenessStatus 在文件级别标注
    3. 等人工确认（§5 Q3、Q8）结果后，如多作文比例高，再引入

  如果后续需要，最小 schema：
    model KnowledgeEssayUnit {
      id             Int     @id @default(autoincrement())
      documentId     Int
      unitIndex      Int     // 同文件第 N 篇作文
      promptText     String? @db.Text
      promptHash     String?
      essayText      String  @db.LongText
      essayTextHash  String?
      contentRole    String?
      completenessStatus String?
      startCharOffset Int?
      endCharOffset   Int?
      createdAt      DateTime @default(now())
      document KnowledgeDocument @relation(...)
    }
`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const manifestPath = path.resolve('data/ai-review-experiment/manifest.json')
  if (!fs.existsSync(manifestPath)) {
    console.error('manifest.json not found at', manifestPath)
    process.exit(1)
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const allDocs: ManifestDoc[] = manifest.documents

  console.log(`\n${'═'.repeat(72)}`)
  console.log(`  DOCX ANNOTATION SIGNAL AUDIT — DRY-RUN（只读，不写数据库）`)
  console.log(`  运行时间: ${new Date().toISOString()}`)
  console.log(`  manifest: ${allDocs.length} 文档，${manifest.summary.comments} 条 comments`)
  console.log(`${'═'.repeat(72)}\n`)

  // Select 20 samples
  const sampledDocs = selectSamples(allDocs)
  console.log(`选取 ${sampledDocs.length} 个样本（分层抽样）`)

  // Write Python helper
  const pyFile = writePythonHelper()

  // Load DB stats for all samples
  console.log('查询数据库...')
  const dbMap = await loadDbStats(sampledDocs.map(d => d.sourcePath))
  const annoStats = await loadGlobalAnnotationStats()
  console.log(`DB 查询完成：找到 ${dbMap.size}/${sampledDocs.length} 个文档的 DB 记录`)

  // Inspect each sample DOCX directly
  console.log('解析 DOCX 文件（检测蓝色文字和 comments.xml）...')
  const sampleResults: SampleResult[] = []
  for (const [i, doc] of sampledDocs.entries()) {
    process.stdout.write(`  [${String(i + 1).padStart(2)}/${sampledDocs.length}] ${doc.fileName.slice(0, 40)}\r`)
    const insp = inspectDocx(pyFile, doc.sourcePath)
    const db = dbMap.get(doc.sourcePath)
    sampleResults.push(buildSampleResult(i + 1, doc, insp, db))
  }
  console.log('\nDOCX 解析完成。')

  // Cleanup Python temp file
  try { fs.unlinkSync(pyFile) } catch {}

  // Print all sections
  printSection1()
  printSection2(allDocs, annoStats)
  printSection3(sampleResults)
  printSection4(sampleResults, allDocs)
  printSection5(sampleResults)
  printSection6()
  printSection7()

  console.log(`\n${'═'.repeat(72)}`)
  console.log(`  AUDIT 完成。未写入任何数据。`)
  console.log(`${'═'.repeat(72)}\n`)
}

main()
  .catch(err => {
    console.error('Fatal:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
