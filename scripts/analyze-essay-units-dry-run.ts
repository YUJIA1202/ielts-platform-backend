/**
 * analyze-essay-units-dry-run.ts  v1.0  —  只读扫描
 *
 * 分析 535 篇 KnowledgeDocument 的内部 essay unit 结构：
 *   - 估算每个文档包含多少个 essay unit
 *   - 检测多篇 / 多版本 / 缺题目 / 只有片段 / 讲义材料
 *   - 跨文档 promptHash 相同性分析（同题不同文 vs 真正重复）
 *
 * 不写入数据库，不修改任何字段，不改 schema。
 *
 * 用法：
 *   npx tsx scripts/analyze-essay-units-dry-run.ts           # 控制台报告
 *   npx tsx scripts/analyze-essay-units-dry-run.ts --csv     # 同时输出 CSV
 */

import 'dotenv/config'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import prisma from '../src/prisma'

const CSV_MODE = process.argv.includes('--csv')
const CSV_PATH = path.resolve('data/essay-units-dry-run.csv')

// ── Types ────────────────────────────────────────────────────────────────────

type PTask    = 'TASK1' | 'TASK2' | null
type VLabel   = 'original' | 'revised' | 'returned' | 'model' |
                'paragraph_sample' | 'teacher_explanation' | 'teaching_material' | 'unknown'
type CRole    = 'REVIEW_EXAMPLE' | 'MODEL_ESSAY' | 'MODEL_PARAGRAPH' |
                'TEACHING_NOTE' | 'MIXED' | 'NEEDS_REVIEW'
type CStatus  = 'COMPLETE' | 'PARTIAL' | 'MISSING_PROMPT' |
                'MULTI_ESSAY_DOCUMENT' | 'MIXED_TASK_DOCUMENT' | 'NEEDS_REVIEW'
type Conf     = 'HIGH' | 'MEDIUM' | 'LOW'

interface EssayUnit {
  documentId:             number
  title:                  string
  sourceType:             string
  estimatedUnitCount:     number
  unitIndex:              number
  unitStartOffset:        number | null
  unitEndOffset:          number | null
  promptText:             string | null
  promptHash:             string | null
  essayTextLength:        number
  essayTextHash:          string
  probableTask:           PTask
  probableSubtype:        string | null
  contentRoleSuggestion:  CRole
  completenessSuggestion: CStatus
  versionLabel:           VLabel
  hasPrompt:              boolean
  hasIntro:               boolean
  hasBody:                boolean
  hasConclusion:          boolean
  confidence:             Conf
  qualityNotes:           string[]
  needsManualReview:      boolean
  splitReason:            string
  duplicateCandidate:     boolean
}

// ── Constants ────────────────────────────────────────────────────────────────

const TEACHING_KW = [
  '拓展', '补充', '参考', '思路', '资料', '讲义', '附件', '说明', '解析',
  '额外', '附加', '语料', '词汇', '模板', '框架', '大纲',
  '范文解析', '结构分析', '总结', '附录',
]
const TASK2_KW = ['大作文', '报告', '优缺点', '双边', '程度同意', '讨论题']
const TASK1_KW = ['小作文', '柱状图', '饼图', '折线', '地图', '流程图', '线图']
const ALL_ESSAY_KW = [...TASK2_KW, ...TASK1_KW, '比较']

const VERSION_MAP: Array<[RegExp, VLabel]> = [
  [/初稿|一稿|第一稿|\bdraft[\s_-]*1\b/i,           'original'],
  [/修改稿|改后|\brevised\b|\bdraft[\s_-]*2\b/i,    'revised'],
  [/返稿|三稿|第三稿|\breturned\b/i,                'returned'],
  [/范文|\bmodel[\s_-]?essay\b|高分|满分/i,          'model'],
  [/主体段|段落范文|\bparagraph[\s_-]?sample\b/i,    'paragraph_sample'],
  [/解析|讲解|思路|\banalysis\b|\bexplanation\b/i,   'teacher_explanation'],
  [/拓展|补充|资料|语料|词汇|模板|\bextra\b|\bsupplementary\b/i, 'teaching_material'],
]

const INTRO_PATTERNS = [
  // Task2 引言
  /\bin (recent|today|modern|contemporary) (years|times|society|world)/i,
  /\b(many|some|most|a number of) people (think|believe|argue|feel|claim)/i,
  /\bnowadays\b/i,
  /\bit is (often|widely|commonly|generally) (believed|argued|said|claimed)/i,
  /\bthere (is|has been) (a growing|an increasing|much|considerable|heated)/i,
  // Task1 引言
  /\bthe (bar chart|pie chart|line graph|chart|graph|table|diagram|map|process) (show|illustrat|describ|compare|present|reveal|highlight)/i,
  /\baccording to the (chart|graph|table|diagram|map)/i,
  /\bas (shown|illustrated|depicted|can be seen) (in|from) the/i,
  /\bthe (given|provided|following) (chart|graph|table|diagram|figure)/i,
]

const CONCLUSION_PATTERNS = [
  /\bin conclusion\b/i,
  /\bto (conclude|summarize|sum up)\b/i,
  /\bin summary\b/i,
  /\boverall[,\s]/i,
  /\ball in all\b/i,
  /\btaking everything (into account|into consideration|together)\b/i,
]

const PROMPT_MARKERS = [
  /\?/,
  /discuss both (views|sides)/i,
  /to what extent/i,
  /summaris[ez] the information/i,
  /give (your|their) own opinion/i,
  /the (chart|graph|table|diagram|map|process) (show|illustrat|describ)/i,
  /write at least \d+ words/i,
  /you should spend (about )?\d+ minutes/i,
  /题目[:：]/,
  /话题[:：]/,
  /作文题/,
]

// Explicit multi-unit boundary markers in rawText
const BOUNDARY_PATTERNS: Array<[RegExp, Conf]> = [
  [/^题目\s*[一二三四五六七八九十\d]+\s*[:：]/m,  'HIGH'],
  [/^第\s*[一二三四五六七八九十\d]+\s*[篇题]\s*[:：]?/m, 'HIGH'],
  [/^作文\s*[一二三四五六七八九十\d]+\s*[:：]/m,  'HIGH'],
  [/^[-=*]{8,}$/m,                                'HIGH'],
]

// IELTS task instruction phrases — multiple occurrences may indicate multi-essay
const TASK_INSTRUCTION_RE = [
  /to what extent do you (agree|disagree)/gi,
  /discuss both (views|sides)/gi,
  /do the advantages outweigh the disadvantages/gi,
  /what are the (main )?(advantages? and disadvantages?|causes? and (solutions?|effects?))/gi,
]

// ── Utils ────────────────────────────────────────────────────────────────────

function sha16(text: string): string {
  return createHash('sha256')
    .update(text.replace(/\s+/g, ' ').trim().toLowerCase())
    .digest('hex')
    .slice(0, 16)
}

function englishRatio(text: string): number {
  const ascii = (text.match(/[a-zA-Z]/g) || []).length
  const cjk   = (text.match(/[一-鿿]/g) || []).length
  return ascii / Math.max(ascii + cjk, 1)
}

function extractEnglishEssay(rawText: string): string {
  return rawText
    .split(/\n\n+/)
    .filter(p => p.trim().length > 30 && englishRatio(p) > 0.45)
    .join('\n\n')
}

function detectTask(title: string, rawText: string): PTask {
  if (/\d+大/.test(title) || TASK2_KW.some(k => title.includes(k))) return 'TASK2'
  if (/\d+小/.test(title) || TASK1_KW.some(k => title.includes(k))) return 'TASK1'
  const sample = (title + ' ' + rawText.slice(0, 3000)).toLowerCase()
  if (/to what extent|discuss both|advantages outweigh|双边|优缺点|程度同意/.test(sample)) return 'TASK2'
  if (/the (chart|graph|table|diagram) show|summarise the information|bar chart|pie chart|line graph/.test(sample)) return 'TASK1'
  return null
}

function extractPrompt(rawText: string): string | null {
  const head = rawText.slice(0, 1800)

  // Try IELTS-style prompt: find last "?" in first 1800 chars
  const lastQ = head.lastIndexOf('?')
  if (lastQ > 40) {
    const candidate = head.slice(0, Math.min(lastQ + 80, 1500)).trim()
    if (candidate.length > 30) return candidate.slice(0, 600)
  }

  // Chinese prompt marker
  const m = head.match(/[题话作][目题文][:：]\s*([^\n]{30,})/)
  if (m) return m[0].slice(0, 300)

  return null
}

function paraCount(text: string): number {
  return text.split(/\n\n+/).filter(p => p.trim().length > 30).length
}

// ── Multi-unit detection ─────────────────────────────────────────────────────

interface MultiSignal {
  isMulti:        boolean
  confidence:     Conf
  estimatedCount: number
  reason:         string
  boundaries:     number[]  // character offsets where new units start
}

function detectMultiUnit(rawText: string, title: string): MultiSignal {
  // 1. Explicit boundary markers in rawText (HIGH)
  for (const [pattern, conf] of BOUNDARY_PATTERNS) {
    const re = new RegExp(pattern.source, 'gm')
    const matches = [...rawText.matchAll(re)]
    if (matches.length >= 2) {
      return {
        isMulti: true, confidence: conf,
        estimatedCount: matches.length,
        reason: `${matches.length}× boundary marker "${matches[0][0].trim()}" in rawText`,
        boundaries: matches.map(m => m.index!),
      }
    }
  }

  // 2. Title: "+" or "＋" between known essay types (HIGH)
  if ((title.includes('+') || title.includes('＋')) &&
      ALL_ESSAY_KW.some(k => title.includes(k))) {
    return { isMulti: true, confidence: 'HIGH', estimatedCount: 2,
      reason: '"+" in title with essay-type keywords', boundaries: [] }
  }

  // 3. Title: "大小作文" compound (HIGH)
  if (/大小作文|小大作文/.test(title)) {
    return { isMulti: true, confidence: 'HIGH', estimatedCount: 2,
      reason: '"大小作文" compound in title', boundaries: [] }
  }

  // 4. Title: "以及" connecting 2+ known essay types (HIGH)
  if (title.includes('以及') && ALL_ESSAY_KW.filter(k => title.includes(k)).length >= 2) {
    return { isMulti: true, confidence: 'HIGH', estimatedCount: 2,
      reason: '"以及" between two essay-type keywords in title', boundaries: [] }
  }

  // 5. Title: "," or "，" between known essay types (like "优缺点，双边，以及...")
  if ((title.includes(',') || title.includes('，')) &&
      ALL_ESSAY_KW.filter(k => title.includes(k)).length >= 3) {
    return { isMulti: true, confidence: 'HIGH', estimatedCount: 3,
      reason: '3+ essay-type keywords separated by comma in title', boundaries: [] }
  }

  // 6. Multiple task instruction phrases in rawText (MEDIUM — requires 5+)
  let phraseCount = 0
  for (const re of TASK_INSTRUCTION_RE) {
    const m = rawText.match(new RegExp(re.source, re.flags))
    if (m) phraseCount += m.length
  }
  if (phraseCount >= 5) {
    return { isMulti: true, confidence: 'MEDIUM',
      estimatedCount: Math.ceil(phraseCount / 2),
      reason: `${phraseCount} distinct IELTS task instruction phrases found (≥5)`,
      boundaries: [] }
  }

  // 7. Version markers for multiple drafts (MEDIUM)
  const verMatched = VERSION_MAP
    .filter(([p]) => p.test(rawText.slice(0, 8000)))
    .map(([, label]) => label)
  if (new Set(verMatched).size >= 2) {
    return { isMulti: true, confidence: 'MEDIUM', estimatedCount: 2,
      reason: `version markers suggest multiple drafts: ${[...new Set(verMatched)].join(' + ')}`,
      boundaries: [] }
  }

  // 8. Multiple intro patterns at positions >5000 chars apart (LOW)
  const introPos: number[] = []
  for (const p of INTRO_PATTERNS) {
    const re = new RegExp(p.source, 'gi')
    for (const m of rawText.matchAll(re)) {
      if (!introPos.length || m.index! - introPos[introPos.length - 1] > 5000) {
        introPos.push(m.index!)
      }
    }
  }
  if (introPos.length >= 3) {
    return { isMulti: true, confidence: 'LOW', estimatedCount: introPos.length,
      reason: `${introPos.length} intro-pattern occurrences >5k chars apart`,
      boundaries: introPos }
  }

  return { isMulti: false, confidence: 'HIGH', estimatedCount: 1,
    reason: 'no multi-unit signals found', boundaries: [] }
}

// ── Per-document analysis ────────────────────────────────────────────────────

function analyzeDoc(doc: {
  id:              number
  title:           string
  rawText:         string
  task:            string | null
  subtype:         string | null
  source:          { sourceType: string }
  chunkCount:      number
  annotationCount: number
}): EssayUnit[] {
  const { id, title, rawText, task, subtype } = doc
  const sourceType = doc.source.sourceType
  const notes: string[] = []

  // Teaching note?
  const teachKw = TEACHING_KW.find(k => title.includes(k))
  if (teachKw) notes.push(`teaching note: title contains "${teachKw}"`)

  // Version label (from title + early rawText)
  let versionLabel: VLabel = 'unknown'
  const versionSample = title + ' ' + rawText.slice(0, 1200)
  for (const [p, label] of VERSION_MAP) {
    if (p.test(versionSample)) { versionLabel = label; break }
  }
  if (sourceType === 'MODEL_ESSAY' && versionLabel === 'unknown') versionLabel = 'model'

  // Multi-unit detection
  const multi = detectMultiUnit(rawText, title)

  // Task
  const probableTask: PTask = detectTask(title, rawText)

  // Prompt
  const promptText = extractPrompt(rawText)
  const promptHash = promptText ? sha16(promptText) : null
  const hasPrompt  = !!promptText || PROMPT_MARKERS.some(p => p.test(rawText.slice(0, 600)))
  if (!hasPrompt) notes.push('no IELTS prompt detected in first 600 chars')

  // Structure
  const introHead     = rawText.slice(0, 1000)
  const conclusionTail = rawText.slice(-1000)
  const hasIntro      = INTRO_PATTERNS.some(p => p.test(introHead))
  const hasConclusion = CONCLUSION_PATTERNS.some(p => p.test(conclusionTail))
  const hasBody       = paraCount(rawText) >= 2
  if (!hasIntro)      notes.push('no intro pattern in first 1000 chars')
  if (!hasConclusion) notes.push('no conclusion pattern in last 1000 chars')

  // Essay hash (English portions for cross-doc comparison)
  const engText      = extractEnglishEssay(rawText)
  const essayTextHash = sha16(engText.slice(0, 5000) || rawText.slice(0, 2000))

  // Content role
  let contentRoleSuggestion: CRole
  if (teachKw)                                               contentRoleSuggestion = 'TEACHING_NOTE'
  else if (multi.isMulti && multi.confidence === 'HIGH')     contentRoleSuggestion = 'MIXED'
  else if (sourceType === 'TEACHER_REVIEW')                  contentRoleSuggestion = 'REVIEW_EXAMPLE'
  else if (sourceType === 'MODEL_ESSAY') {
    contentRoleSuggestion = (hasIntro || hasConclusion) ? 'MODEL_ESSAY' : 'MODEL_PARAGRAPH'
  } else                                                     contentRoleSuggestion = 'NEEDS_REVIEW'

  // Completeness
  let completenessSuggestion: CStatus
  if (multi.isMulti && multi.confidence === 'HIGH') {
    const hasBoth = /大小作文|小大作文/.test(title) ||
                    (title.includes('+') || title.includes('＋')) && TASK2_KW.some(k => title.includes(k)) && TASK1_KW.some(k => title.includes(k))
    completenessSuggestion = hasBoth ? 'MIXED_TASK_DOCUMENT' : 'MULTI_ESSAY_DOCUMENT'
  } else if (!hasPrompt) {
    completenessSuggestion = 'MISSING_PROMPT'
  } else if (!hasIntro && !hasConclusion) {
    completenessSuggestion = 'PARTIAL'
  } else if (hasPrompt && (hasIntro || hasConclusion) && hasBody) {
    completenessSuggestion = 'COMPLETE'
  } else {
    completenessSuggestion = 'NEEDS_REVIEW'
  }

  const needsManualReview = multi.isMulti || !hasPrompt || !!teachKw

  // Build unit(s)
  const units: EssayUnit[] = []
  const base: Omit<EssayUnit, 'unitIndex' | 'unitStartOffset' | 'unitEndOffset' | 'promptText' | 'promptHash' | 'essayTextLength' | 'essayTextHash' | 'probableTask' | 'hasPrompt' | 'hasIntro' | 'hasBody' | 'hasConclusion' | 'completenessSuggestion' | 'versionLabel' | 'qualityNotes' | 'confidence'> = {
    documentId: id, title, sourceType,
    estimatedUnitCount: multi.estimatedCount,
    probableSubtype: subtype,
    contentRoleSuggestion,
    needsManualReview,
    splitReason: multi.reason,
    duplicateCandidate: false,
  }

  if (multi.isMulti && multi.boundaries.length >= 2) {
    // Can provide approximate offsets for this multi-unit doc
    const bounds = [0, ...multi.boundaries, rawText.length]
    for (let i = 0; i < bounds.length - 1; i++) {
      const start = bounds[i], end = bounds[i + 1]
      const frag  = rawText.slice(start, end)
      const fProm = extractPrompt(frag)
      units.push({
        ...base,
        unitIndex:              i,
        unitStartOffset:        start,
        unitEndOffset:          end,
        promptText:             fProm,
        promptHash:             fProm ? sha16(fProm) : null,
        essayTextLength:        frag.length,
        essayTextHash:          sha16(extractEnglishEssay(frag).slice(0, 3000) || frag.slice(0, 1000)),
        probableTask:           detectTask(title, frag),
        hasPrompt:              PROMPT_MARKERS.some(p => p.test(frag.slice(0, 400))),
        hasIntro:               INTRO_PATTERNS.some(p => p.test(frag.slice(0, 800))),
        hasBody:                paraCount(frag) >= 2,
        hasConclusion:          CONCLUSION_PATTERNS.some(p => p.test(frag.slice(-500))),
        completenessSuggestion: i === 0 ? completenessSuggestion : 'NEEDS_REVIEW',
        versionLabel:           i === 0 ? versionLabel : 'unknown',
        confidence:             multi.confidence,
        qualityNotes:           [...notes, `unit ${i + 1}/${multi.estimatedCount} offsets [${start}-${end}]`],
      })
    }
  } else {
    units.push({
      ...base,
      unitIndex:              0,
      unitStartOffset:        null,
      unitEndOffset:          null,
      promptText,
      promptHash,
      essayTextLength:        rawText.length,
      essayTextHash,
      probableTask,
      hasPrompt,
      hasIntro,
      hasBody,
      hasConclusion,
      completenessSuggestion,
      versionLabel,
      confidence:             multi.isMulti ? multi.confidence : 'HIGH',
      qualityNotes:           notes,
    })
  }

  return units
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('  Essay Unit 切分扫描  dry-run  (只读，不写入任何数据)')
  console.log('  时间:', new Date().toISOString())
  console.log('═══════════════════════════════════════════════════════════════════\n')

  // ── Load ────────────────────────────────────────────────────────────────

  const rawDocs = await prisma.knowledgeDocument.findMany({
    select: {
      id: true, title: true, rawText: true, task: true, subtype: true,
      source: { select: { sourceType: true } },
      _count: { select: { chunks: true, annotations: true } },
    },
    orderBy: { id: 'asc' },
  })
  console.log(`加载 ${rawDocs.length} 条 KnowledgeDocument\n`)

  const docs = rawDocs.map(d => ({
    id: d.id, title: d.title, rawText: d.rawText,
    task: d.task, subtype: d.subtype,
    source: { sourceType: d.source.sourceType },
    chunkCount:      d._count.chunks,
    annotationCount: d._count.annotations,
  }))

  // ── Analyse ─────────────────────────────────────────────────────────────

  const allUnits: EssayUnit[] = []
  for (const doc of docs) {
    allUnits.push(...analyzeDoc(doc))
  }

  // One representative unit per document (unitIndex=0)
  const firstUnits = allUnits.filter(u => u.unitIndex === 0)

  // ── Cross-doc: promptHash grouping ──────────────────────────────────────

  const promptGroups = new Map<string, EssayUnit[]>()
  for (const u of allUnits) {
    if (!u.promptHash) continue
    if (!promptGroups.has(u.promptHash)) promptGroups.set(u.promptHash, [])
    promptGroups.get(u.promptHash)!.push(u)
  }
  const multiPromptGroups = [...promptGroups.entries()]
    .filter(([, us]) => us.length > 1)
    .sort((a, b) => b[1].length - a[1].length)

  // ── Cross-doc: duplicate candidate (same prompt + same essay) ───────────

  const dupMap = new Map<string, EssayUnit[]>()
  for (const u of allUnits) {
    if (!u.promptHash) continue
    const key = u.promptHash + '|' + u.essayTextHash
    if (!dupMap.has(key)) dupMap.set(key, [])
    dupMap.get(key)!.push(u)
  }
  const dupGroups = [...dupMap.entries()].filter(([, us]) => us.length > 1)
  for (const [, us] of dupGroups) for (const u of us) u.duplicateCandidate = true

  // ── Counts ──────────────────────────────────────────────────────────────

  const N = firstUnits.length
  const pct = (x: number) => x.toString().padStart(4) + '  (' + ((x / N) * 100).toFixed(1) + '%)'

  const trUnits = firstUnits.filter(u => u.sourceType === 'TEACHER_REVIEW')
  const meUnits = firstUnits.filter(u => u.sourceType === 'MODEL_ESSAY')

  const cnt = (pred: (u: EssayUnit) => boolean, arr = firstUnits) => arr.filter(pred).length

  // ── Report ──────────────────────────────────────────────────────────────

  console.log('──────────────── 整体汇总 ────────────────────────────────────────')
  console.log(`  总文档数:                             ${N}`)
  console.log(`  1. 单篇作文 (estimatedUnitCount=1):  ${pct(cnt(u => u.estimatedUnitCount === 1))}`)
  console.log(`  2. 疑似多篇 (estimatedUnitCount>1):  ${pct(cnt(u => u.estimatedUnitCount > 1))}`)
  console.log(`     其中 HIGH 置信:   ${cnt(u => u.estimatedUnitCount > 1 && u.confidence === 'HIGH')}`)
  console.log(`          MEDIUM:      ${cnt(u => u.estimatedUnitCount > 1 && u.confidence === 'MEDIUM')}`)
  console.log(`          LOW:         ${cnt(u => u.estimatedUnitCount > 1 && u.confidence === 'LOW')}`)
  console.log(`  3. 同题多版本 (version markers):      ${pct(cnt(u => u.estimatedUnitCount > 1 && u.splitReason.includes('version')))}`)
  console.log(`  4. 缺 prompt:                         ${pct(cnt(u => !u.hasPrompt))}`)
  console.log(`  5. 仅片段 PARTIAL:                    ${pct(cnt(u => u.completenessSuggestion === 'PARTIAL'))}`)
  console.log(`  6. 讲义/拓展 TEACHING_NOTE:           ${pct(cnt(u => u.contentRoleSuggestion === 'TEACHING_NOTE'))}`)
  console.log(`  7. 需人工复核:                        ${pct(cnt(u => u.needsManualReview))}`)
  console.log(`  8. duplicateCandidate (标记不删):     ${pct(cnt(u => u.duplicateCandidate))}`)
  console.log()

  console.log('──────────────── 按 sourceType 分类 ────────────────────────────')
  console.log(`  TEACHER_REVIEW 共 ${trUnits.length} 篇:`)
  console.log(`    单篇 (single):    ${cnt(u => u.estimatedUnitCount === 1, trUnits)}`)
  console.log(`    多篇 (multi):     ${cnt(u => u.estimatedUnitCount > 1,   trUnits)}`)
  console.log(`    缺 prompt:        ${cnt(u => !u.hasPrompt,                trUnits)}`)
  console.log(`    PARTIAL:          ${cnt(u => u.completenessSuggestion === 'PARTIAL', trUnits)}`)
  console.log(`    TEACHING_NOTE:    ${cnt(u => u.contentRoleSuggestion === 'TEACHING_NOTE', trUnits)}`)
  console.log()
  console.log(`  MODEL_ESSAY 共 ${meUnits.length} 篇:`)
  console.log(`    单篇 (single):    ${cnt(u => u.estimatedUnitCount === 1, meUnits)}`)
  console.log(`    多篇 (multi):     ${cnt(u => u.estimatedUnitCount > 1,   meUnits)}`)
  console.log(`    MODEL_PARAGRAPH:  ${cnt(u => u.contentRoleSuggestion === 'MODEL_PARAGRAPH', meUnits)}`)
  console.log(`    TEACHING_NOTE:    ${cnt(u => u.contentRoleSuggestion === 'TEACHING_NOTE',   meUnits)}`)
  console.log(`    缺 prompt:        ${cnt(u => !u.hasPrompt, meUnits)}`)
  console.log()

  // versionLabel distribution
  const vlCounts: Record<string, number> = {}
  for (const u of firstUnits) vlCounts[u.versionLabel] = (vlCounts[u.versionLabel] ?? 0) + 1
  console.log('──────────────── versionLabel 分布 ──────────────────────────────')
  for (const [label, c] of Object.entries(vlCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${label.padEnd(22)} ${c}`)
  }
  console.log()

  // completenessStatus distribution
  const csCounts: Record<string, number> = {}
  for (const u of firstUnits) csCounts[u.completenessSuggestion] = (csCounts[u.completenessSuggestion] ?? 0) + 1
  console.log('──────────────── completenessSuggestion 分布 ────────────────────')
  for (const [st, c] of Object.entries(csCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${st.padEnd(24)} ${c}`)
  }
  console.log()

  // ── Multi-unit docs ──────────────────────────────────────────────────────
  const multiDocs = firstUnits.filter(u => u.estimatedUnitCount > 1)
    .sort((a, b) => b.estimatedUnitCount - a.estimatedUnitCount)

  console.log(`──────────────── 疑似多篇文档 (${multiDocs.length} 个) ─────────────────────`)
  for (const u of multiDocs) {
    const split = u.unitStartOffset !== null ? '(边界已估算)' : '(需人工确认)'
    console.log(`  id=${u.id ?? u.documentId} [${u.confidence}] est=${u.estimatedUnitCount} ${split} [${u.sourceType}]`)
    console.log(`    "${u.title}"`)
    console.log(`    reason: ${u.splitReason}`)
  }
  console.log()

  // ── Cross-doc: same prompt groups ────────────────────────────────────────
  console.log('──────────────── 跨文档相同题目分析 ────────────────────────────')
  console.log(`  有 promptHash 的文档:     ${allUnits.filter(u => u.promptHash).length}`)
  console.log(`  promptHash 相同的分组:    ${multiPromptGroups.length} 组`)
  const samePrDiffEssay = multiPromptGroups.filter(([, us]) => new Set(us.map(u => u.essayTextHash)).size > 1)
  const samePrSameEssay = multiPromptGroups.filter(([, us]) => new Set(us.map(u => u.essayTextHash)).size === 1)
  console.log(`    同题不同文章:           ${samePrDiffEssay.length} 组  ← 保留，各有价值`)
  console.log(`    同题同文章(dup候选):    ${samePrSameEssay.length} 组  ← 标记，不删除`)
  console.log()

  if (samePrDiffEssay.length > 0) {
    console.log('  同题不同文章 Top 10 (promptHash 相同，essayHash 不同):')
    for (const [hash, units] of samePrDiffEssay.slice(0, 10)) {
      const uniqEssay = new Set(units.map(u => u.essayTextHash)).size
      console.log(`    promptHash=${hash} → ${units.length} 篇文档, ${uniqEssay} 种不同文章`)
      for (const u of units.slice(0, 4)) {
        console.log(`      id=${u.documentId} "${u.title.slice(0, 45)}" [${u.sourceType}]`)
      }
      if (units.length > 4) console.log(`      … 还有 ${units.length - 4} 篇`)
    }
    console.log()
  }

  // ── Duplicate candidates ─────────────────────────────────────────────────
  if (dupGroups.length > 0) {
    console.log(`──────────────── duplicateCandidate (${dupGroups.length} 组，只标记不删除) ────────`)
    for (const [key, units] of dupGroups.slice(0, 15)) {
      const [ph, eh] = key.split('|')
      console.log(`  promptHash=${ph}  essayHash=${eh}  → ${units.length} 份`)
      for (const u of units) {
        console.log(`    id=${u.documentId} "${u.title.slice(0, 50)}"  [${u.sourceType}]`)
      }
    }
    console.log()
  }

  // ── Special samples requested ─────────────────────────────────────────────
  const SPECIAL_TITLE_KW = [
    'miriam', '大小作文', 'food 优缺点', 'noora', '双边剩余',
    '拓展', '补充', '参考', '思路', '资料', '讲义',
    '小作文5',
  ]
  const specialUnits = firstUnits.filter(u =>
    SPECIAL_TITLE_KW.some(k => u.title.toLowerCase().includes(k.toLowerCase()))
  )

  console.log(`──────────────── 重点文档样例 (${specialUnits.length} 篇) ─────────────────────`)
  for (const u of specialUnits) {
    console.log(`  id=${u.documentId}  [${u.sourceType}]  "${u.title}"`)
    console.log(`    estimatedUnits: ${u.estimatedUnitCount}  (${u.confidence})  version: ${u.versionLabel}`)
    console.log(`    role:  ${u.contentRoleSuggestion.padEnd(16)}  completeness: ${u.completenessSuggestion}`)
    console.log(`    prompt:${u.hasPrompt ? '✓' : '✗'}  intro:${u.hasIntro ? '✓' : '✗'}  body:${u.hasBody ? '✓' : '✗'}  conclusion:${u.hasConclusion ? '✓' : '✗'}`)
    console.log(`    dup:   ${u.duplicateCandidate}   needsReview: ${u.needsManualReview}`)
    console.log(`    split: ${u.splitReason}`)
    if (u.qualityNotes.length) console.log(`    notes: ${u.qualityNotes.join(' | ')}`)
    console.log()
  }

  // ── Summary answers to the 10 questions ──────────────────────────────────
  const canAutoSplit = multiDocs.filter(u => u.unitStartOffset !== null && u.confidence === 'HIGH').length
  const needManual   = multiDocs.filter(u => u.unitStartOffset === null).length

  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  回答 10 个核心问题')
  console.log('══════════════════════════════════════════════════════════════════')
  console.log()
  console.log(`  Q1. 单篇作文，可安全视为一篇:         ${cnt(u => u.estimatedUnitCount === 1)}`)
  console.log(`  Q2. 疑似多篇文档:                      ${cnt(u => u.estimatedUnitCount > 1)}`)
  console.log(`  Q3. 同题多版本 (version markers):      ${cnt(u => u.estimatedUnitCount > 1 && u.splitReason.includes('version'))}`)
  console.log(`  Q4. 缺 prompt:                         ${cnt(u => !u.hasPrompt)}`)
  console.log(`  Q5. 仅片段 / PARTIAL:                  ${cnt(u => u.completenessSuggestion === 'PARTIAL')}`)
  console.log(`  Q6. MODEL_ESSAY 实为 PARAGRAPH/NOTE:   ${cnt(u => u.sourceType === 'MODEL_ESSAY' && (u.contentRoleSuggestion === 'MODEL_PARAGRAPH' || u.contentRoleSuggestion === 'TEACHING_NOTE'))}`)
  console.log(`  Q7. TEACHER_REVIEW 实为讲义/混合:      ${cnt(u => u.sourceType === 'TEACHER_REVIEW' && (u.contentRoleSuggestion === 'TEACHING_NOTE' || u.contentRoleSuggestion === 'MIXED'))}`)
  console.log(`  Q8. 同 promptHash 不同 essayHash 组:   ${samePrDiffEssay.length} 组`)
  console.log(`  Q9. 同 promptHash + 同 essayHash 组:   ${samePrSameEssay.length} 组  (dup 候选)`)
  console.log(`  Q10.真正 duplicateCandidate 文档数:    ${cnt(u => u.duplicateCandidate)}  (只标记，不删除)`)
  console.log()

  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  建议')
  console.log('══════════════════════════════════════════════════════════════════')
  console.log()
  console.log(`  1. 是否建议新增 KnowledgeEssayUnit 表:`)
  console.log(`     → 是。KnowledgeDocument 当前同时承担"文件容器"和"一篇作文"`)
  console.log(`       两种语义，粒度错误。essay-level 质量标签必须放在 essay 层。`)
  console.log()
  console.log(`  2. 最小字段 (KnowledgeEssayUnit):`)
  console.log(`     documentId, unitIndex, promptText, promptHash, essayText, essayTextHash`)
  console.log(`     task, probableTask, subtype, contentRole, completenessStatus,`)
  console.log(`     versionLabel, versionGroupId, revisionNo,`)
  console.log(`     hasPrompt, hasIntro, hasBody, hasConclusion,`)
  console.log(`     allowedForRag, excludeFromEval, duplicateCandidate, qualityNotes`)
  console.log()
  console.log(`  3. EssayUnit ↔ Chunk/Annotation 映射:`)
  console.log(`     → 建议在 KnowledgeChunk 上加 essayUnitId (nullable)，`)
  console.log(`       无需单独映射表。迁移时按 chunkIndex 范围推断，人工校正。`)
  console.log()
  console.log(`  4. 可自动拆分 (有明确边界):      ${canAutoSplit} 篇`)
  console.log(`     必须人工确认 (边界不明确):    ${needManual} 篇`)
  console.log()
  console.log(`  5. 是否继续 document-level 质量标签写入:`)
  console.log(`     → 不建议。document-level 标签粒度是文件级，但`)
  console.log(`       completenessStatus / contentRole 的语义是作文级。`)
  console.log(`       唯一例外：可先写 allowedForRag=false 给`)
  console.log(`       明确混合任务文档 (MIXED_TASK_DOCUMENT 类，约 3–8 篇)。`)
  console.log()

  // ── CSV output ────────────────────────────────────────────────────────────
  if (CSV_MODE) {
    const header = [
      'documentId', 'title', 'sourceType', 'estimatedUnitCount', 'unitIndex',
      'unitStartOffset', 'unitEndOffset',
      'promptHash', 'essayTextHash', 'essayTextLength',
      'probableTask', 'probableSubtype',
      'contentRoleSuggestion', 'completenessSuggestion', 'versionLabel',
      'hasPrompt', 'hasIntro', 'hasBody', 'hasConclusion',
      'confidence', 'needsManualReview', 'duplicateCandidate',
      'splitReason', 'qualityNotes',
    ].join(',')

    const csvRows = allUnits.map(u => [
      u.documentId,
      JSON.stringify(u.title),
      u.sourceType,
      u.estimatedUnitCount,
      u.unitIndex,
      u.unitStartOffset ?? '',
      u.unitEndOffset ?? '',
      u.promptHash ?? '',
      u.essayTextHash,
      u.essayTextLength,
      u.probableTask ?? '',
      u.probableSubtype ?? '',
      u.contentRoleSuggestion,
      u.completenessSuggestion,
      u.versionLabel,
      u.hasPrompt,
      u.hasIntro,
      u.hasBody,
      u.hasConclusion,
      u.confidence,
      u.needsManualReview,
      u.duplicateCandidate,
      JSON.stringify(u.splitReason),
      JSON.stringify(u.qualityNotes.join(' | ')),
    ].join(','))

    await fs.mkdir(path.dirname(CSV_PATH), { recursive: true })
    await fs.writeFile(CSV_PATH, [header, ...csvRows].join('\n'), 'utf8')
    console.log(`\nCSV 已写出: ${CSV_PATH}  (${allUnits.length} 行)`)
  }

  console.log('\n✅ Dry-run 完成。未写入任何数据库字段。')
  await prisma.$disconnect()
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
