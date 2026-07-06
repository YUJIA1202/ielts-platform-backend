/**
 * 文档数据质量分类器 v1.0  —  只读 dry-run
 *
 * 对全量 KnowledgeDocument 进行质量分析，输出分类建议，
 * 不写入数据库，不修改任何字段（包括 task）。
 *
 * 用法：
 *   npx tsx scripts/classify-document-quality.ts          # dry-run，输出报告
 *   npx tsx scripts/classify-document-quality.ts --csv    # 同时输出 CSV 到 data/quality-report.csv
 *
 * 字段说明：
 *   contentRole        — 内容角色 (REVIEW_EXAMPLE|MODEL_ESSAY|MODEL_PARAGRAPH|TEACHING_NOTE|MIXED|NEEDS_REVIEW)
 *   completenessStatus — 完整性   (COMPLETE|PARTIAL|MISSING_PROMPT|MULTI_ESSAY_DOCUMENT|MIXED_TASK_DOCUMENT|NEEDS_REVIEW)
 *   probableTask       — 推断题型  (TASK1|TASK2|null)，不写入 task 字段
 *   allowedForRag      — 建议 RAG 开关
 *   excludeFromEval    — 建议评估集排除
 *   qualityNotes       — 自动判断理由（| 分隔）
 *   needsHumanReview   — 是否需要人工复核
 */

import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import prisma from '../src/prisma'

const CSV_MODE = process.argv.includes('--csv')
const CSV_PATH = path.resolve('data/quality-report.csv')

// ─── 类型 ────────────────────────────────────────────────────────

type ContentRole = 'REVIEW_EXAMPLE' | 'MODEL_ESSAY' | 'MODEL_PARAGRAPH'
                 | 'TEACHING_NOTE' | 'MIXED' | 'NEEDS_REVIEW'

type CompletenessStatus = 'COMPLETE' | 'PARTIAL' | 'MISSING_PROMPT'
                        | 'MULTI_ESSAY_DOCUMENT' | 'MIXED_TASK_DOCUMENT' | 'NEEDS_REVIEW'

type ProbableTask = 'TASK1' | 'TASK2' | null

interface DocRow {
  id: number
  title: string
  sourceType: string
  task: string | null
  subtype: string | null
  rawText: string
  topic: string | null
}

interface Classification {
  contentRole: ContentRole
  completenessStatus: CompletenessStatus
  probableTask: ProbableTask
  allowedForRag: boolean
  excludeFromEval: boolean
  qualityNotes: string[]
  needsHumanReview: boolean
}

// ─── 关键词表 ─────────────────────────────────────────────────────

const TEACHING_KEYWORDS_TITLE = [
  '拓展', '补充', '参考', '思路', '资料', '讲义', '附件', '说明', '解析',
  '额外', '附加', '语料', '词汇', '模板', '框架', '大纲',
  '范文解析', '结构分析', '总结', '附录',
]

// TASK2 文件名关键词
const TASK2_TITLE_KEYWORDS = ['大作文', '报告', '优缺点', '双边', '程度同意', '讨论题']
// TASK1 文件名关键词
const TASK1_TITLE_KEYWORDS = ['小作文', '柱状图', '饼图', '折线', '地图', '流程图', '线图']

// 正文 intro 关键词（检查前 400 字）
const INTRO_PATTERNS = [
  // Task2 引言模式（议论/讨论文）
  /\bin (recent|today|modern|contemporary)/i,
  /\bit is (often|widely|commonly|generally)/i,
  /\b(many|some|most) people/i,
  /\bthere (is|are) (a growing|an increasing|much|considerable)/i,
  /\bnowadays\b/i,
  /\bin (today|the modern|this day)/i,
  /\brecently\b.{0,60}(debate|discuss|argue|consider)/i,
  // Task1 引言模式（图表描述文）
  /\bthe (bar chart|pie chart|line graph|chart|graph|table|diagram|map|process) (show|illustrat|describ|compare|present)/i,
  /\baccording to the (chart|graph|table|diagram|map)/i,
  /\bas (shown|illustrated|depicted|can be seen) (in|from) the/i,
  /\bthe (given|provided|following) (chart|graph|table|diagram)/i,
]

// 正文 conclusion 关键词（检查后 400 字）
const CONCLUSION_PATTERNS = [
  /\bin conclusion\b/i,
  /\bto (conclude|summarize|sum up)\b/i,
  /\bin summary\b/i,
  /\boverall[,\s]/i,
  /\ball in all\b/i,
  /\btaking everything (into account|together)\b/i,
]

// ─── 文本分析工具 ─────────────────────────────────────────────────

function countParagraphs(rawText: string): number {
  return rawText.split(/\n\n+/).filter(p => p.trim().length > 30).length
}

function hasIntro(rawText: string): boolean {
  const head = rawText.slice(0, 400)
  return INTRO_PATTERNS.some(p => p.test(head))
}

function hasConclusion(rawText: string): boolean {
  const tail = rawText.slice(-400)
  return CONCLUSION_PATTERNS.some(p => p.test(tail))
}

function hasPromptMarkers(rawText: string): boolean {
  const head = rawText.slice(0, 600)
  return (
    /\?/.test(head) ||
    /discuss both (views|sides)/i.test(head) ||
    /to what extent/i.test(head) ||
    /summaris[ez] the information/i.test(head) ||
    /what (are|is) the (cause|reason|effect|solution|problem)/i.test(head) ||
    /give (your|their) own opinion/i.test(head) ||
    /the (chart|graph|table|diagram|map|process) (show|illustrat|describ)/i.test(head)
  )
}

// ─── 混合文档检测 ─────────────────────────────────────────────────

function detectMixedTask(title: string): boolean {
  const hasTask2 = TASK2_TITLE_KEYWORDS.some(kw => title.includes(kw)) ||
                   /\d+大/.test(title)
  const hasTask1 = TASK1_TITLE_KEYWORDS.some(kw => title.includes(kw)) ||
                   /\d+小/.test(title)
  return hasTask2 && hasTask1
}

function detectMultiEssay(title: string, rawText: string): boolean {
  // title 里的 + 且两侧都是已知题型词
  if ((title.includes('+') || title.includes('＋'))) {
    const parts = title.split(/[+＋]/)
    const keywords = [...TASK1_TITLE_KEYWORDS, ...TASK2_TITLE_KEYWORDS, '报告', '优缺点', '双边']
    const bothSidesKnown = parts.every(p => keywords.some(kw => p.includes(kw)))
    if (bothSidesKnown) return true
  }
  // 注意：正文内容检测在 TEACHER_REVIEW 文档中可靠性很低
  //   教师批注会引用任务指令短语（如"你没有回答 to what extent 的问题"），
  //   带批注的单篇文章也会有多个 "?" → 不用内容检测，只看标题。

  // Signal 2: "大小作文" / "小大作文" 合体词（同时含 T1+T2）
  if (/大小作文|小大作文|大作文.{0,10}小作文|小作文.{0,10}大作文/.test(title)) return true

  // Signal 3: "以及" 连接两种已知题型
  if (title.includes('以及')) {
    const types = ['双边', '优缺点', '程度同意', '报告', '大作文', '小作文', '比较']
    const matchCount = types.filter(t => title.includes(t)).length
    if (matchCount >= 2) return true
  }

  return false
}

// ─── probableTask 推断 ────────────────────────────────────────────

function inferProbableTask(title: string, rawText: string, currentTask: string | null): ProbableTask {
  if (currentTask) return null  // 已有 task 不推断

  const notes: string[] = []

  // P1: 数字 + 大/小（高置信）
  if (/\d+大/.test(title)) return 'TASK2'
  if (/\d+小/.test(title)) return 'TASK1'

  // P2: 文件名关键词（中置信）
  if (TASK2_TITLE_KEYWORDS.some(kw => title.includes(kw))) return 'TASK2'
  if (TASK1_TITLE_KEYWORDS.some(kw => title.includes(kw))) return 'TASK1'

  // P3: 正文内容（与原 detect_task 等价）
  const sample = (title + '\n' + rawText.slice(0, 5000)).toLowerCase()
  const task2Markers = [
    'discuss both views', 'discuss both sides', 'to what extent do you agree',
    'to what extent do you disagree', 'advantages outweigh', 'outweigh the disadvantages',
    'causes and solutions', 'give your own opinion',
  ]
  const task1Markers = [
    'the chart shows', 'the graph shows', 'the table shows', 'the diagram shows',
    'the maps show', 'the map shows', 'the process shows', 'illustrates',
    'the chart illustrat', 'the graph illustrat',
  ]
  if (task2Markers.some(m => sample.includes(m))) return 'TASK2'
  if (task1Markers.some(m => sample.includes(m))) return 'TASK1'

  return null
}

// ─── 完整性状态分类 ───────────────────────────────────────────────

function classifyCompleteness(
  title: string,
  rawText: string,
  notes: string[],
): CompletenessStatus {
  // 1. MIXED_TASK_DOCUMENT（同时含 T1+T2 指标）
  if (detectMixedTask(title)) {
    notes.push('title contains both TASK1 and TASK2 markers → MIXED_TASK_DOCUMENT')
    return 'MIXED_TASK_DOCUMENT'
  }

  // 2. MULTI_ESSAY_DOCUMENT
  if (detectMultiEssay(title, rawText)) {
    notes.push('title contains "+" with multi-essay indicators → MULTI_ESSAY_DOCUMENT')
    return 'MULTI_ESSAY_DOCUMENT'
  }

  const len = rawText.length
  const paraCount = countParagraphs(rawText)
  const intro = hasIntro(rawText)
  const conclusion = hasConclusion(rawText)
  const prompt = hasPromptMarkers(rawText)

  // 3. PARTIAL（太短或结构明显不完整）
  if (len < 500 || paraCount < 3) {
    notes.push(`rawText.length=${len} paraCount=${paraCount} → PARTIAL`)
    return 'PARTIAL'
  }
  if (!intro && !conclusion) {
    notes.push('no intro markers, no conclusion markers → PARTIAL')
    return 'PARTIAL'
  }

  // 4. MISSING_PROMPT（正文存在但题目缺失）
  if (!prompt) {
    notes.push('no prompt markers in first 600 chars → MISSING_PROMPT')
    return 'MISSING_PROMPT'
  }

  // 5. COMPLETE
  if (paraCount >= 4 && len >= 600 && (intro || conclusion)) {
    notes.push(`paraCount=${paraCount} len=${len} intro=${intro} conclusion=${conclusion} → COMPLETE`)
    return 'COMPLETE'
  }

  // 6. NEEDS_REVIEW（规则冲突）
  notes.push(`ambiguous: len=${len} paraCount=${paraCount} intro=${intro} conclusion=${conclusion} prompt=${prompt}`)
  return 'NEEDS_REVIEW'
}

// ─── 内容角色分类 ─────────────────────────────────────────────────

function classifyContentRole(
  title: string,
  sourceType: string,
  completenessStatus: CompletenessStatus,
  notes: string[],
): ContentRole {
  // 1. TEACHING_NOTE
  const teachingKw = TEACHING_KEYWORDS_TITLE.find(kw => title.includes(kw))
  if (teachingKw) {
    notes.push(`title contains "${teachingKw}" → TEACHING_NOTE`)
    return 'TEACHING_NOTE'
  }

  // 2. MIXED（同时含 T1+T2）
  if (completenessStatus === 'MIXED_TASK_DOCUMENT') {
    notes.push('MIXED_TASK_DOCUMENT → MIXED')
    return 'MIXED'
  }
  // 也检查 MULTI_ESSAY_DOCUMENT 含混合题型
  if (completenessStatus === 'MULTI_ESSAY_DOCUMENT' && detectMixedTask(title)) {
    notes.push('MULTI_ESSAY_DOCUMENT with both tasks → MIXED')
    return 'MIXED'
  }

  // 3. REVIEW_EXAMPLE（学生作文+教师批注）
  if (sourceType === 'TEACHER_REVIEW') {
    notes.push('sourceType=TEACHER_REVIEW → REVIEW_EXAMPLE')
    return 'REVIEW_EXAMPLE'
  }

  // 4. MODEL_ESSAY / MODEL_PARAGRAPH
  if (sourceType === 'MODEL_ESSAY') {
    if (completenessStatus === 'COMPLETE' || completenessStatus === 'MISSING_PROMPT') {
      notes.push('sourceType=MODEL_ESSAY completeness=COMPLETE/MISSING_PROMPT → MODEL_ESSAY')
      return 'MODEL_ESSAY'
    }
    if (completenessStatus === 'PARTIAL') {
      notes.push('sourceType=MODEL_ESSAY completeness=PARTIAL → MODEL_PARAGRAPH')
      return 'MODEL_PARAGRAPH'
    }
  }

  notes.push('no rule matched → NEEDS_REVIEW')
  return 'NEEDS_REVIEW'
}

// ─── allowedForRag / excludeFromEval ─────────────────────────────

function computeRagEval(
  contentRole: ContentRole,
  completenessStatus: CompletenessStatus,
  notes: string[],
): { allowedForRag: boolean; excludeFromEval: boolean } {
  // 混合文档：不允许 RAG（题型不明确，会污染检索）
  if (completenessStatus === 'MIXED_TASK_DOCUMENT' || contentRole === 'MIXED') {
    notes.push('MIXED → allowedForRag=false excludeFromEval=true')
    return { allowedForRag: false, excludeFromEval: true }
  }
  if (completenessStatus === 'MULTI_ESSAY_DOCUMENT') {
    notes.push('MULTI_ESSAY → allowedForRag=false excludeFromEval=true')
    return { allowedForRag: false, excludeFromEval: true }
  }

  // 讲义：可教学检索，排除评估
  if (contentRole === 'TEACHING_NOTE') {
    notes.push('TEACHING_NOTE → allowedForRag=true excludeFromEval=true')
    return { allowedForRag: true, excludeFromEval: true }
  }

  // 片段范文：语言参考可以，不做完整作文评估
  if (completenessStatus === 'PARTIAL' || contentRole === 'MODEL_PARAGRAPH') {
    notes.push('PARTIAL/MODEL_PARAGRAPH → allowedForRag=true excludeFromEval=true')
    return { allowedForRag: true, excludeFromEval: true }
  }

  // 缺题目：批注和语言还有参考价值，但不纳入评估
  if (completenessStatus === 'MISSING_PROMPT') {
    notes.push('MISSING_PROMPT → allowedForRag=true excludeFromEval=true')
    return { allowedForRag: true, excludeFromEval: true }
  }

  // 待审：保留，先排评估
  if (contentRole === 'NEEDS_REVIEW' || completenessStatus === 'NEEDS_REVIEW') {
    notes.push('NEEDS_REVIEW → allowedForRag=true excludeFromEval=true')
    return { allowedForRag: true, excludeFromEval: true }
  }

  // COMPLETE：正常
  return { allowedForRag: true, excludeFromEval: false }
}

// ─── 总分类入口 ───────────────────────────────────────────────────

function classifyDocument(doc: DocRow): Classification {
  const notes: string[] = []

  const completenessStatus = classifyCompleteness(doc.title, doc.rawText, notes)
  const contentRole = classifyContentRole(doc.title, doc.sourceType, completenessStatus, notes)
  const probableTask = inferProbableTask(doc.title, doc.rawText, doc.task)
  if (probableTask && !doc.task) {
    notes.push(`probableTask=${probableTask} inferred from title/text (task kept null)`)
  }
  const { allowedForRag, excludeFromEval } = computeRagEval(contentRole, completenessStatus, notes)

  const needsHumanReview =
    contentRole === 'NEEDS_REVIEW' ||
    completenessStatus === 'NEEDS_REVIEW' ||
    completenessStatus === 'MULTI_ESSAY_DOCUMENT' ||
    completenessStatus === 'MIXED_TASK_DOCUMENT' ||
    (contentRole === 'TEACHING_NOTE' && !doc.task && !probableTask)

  return {
    contentRole,
    completenessStatus,
    probableTask,
    allowedForRag,
    excludeFromEval,
    qualityNotes: notes,
    needsHumanReview,
  }
}

// ─── 主流程 ──────────────────────────────────────────────────────

async function main() {
  console.log('================================================================')
  console.log('  文档数据质量分类 dry-run  (只读，不写入任何数据)')
  console.log('  时间:', new Date().toISOString())
  console.log('================================================================\n')

  // 加载全量文档（含 sourceType via JOIN）
  const docs = await prisma.knowledgeDocument.findMany({
    select: {
      id: true, title: true, task: true, subtype: true, rawText: true, topic: true,
      source: { select: { sourceType: true } },
    },
    orderBy: { id: 'asc' },
  })

  console.log(`加载 ${docs.length} 条 KnowledgeDocument\n`)

  // 分类
  const rows = docs.map(d => ({
    id: d.id,
    title: d.title,
    sourceType: d.source.sourceType,
    task: d.task,
    subtype: d.subtype,
    rawText: d.rawText,
    topic: d.topic,
    ...classifyDocument({
      id: d.id,
      title: d.title,
      sourceType: d.source.sourceType,
      task: d.task,
      subtype: d.subtype,
      rawText: d.rawText,
      topic: d.topic,
    }),
  }))

  // ─── 汇总统计 ────────────────────────────────────────────────

  const count = (pred: (r: typeof rows[0]) => boolean) => rows.filter(pred).length
  const pct = (n: number) => ((n / rows.length) * 100).toFixed(1) + '%'

  console.log('──────────────── contentRole 分布 ────────────────')
  for (const role of ['REVIEW_EXAMPLE', 'MODEL_ESSAY', 'MODEL_PARAGRAPH', 'TEACHING_NOTE', 'MIXED', 'NEEDS_REVIEW'] as ContentRole[]) {
    const n = count(r => r.contentRole === role)
    if (n) console.log(`  ${role.padEnd(22)} ${String(n).padStart(4)}  (${pct(n)})`)
  }

  console.log('\n──────────────── completenessStatus 分布 ────────────────')
  for (const st of ['COMPLETE', 'PARTIAL', 'MISSING_PROMPT', 'MULTI_ESSAY_DOCUMENT', 'MIXED_TASK_DOCUMENT', 'NEEDS_REVIEW'] as CompletenessStatus[]) {
    const n = count(r => r.completenessStatus === st)
    if (n) console.log(`  ${st.padEnd(24)} ${String(n).padStart(4)}  (${pct(n)})`)
  }

  const nullWithProbable = rows.filter(r => !r.task && r.probableTask)
  const nullNoProbable   = rows.filter(r => !r.task && !r.probableTask)
  console.log('\n──────────────── task=null 分析 ────────────────')
  console.log(`  task=null 总计:              ${count(r => !r.task)}`)
  console.log(`  其中有 probableTask 推断:    ${nullWithProbable.length}`)
  console.log(`    → TASK2:                   ${nullWithProbable.filter(r => r.probableTask === 'TASK2').length}`)
  console.log(`    → TASK1:                   ${nullWithProbable.filter(r => r.probableTask === 'TASK1').length}`)
  console.log(`  无法推断 (probableTask=null): ${nullNoProbable.length}`)

  console.log('\n──────────────── RAG / 评估集开关 ────────────────')
  console.log(`  allowedForRag=false:   ${count(r => !r.allowedForRag)}`)
  console.log(`  excludeFromEval=true:  ${count(r => r.excludeFromEval)}`)
  console.log(`  needsHumanReview=true: ${count(r => r.needsHumanReview)}`)
  console.log(`  完全可用 (RAG+Eval):   ${count(r => r.allowedForRag && !r.excludeFromEval)}`)

  // ─── 分场景列表 ─────────────────────────────────────────────

  console.log('\n──────────────── 需要人工复核的文档 (前 30 条) ────────────────')
  const reviewDocs = rows.filter(r => r.needsHumanReview).slice(0, 30)
  for (const r of reviewDocs) {
    console.log(`  id=${r.id} [${r.contentRole}/${r.completenessStatus}] task=${r.task ?? 'null'} probable=${r.probableTask ?? '-'}`)
    console.log(`    "${r.title.slice(0, 60)}"`)
    console.log(`    notes: ${r.qualityNotes.slice(-2).join(' | ')}`)
  }

  console.log('\n──────────────── MIXED / MULTI_ESSAY 文档 ────────────────')
  const mixedDocs = rows.filter(r =>
    r.completenessStatus === 'MIXED_TASK_DOCUMENT' || r.completenessStatus === 'MULTI_ESSAY_DOCUMENT'
  )
  for (const r of mixedDocs) {
    console.log(`  id=${r.id} [${r.completenessStatus}] task=${r.task ?? 'null'} → allowedForRag=${r.allowedForRag}`)
    console.log(`    "${r.title}"`)
  }

  console.log('\n──────────────── TEACHING_NOTE 文档 ────────────────')
  const teachDocs = rows.filter(r => r.contentRole === 'TEACHING_NOTE')
  for (const r of teachDocs) {
    console.log(`  id=${r.id} task=${r.task ?? 'null'} probable=${r.probableTask ?? '-'} excludeFromEval=${r.excludeFromEval}`)
    console.log(`    "${r.title}"`)
  }

  console.log('\n──────────────── task=null 无法推断 (NEEDS_REVIEW) ────────────────')
  for (const r of nullNoProbable.slice(0, 20)) {
    console.log(`  id=${r.id} [${r.contentRole}/${r.completenessStatus}] "${r.title.slice(0, 60)}"`)
    console.log(`    notes: ${r.qualityNotes.slice(-2).join(' | ')}`)
  }

  console.log('\n──────────────── PARTIAL / MODEL_PARAGRAPH 文档 (前 20 条) ────────────────')
  const partialDocs = rows.filter(r => r.completenessStatus === 'PARTIAL' || r.contentRole === 'MODEL_PARAGRAPH').slice(0, 20)
  for (const r of partialDocs) {
    console.log(`  id=${r.id} [${r.contentRole}] task=${r.task ?? 'null'} len=${r.rawText.length} excludeFromEval=${r.excludeFromEval}`)
    console.log(`    "${r.title}"`)
  }

  // ─── CSV 输出 ───────────────────────────────────────────────

  if (CSV_MODE) {
    const header = [
      'id', 'title', 'sourceType', 'currentTask', 'probableTask',
      'contentRole', 'completenessStatus',
      'allowedForRag', 'excludeFromEval', 'needsHumanReview',
      'qualityNotes',
    ].join(',')
    const csvRows = rows.map(r => [
      r.id,
      JSON.stringify(r.title),
      r.sourceType,
      r.task ?? '',
      r.probableTask ?? '',
      r.contentRole,
      r.completenessStatus,
      r.allowedForRag,
      r.excludeFromEval,
      r.needsHumanReview,
      JSON.stringify(r.qualityNotes.join(' | ')),
    ].join(','))
    await fs.mkdir(path.dirname(CSV_PATH), { recursive: true })
    await fs.writeFile(CSV_PATH, [header, ...csvRows].join('\n'), 'utf8')
    console.log(`\nCSV 已写出: ${CSV_PATH}`)
  }

  console.log('\n✅ Dry-run 完成，未写入任何数据库字段。')
  console.log('   确认规则后执行 --write 写入 contentRole/completenessStatus/probableTask/allowedForRag/excludeFromEval/qualityNotes')

  await prisma.$disconnect()
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
