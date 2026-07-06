/**
 * Read-only comprehensive source-file status audit — dry-run
 *
 * §1  Source file existence check (all 535 manifest docs)
 * §2  STALE records (source deleted, DB/manifest still has records)
 * §3  Assignment-pattern files full inventory
 * §4  DROP classification (HIGH / MEDIUM / DO_NOT_DROP)
 * §5  Unimported .docx files in source directories
 * §6  Human confirmation table
 *
 * Python DOCX inspection runs on zero-comment files to check for
 * colored / blue / highlight text — a key signal for teacher-written content.
 *
 * NO WRITES — never touches any DB table, manifest, or file.
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

type DropCategory = 'DROP_HIGH_CONFIDENCE' | 'DROP_MEDIUM_CONFIDENCE' | 'DO_NOT_DROP' | 'STALE_SOURCE' | 'NORMAL'

interface AuditRecord {
  fileName: string
  collection: string
  sourceType: string
  documentId: number | null
  sourcePath: string
  fileUrl: string
  // Source existence
  sourceFileExists: boolean
  // Manifest
  manifestExists: boolean
  manifestCommentCount: number
  rawTextLength: number
  task: string | null
  // DB
  dbExists: boolean
  chunkCount: number
  annotationCount: number
  embeddingCount: number
  // DOCX inspection
  inspected: boolean
  docxCommentCount: number
  coloredRunCount: number
  blueRunCount: number
  highlightCount: number
  inspectionError: string | null
  // Classification
  matchesAssignmentPattern: boolean
  assignmentPatternTag: string
  hasTeacherSignal: boolean
  isManualOverride: boolean
  overrideRole: string | null
  dropCategory: DropCategory
  reasons: string[]
  riskNote: string
  recommendation: string
  confirmQuestions: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual override registry
// ─────────────────────────────────────────────────────────────────────────────

const MANUAL_OVERRIDES: Record<string, { role: string; doNotDrop: boolean; notes: string }> = {
  'ran 双边.docx':       { role: 'TEACHING_NOTE',             doNotDrop: true, notes: '人工确认教学材料' },
  'may 程度同意2.docx':   { role: 'TEACHING_NOTE',             doNotDrop: true, notes: '人工确认教学材料' },
  'joan 拓展2.docx':     { role: 'EXAMPLE_EXTENSION',         doNotDrop: true, notes: '人工确认教学材料' },
  '大作文作业2 z.docx':   { role: 'HIGH_VALUE_STUDENT_REVIEW', doNotDrop: true, notes: '人工确认高价值学生批改材料，DO_NOT_DROP' },
}

// ─────────────────────────────────────────────────────────────────────────────
// Patterns
// ─────────────────────────────────────────────────────────────────────────────

// Broad assignment / numbered-essay detection (for candidate listing only — NOT for dropping)
const ASSIGNMENT_PATTERN = /大作文作业|小作文作业|作业|\d{1,2}[.月\-]\d{1,2}[日号]?\s*(大作文|小作文)|大作文\d+|小作文\d+|\d+大作文|\d+小作文/

function assignmentPatternTag(fileName: string): string {
  if (/大作文作业/.test(fileName)) return 'EXPLICIT_HW_LARGE'
  if (/小作文作业/.test(fileName)) return 'EXPLICIT_HW_SMALL'
  if (/作业/.test(fileName))       return 'CONTAINS_HW'
  if (/\d{1,2}[.月\-]\d{1,2}[日号]?\s*(大作文|小作文)/.test(fileName)) return 'DATE_ESSAY'
  if (/大作文\d+|\d+大作文/.test(fileName)) return 'NUMBERED_LARGE'
  if (/小作文\d+|\d+小作文/.test(fileName)) return 'NUMBERED_SMALL'
  return ''
}

const TEACHER_SIGNAL_KW = [
  '建议','改成','表达','逻辑','结构','语法','词汇','这里','这个','重写','注意',
  '错误','修改','标注','改正','替换','换成','不对','有问题','点评','批改','评语',
  '总结','加上','删掉','语法错误','可以改','这段','这句',
]

// ─────────────────────────────────────────────────────────────────────────────
// Python DOCX inspector
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

result = {"docxCommentCount":0,"totalTextRuns":0,"blueRuns":0,"coloredRuns":0,"highlightRuns":0,"colorValues":{},"blueExamples":[]}

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
                if not text: continue
                result["totalTextRuns"] += 1
                rpr = run.find(f"{WN}rPr")
                if rpr is None: continue
                hl = rpr.find(f"{WN}highlight")
                if hl is not None: result["highlightRuns"] += 1
                cel = rpr.find(f"{WN}color")
                if cel is None: continue
                val = (cel.get(f"{WN}val") or "").strip().lower().lstrip("#")
                if not val or val == "auto": continue
                result["coloredRuns"] += 1
                result["colorValues"][val] = result["colorValues"].get(val, 0) + 1
                if val in BLUE:
                    result["blueRuns"] += 1
                    if len(result["blueExamples"]) < 2:
                        result["blueExamples"].append(text[:60])
except BadZipFile:
    result["error"] = "bad_zip"
except Exception as e:
    result["error"] = str(e)[:120]

print(json.dumps(result, ensure_ascii=False))
`

function writePy(): string {
  const p = path.join(os.tmpdir(), 'ielts_status_audit_v6.py')
  fs.writeFileSync(p, PYTHON_INSPECTOR, 'utf8')
  return p
}

function inspectDocx(pyFile: string, docxPath: string): DocxInspect {
  try {
    const out = execFileSync('python', [pyFile, docxPath], { encoding: 'utf8', timeout: 15_000 })
    const r = JSON.parse(out.trim()) as DocxInspect
    r.coloredRuns  ??= 0
    r.highlightRuns ??= 0
    return r
  } catch {
    return { docxCommentCount: 0, totalTextRuns: 0, blueRuns: 0, coloredRuns: 0, highlightRuns: 0, colorValues: {}, blueExamples: [], error: 'inspect_failed' }
  }
}

function clip(s: string, n: number): string {
  const c = (s ?? '').replace(/\n/g, ' ').trim()
  return c.length > n ? c.slice(0, n) + '…' : c
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // ── 1. Load manifest ──────────────────────────────────────────────────────
  const manifestPath = path.resolve('data/ai-review-experiment/manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const allDocs: ManifestDoc[] = manifest.documents
  const manifestByPath = new Map(allDocs.map(d => [path.normalize(d.sourcePath), d]))
  const manifestByFile = new Map(allDocs.map(d => [d.fileName, d]))

  // ── 2. DB queries (read-only) ─────────────────────────────────────────────
  const dbDocs = await prisma.knowledgeDocument.findMany({
    select: {
      id: true, fileUrl: true, title: true,
      source: { select: { sourceType: true, id: true } },
      _count: { select: { chunks: true, annotations: true } },
    },
  })
  const dbByNormPath = new Map<string, typeof dbDocs[0]>()
  const dbByTitle    = new Map<string, typeof dbDocs[0]>()
  const dbById       = new Map<number, typeof dbDocs[0]>()
  for (const d of dbDocs) {
    if (d.fileUrl) dbByNormPath.set(path.normalize(d.fileUrl), d)
    if (d.title)   dbByTitle.set(d.title, d)
    dbById.set(d.id, d)
  }

  // Embedding counts via chunk→doc join
  const chunkRows = await prisma.knowledgeChunk.findMany({ select: { id: true, documentId: true } })
  const chunkDocMap = new Map(chunkRows.map(c => [c.id, c.documentId]))
  const embGroups = await prisma.knowledgeEmbedding.groupBy({ by: ['chunkId'], _count: { id: true } })
  const embByDocId = new Map<number, number>()
  for (const eg of embGroups) {
    const docId = chunkDocMap.get(eg.chunkId)
    if (docId !== undefined) embByDocId.set(docId, (embByDocId.get(docId) ?? 0) + eg._count.id)
  }

  function dbForManifest(mDoc: ManifestDoc): typeof dbDocs[0] | undefined {
    return dbByNormPath.get(path.normalize(mDoc.sourcePath)) ?? dbByTitle.get(mDoc.fileName)
  }

  // ── 3. Source directories ─────────────────────────────────────────────────
  const sourceDirs = new Set(allDocs.map(d => path.dirname(d.sourcePath)))

  // Scan disks for .docx files
  const diskFilesByDir = new Map<string, Set<string>>()
  for (const dir of sourceDirs) {
    const files = new Set<string>()
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.toLowerCase().endsWith('.docx') && !f.startsWith('~$')) {
          files.add(f)
        }
      }
    }
    diskFilesByDir.set(dir, files)
  }

  // ── 4. Python helper ──────────────────────────────────────────────────────
  const pyFile = writePy()

  // ── 5. Build audit records for all 535 manifest docs ─────────────────────
  const records: AuditRecord[] = []
  let inspectedCount = 0
  const totalToInspect = allDocs.filter(d => d.comments.length === 0 && fs.existsSync(d.sourcePath)).length
  process.stderr.write(`Will inspect ${totalToInspect} zero-comment files (source exists)...\n`)

  for (const mDoc of allDocs) {
    const normPath = path.normalize(mDoc.sourcePath)
    const sourceFileExists = fs.existsSync(mDoc.sourcePath)
    const override = MANUAL_OVERRIDES[mDoc.fileName]
    const db = dbForManifest(mDoc)
    const sourceType = db?.source?.sourceType ?? mDoc.collection
    const chunkCount = db?._count.chunks ?? 0
    const annotationCount = db?._count.annotations ?? 0
    const embeddingCount = embByDocId.get(db?.id ?? -1) ?? 0
    const matchesAssignment = ASSIGNMENT_PATTERN.test(mDoc.fileName)
    const patternTag = assignmentPatternTag(mDoc.fileName)
    const rawText = mDoc.rawText ?? ''
    const hasTeacherSignal = TEACHER_SIGNAL_KW.some(kw => rawText.includes(kw))

    // Python inspection: run on zero-comment files with existing source
    let inspected = false
    let docxCommentCount = -1
    let coloredRunCount = -1
    let blueRunCount = -1
    let highlightCount = -1
    let inspectionError: string | null = null

    if (mDoc.comments.length === 0 && sourceFileExists) {
      inspectedCount++
      if (inspectedCount % 10 === 0) process.stderr.write(`  inspecting ${inspectedCount}/${totalToInspect}...\n`)
      const r = inspectDocx(pyFile, mDoc.sourcePath)
      inspected = true
      docxCommentCount = r.docxCommentCount
      coloredRunCount  = r.coloredRuns
      blueRunCount     = r.blueRuns
      highlightCount   = r.highlightRuns
      inspectionError  = r.error ?? null
    }

    // DROP classification
    let dropCategory: DropCategory
    const reasons: string[] = []
    let riskNote = ''
    let recommendation = ''
    const confirmQuestions: string[] = []

    // Manual override always wins
    if (override?.doNotDrop) {
      dropCategory = 'DO_NOT_DROP'
      reasons.push(`manual_override:${override.role}`, override.notes)
      recommendation = 'doNotDrop'

    // Source file missing
    } else if (!sourceFileExists) {
      dropCategory = 'STALE_SOURCE'
      reasons.push('source_file_missing')
      if (annotationCount > 0) reasons.push(`db_annotations=${annotationCount}`)
      if (embeddingCount > 0)  reasons.push(`db_embeddings=${embeddingCount}`)
      riskNote = '原始文件已不在磁盘，DB/manifest 仍有残留记录'
      if (annotationCount === 0 && embeddingCount === 0) {
        recommendation = 'hardDeleteDbCandidate'
        confirmQuestions.push('Q1: 这个文件是否已经被你手动删除？')
        confirmQuestions.push('Q2: DB记录（无annotations/embeddings）是否可以后续清理？')
      } else {
        recommendation = 'keepDbRecordUntilConfirmed'
        confirmQuestions.push('Q1: 文件已删除，但DB还有annotations/embeddings。是否有价值保留DB记录？')
        confirmQuestions.push('Q2: 是否需要从其他位置找回原始文件？')
      }

    // Has comments, annotations, or color → DO_NOT_DROP
    } else if (
      mDoc.comments.length > 0 ||
      annotationCount > 0 ||
      (inspected && (coloredRunCount > 0 || blueRunCount > 0 || highlightCount > 0 || docxCommentCount > 0))
    ) {
      dropCategory = 'DO_NOT_DROP'
      if (mDoc.comments.length > 0)                      reasons.push(`manifest_cmts=${mDoc.comments.length}`)
      if (annotationCount > 0)                           reasons.push(`annotations=${annotationCount}`)
      if (inspected && coloredRunCount > 0)              reasons.push(`colored_runs=${coloredRunCount}`)
      if (inspected && blueRunCount > 0)                 reasons.push(`blue_runs=${blueRunCount}`)
      if (inspected && highlightCount > 0)               reasons.push(`highlight_runs=${highlightCount}`)
      if (inspected && docxCommentCount > 0)             reasons.push(`docx_cmts=${docxCommentCount}`)
      recommendation = 'doNotDrop'

    // Has teacher signal in rawText → MEDIUM at minimum
    } else if (hasTeacherSignal) {
      dropCategory = matchesAssignment ? 'DROP_MEDIUM_CONFIDENCE' : 'DO_NOT_DROP'
      reasons.push('teacher_signal_in_rawtext')
      if (matchesAssignment) reasons.push('assignment_pattern')
      riskNote = 'rawText中检测到教师信号词，需人工确认是否为教师批改内容'
      recommendation = matchesAssignment ? 'humanConfirmRequired' : 'doNotDrop'
      confirmQuestions.push('Q: rawText中的教师信号词是否真实反映了教师批改内容？')
      confirmQuestions.push('Q: 这个文件是否还有价值保留？')

    // Zero comments + zero DOCX signals + assignment pattern → HIGH confidence drop
    } else if (
      matchesAssignment &&
      mDoc.comments.length === 0 &&
      inspected && docxCommentCount === 0 && coloredRunCount === 0 && blueRunCount === 0 && highlightCount === 0
    ) {
      dropCategory = 'DROP_HIGH_CONFIDENCE'
      reasons.push('assignment_pattern', `tag=${patternTag}`, 'manifest_cmts=0',
        'docx_cmts=0', 'colored_runs=0', 'blue_runs=0', 'annotations=0', 'no_teacher_signal')
      riskNote = '当前不执行删除。等人工确认后再选择 soft_exclude / quarantine / hard_delete'
      recommendation = 'softExclude_or_hardDelete_after_confirmation'
      confirmQuestions.push('Q1: 确认这个文件是无批注学生草稿？')
      confirmQuestions.push('Q2: 是否可以排除出RAG知识库？')
      confirmQuestions.push('Q3: 选择处理方式：soft_exclude / quarantine / hard_delete？')

    // Zero comments + zero DOCX signals + no assignment pattern → could be model essay
    } else if (
      mDoc.comments.length === 0 &&
      inspected && docxCommentCount === 0 && coloredRunCount === 0 && blueRunCount === 0 && highlightCount === 0
    ) {
      // MODEL_ESSAY with no signals → likely a plain essay (no teacher annotation)
      dropCategory = sourceType === 'MODEL_ESSAY' ? 'DROP_MEDIUM_CONFIDENCE' : 'NORMAL'
      reasons.push('zero_manifest_cmts', 'zero_docx_signals')
      if (sourceType === 'MODEL_ESSAY') {
        reasons.push('MODEL_ESSAY_zero_signals')
        riskNote = '模型作文目录中无任何信号，可能是收录的范文但无批注，或是误分类的学生草稿'
        recommendation = 'humanConfirmRequired'
        confirmQuestions.push('Q: 这个文件是教师写的范文（有RAG价值），还是无批注学生草稿（低价值）？')
      } else {
        recommendation = 'monitor'
      }

    // Source exists, zero comments, inspection failed or not run
    } else if (mDoc.comments.length === 0 && !inspected) {
      dropCategory = matchesAssignment ? 'DROP_MEDIUM_CONFIDENCE' : 'NORMAL'
      reasons.push('zero_manifest_cmts', 'not_inspected')
      riskNote = '未能运行DOCX检查'
      recommendation = matchesAssignment ? 'humanConfirmRequired' : 'monitor'

    } else {
      dropCategory = 'NORMAL'
      recommendation = 'normal'
    }

    records.push({
      fileName: mDoc.fileName,
      collection: mDoc.collection,
      sourceType,
      documentId: db?.id ?? null,
      sourcePath: mDoc.sourcePath,
      fileUrl: db?.fileUrl ?? '',
      sourceFileExists,
      manifestExists: true,
      manifestCommentCount: mDoc.comments.length,
      rawTextLength: rawText.length,
      task: mDoc.task,
      dbExists: !!db,
      chunkCount, annotationCount, embeddingCount,
      inspected, docxCommentCount, coloredRunCount, blueRunCount, highlightCount, inspectionError,
      matchesAssignmentPattern: matchesAssignment,
      assignmentPatternTag: patternTag,
      hasTeacherSignal,
      isManualOverride: !!override,
      overrideRole: override?.role ?? null,
      dropCategory, reasons, riskNote, recommendation, confirmQuestions,
    })
  }

  // ── 6. Unimported .docx files in source directories ───────────────────────
  interface UnimportedFile { dir: string; fileName: string; fullPath: string; matchesAssignment: boolean }
  const unimported: UnimportedFile[] = []
  for (const [dir, files] of diskFilesByDir) {
    for (const f of files) {
      const normFull = path.normalize(path.join(dir, f))
      if (!manifestByPath.has(normFull) && !manifestByFile.has(f)) {
        unimported.push({ dir, fileName: f, fullPath: path.join(dir, f), matchesAssignment: ASSIGNMENT_PATTERN.test(f) })
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OUTPUT
  // ─────────────────────────────────────────────────────────────────────────

  const eq = '═'.repeat(76)
  const hr = '─'.repeat(76)

  console.log(`\n${eq}`)
  console.log(`  SOURCE FILE STATUS AUDIT — DRY-RUN（只读，不写任何数据）`)
  console.log(`  时间: ${new Date().toISOString()}`)
  console.log(`  manifest docs: ${allDocs.length}  DB docs: ${dbDocs.length}  inspected: ${inspectedCount}`)
  console.log(`${eq}\n`)

  // ── §1: Summary stats ──────────────────────────────────────────────────────
  console.log(`${eq}\n  §1  总体统计\n${eq}`)
  const stale    = records.filter(r => r.dropCategory === 'STALE_SOURCE')
  const dropHigh = records.filter(r => r.dropCategory === 'DROP_HIGH_CONFIDENCE')
  const dropMed  = records.filter(r => r.dropCategory === 'DROP_MEDIUM_CONFIDENCE')
  const doNotDrop = records.filter(r => r.dropCategory === 'DO_NOT_DROP')
  const normal   = records.filter(r => r.dropCategory === 'NORMAL')
  const assignAll = records.filter(r => r.matchesAssignmentPattern)

  console.log(`总 manifest 文档:                  ${records.length}`)
  console.log(`命中作业类标题 (broad pattern):     ${assignAll.length}`)
  console.log(`source file 缺失 (STALE):          ${stale.length}`)
  console.log(`DROP_HIGH_CONFIDENCE:              ${dropHigh.length}`)
  console.log(`DROP_MEDIUM_CONFIDENCE:            ${dropMed.length}`)
  console.log(`DO_NOT_DROP:                       ${doNotDrop.length}`)
  console.log(`NORMAL (无问题):                   ${normal.length}`)
  console.log(`已在磁盘上、但不在 manifest 里:      ${unimported.length}  (从未导入)`)
  console.log()
  console.log(`作业类文件中:`)
  console.log(`  DROP_HIGH_CONFIDENCE:  ${dropHigh.filter(r=>r.matchesAssignmentPattern).length}`)
  console.log(`  DROP_MEDIUM_CONFIDENCE: ${dropMed.filter(r=>r.matchesAssignmentPattern).length}`)
  console.log(`  DO_NOT_DROP:           ${doNotDrop.filter(r=>r.matchesAssignmentPattern).length}`)
  console.log(`  STALE:                 ${stale.filter(r=>r.matchesAssignmentPattern).length}`)

  // ── §2: STALE files ────────────────────────────────────────────────────────
  console.log(`\n${eq}\n  §2  STALE 文件（source 已删除，DB/manifest 仍有残留）\n${eq}`)
  if (stale.length === 0) {
    console.log(`  无 STALE 文件 ✓`)
  } else {
    console.log(`  共 ${stale.length} 个文件 source 已不存在：`)
    for (const r of stale) {
      console.log()
      console.log(`  [docId=${r.documentId ?? 'null'}] ${r.fileName}`)
      console.log(`    collection=${r.collection}  sourceType=${r.sourceType}  task=${r.task ?? 'null'}`)
      console.log(`    sourcePath: ${r.sourcePath}`)
      console.log(`    sourceFileExists: FALSE  ← 文件已从磁盘删除`)
      console.log(`    manifest_cmts=${r.manifestCommentCount}  rawText=${r.rawTextLength}chars`)
      console.log(`    chunks=${r.chunkCount}  annotations=${r.annotationCount}  embeddings=${r.embeddingCount}`)
      console.log(`    ⚠ ${r.riskNote}`)
      console.log(`    recommendation: ${r.recommendation}`)
      for (const q of r.confirmQuestions) console.log(`    ${q}`)
    }
  }

  // ── §3: DROP_HIGH_CONFIDENCE ──────────────────────────────────────────────
  console.log(`\n${eq}\n  §3  DROP_HIGH_CONFIDENCE（${dropHigh.length}个文件）\n${eq}`)
  if (dropHigh.length === 0) {
    console.log(`  无 DROP_HIGH_CONFIDENCE 文件 ✓`)
  } else {
    for (const r of dropHigh) {
      console.log(`  [docId=${r.documentId ?? 'null'}] ${r.fileName}`)
      console.log(`    collection=${r.collection}  sourceType=${r.sourceType}  task=${r.task ?? 'null'}`)
      console.log(`    sourceFileExists=${r.sourceFileExists}  rawText=${r.rawTextLength}chars`)
      console.log(`    manifest_cmts=${r.manifestCommentCount}  docx_cmts=${r.docxCommentCount}  colored=${r.coloredRunCount}  blue=${r.blueRunCount}  hl=${r.highlightCount}`)
      console.log(`    chunks=${r.chunkCount}  annotations=${r.annotationCount}  embeddings=${r.embeddingCount}`)
      console.log(`    assignmentTag=${r.assignmentPatternTag}  teacherSignal=${r.hasTeacherSignal}`)
      console.log(`    理由: ${r.reasons.join(' | ')}`)
      console.log(`    ⚠ 当前不删除。推荐: ${r.recommendation}`)
      for (const q of r.confirmQuestions) console.log(`    ${q}`)
      console.log()
    }
  }

  // ── §4: DROP_MEDIUM_CONFIDENCE ────────────────────────────────────────────
  console.log(`${eq}\n  §4  DROP_MEDIUM_CONFIDENCE（${dropMed.length}个文件）\n${eq}`)
  if (dropMed.length === 0) {
    console.log(`  无 DROP_MEDIUM_CONFIDENCE 文件`)
  } else {
    console.log(`  共 ${dropMed.length} 个，需人工打开确认内容：`)
    for (const r of dropMed.slice(0, 20)) {
      console.log()
      console.log(`  [docId=${r.documentId ?? 'null'}] ${r.fileName}`)
      console.log(`    collection=${r.collection}  sourceType=${r.sourceType}  task=${r.task ?? 'null'}`)
      console.log(`    manifest_cmts=${r.manifestCommentCount}  docx_cmts=${r.docxCommentCount}  colored=${r.coloredRunCount}  blue=${r.blueRunCount}  hl=${r.highlightCount}`)
      console.log(`    chunks=${r.chunkCount}  annotations=${r.annotationCount}  embeddings=${r.embeddingCount}`)
      console.log(`    teacherSignal=${r.hasTeacherSignal}  assignmentTag=${r.assignmentPatternTag}`)
      console.log(`    理由: ${r.reasons.join(' | ')}`)
      if (r.riskNote) console.log(`    ⚠ ${r.riskNote}`)
      for (const q of r.confirmQuestions) console.log(`    ${q}`)
    }
    if (dropMed.length > 20) console.log(`\n  ... 另有 ${dropMed.length - 20} 个（略）`)
  }

  // ── §5: DO_NOT_DROP assignment-pattern files ──────────────────────────────
  console.log(`\n${eq}\n  §5  DO_NOT_DROP 作业类文件（有信号，不能删）\n${eq}`)
  const dndAssign = doNotDrop.filter(r => r.matchesAssignmentPattern || r.isManualOverride)
  console.log(`  共 ${dndAssign.length} 个：`)
  for (const r of dndAssign) {
    const ovTag = r.isManualOverride ? ` ★${r.overrideRole}` : ''
    console.log(`  [docId=${r.documentId ?? 'null'}] ${r.fileName}${ovTag}`)
    console.log(`    manifest_cmts=${r.manifestCommentCount}  colored=${r.coloredRunCount}  annotations=${r.annotationCount}  理由: ${r.reasons.slice(0,3).join(' | ')}`)
  }

  // ── §6: Unimported files in source directories ────────────────────────────
  console.log(`\n${eq}\n  §6  磁盘上存在但未导入 manifest 的文件\n${eq}`)
  console.log(`  总计: ${unimported.length} 个`)
  const unimportedAssign = unimported.filter(f => f.matchesAssignment)
  console.log(`  其中命中作业类标题: ${unimportedAssign.length} 个`)
  if (unimportedAssign.length > 0) {
    console.log(`  作业类未导入文件:`)
    for (const f of unimportedAssign.slice(0, 20)) {
      console.log(`    ${f.fileName}  (${f.dir.split(path.sep).pop()})`)
    }
    if (unimportedAssign.length > 20) console.log(`    ... 另有 ${unimportedAssign.length - 20} 个`)
  }
  console.log()
  console.log(`  说明: 这些文件在源文件夹里但从未被 import 脚本处理。`)
  console.log(`  它们不在 manifest/DB 里，不影响当前 RAG 系统。`)
  console.log(`  如需导入，需单独执行 import 流程，且先进行质量审核。`)

  // ── §7: Human confirmation table ──────────────────────────────────────────
  console.log(`\n${eq}\n  §7  人工确认表（需要你回答的文件）\n${eq}`)
  console.log(`注意：以下仅列出需要你回答的文件，包括 STALE / DROP_HIGH / DROP_MEDIUM / override 文件\n`)

  const needsConfirm = [
    ...stale,
    ...dropHigh,
    ...dropMed.slice(0, 15),
    ...records.filter(r => r.isManualOverride),
  ]

  // Deduplicate by fileName
  const seen = new Set<string>()
  const confirmList = needsConfirm.filter(r => {
    if (seen.has(r.fileName)) return false
    seen.add(r.fileName)
    return true
  })

  console.log(`  ${'#'.padEnd(3)} ${'fileName'.padEnd(36)} ${'docId'.padEnd(7)} ${'status'.padEnd(22)} ${'cmts'.padStart(4)} ${'color'.padStart(5)} ${'ann'.padStart(4)} recommendation`)
  console.log(`  ${hr}`)
  for (const [i, r] of confirmList.entries()) {
    const status = r.dropCategory === 'STALE_SOURCE'
      ? 'STALE (文件已删除)'
      : r.dropCategory === 'DROP_HIGH_CONFIDENCE'
        ? 'DROP_HIGH'
        : r.dropCategory === 'DROP_MEDIUM_CONFIDENCE'
          ? 'DROP_MEDIUM'
          : r.isManualOverride
            ? `OVERRIDE:${r.overrideRole?.slice(0,12)}`
            : r.dropCategory
    const cmts  = r.manifestCommentCount
    const color = r.coloredRunCount < 0 ? '?' : String(r.coloredRunCount)
    const ann   = r.annotationCount
    const rec   = r.recommendation.slice(0, 32)
    const flag  = r.dropCategory === 'STALE_SOURCE' ? ' ⚠' : r.isManualOverride ? ' ★' : ''
    console.log(`  ${String(i+1).padStart(3)} ${r.fileName.slice(0,34).padEnd(36)} ${String(r.documentId ?? '?').padEnd(7)} ${status.padEnd(22)} ${String(cmts).padStart(4)} ${color.padStart(5)} ${String(ann).padStart(4)} ${rec}${flag}`)
  }

  console.log()
  console.log(`  问题列表:`)
  console.log(`    Q1 这个文件是否已经被你手动从文件夹删除？`)
  console.log(`    Q2 这个文件是否是无批注学生草稿（无教师价值）？`)
  console.log(`    Q3 这个文件是否有教师价值但自动检测没识别出来？`)
  console.log(`    Q4 处理方式: soft_exclude / quarantine / hard_delete_db / keep？`)
  console.log(`    Q5 DB 里的记录是否也应该后续清理？`)

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log(`\n${eq}\n  汇报（只读审计完成，未写入任何数据）\n${eq}`)

  // Q1: 大作文作业1 source exists?
  const hw1 = records.find(r => r.fileName === '大作文作业1.docx')
  const hw_small = records.find(r => r.fileName === '小作文作业.docx')
  const hw2z = records.find(r => r.fileName === '大作文作业2 z.docx')

  console.log(`1. 大作文作业1.docx — source exists: ${hw1?.sourceFileExists ?? '未在manifest中'}`)
  console.log(`   status: ${hw1?.dropCategory ?? 'N/A'}  annotations: ${hw1?.annotationCount ?? '?'}  embeddings: ${hw1?.embeddingCount ?? '?'}`)
  console.log()
  console.log(`2. 小作文作业.docx — source exists: ${hw_small?.sourceFileExists ?? '未在manifest中'}`)
  console.log(`   status: ${hw_small?.dropCategory ?? 'N/A'}  annotations: ${hw_small?.annotationCount ?? '?'}  embeddings: ${hw_small?.embeddingCount ?? '?'}`)
  console.log()
  console.log(`3. 大作文作业2 z.docx — source exists: ${hw2z?.sourceFileExists ?? '未在manifest中'}  ★ DO_NOT_DROP ✓`)
  console.log()
  console.log(`4. 作业类/日期类/数字类文件全量: ${assignAll.length} 个`)
  console.log(`   - DROP_HIGH_CONFIDENCE: ${dropHigh.filter(r=>r.matchesAssignmentPattern).length} 个`)
  console.log(`   - DROP_MEDIUM_CONFIDENCE: ${dropMed.filter(r=>r.matchesAssignmentPattern).length} 个（需人工确认）`)
  console.log(`   - DO_NOT_DROP: ${doNotDrop.filter(r=>r.matchesAssignmentPattern).length} 个`)
  console.log(`   - STALE (source 已删除): ${stale.filter(r=>r.matchesAssignmentPattern).length} 个`)
  console.log()
  console.log(`5. SOURCE_FILE_MISSING 文件: ${stale.length} 个`)
  for (const r of stale) {
    console.log(`   [${r.documentId ?? '?'}] ${r.fileName}  chunks=${r.chunkCount}  ann=${r.annotationCount}  emb=${r.embeddingCount}`)
  }
  console.log()
  console.log(`6. ran/may/joan 教学材料 DO_NOT_DROP:`)
  for (const fn of ['ran 双边.docx', 'may 程度同意2.docx', 'joan 拓展2.docx']) {
    const r = records.find(x => x.fileName === fn)
    console.log(`   ${fn}: ${r ? `docId=${r.documentId} status=${r.dropCategory} ✓` : '未在manifest中'}`)
  }
  console.log()
  console.log(`7. 推荐删除策略:`)
  console.log(`   STALE 文件 (大作文作业1, 小作文作业, 2.18雅思大作文): chunks/annotations=0`)
  console.log(`   → 推荐 Option 1 Soft exclude (先在质量字段标记，再确认 hard delete DB)`)
  console.log(`   DROP_HIGH_CONFIDENCE: ${dropHigh.length} 个`)
  console.log(`   → 同上，先 soft_exclude，等你逐一确认后再 hard_delete_db`)
  console.log(`   DROP_MEDIUM_CONFIDENCE: ${dropMed.length} 个`)
  console.log(`   → 必须人工打开文件确认内容`)
  console.log()
  console.log(`8. 磁盘上存在、但从未导入的文件: ${unimported.length} 个`)
  console.log(`   其中作业类: ${unimportedAssign.length} 个（不在DB，不影响当前RAG）`)
  console.log(`${eq}\n`)
}

main()
  .catch(err => { console.error('Fatal:', err); process.exit(1) })
  .finally(() => prisma.$disconnect())
