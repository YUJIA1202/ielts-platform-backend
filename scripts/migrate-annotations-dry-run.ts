/**
 * 教师批注结构化迁移脚本 v1.1
 *
 * 默认: dry-run（只读）
 * --full             : 处理全量 REVIEW_EXAMPLE chunks（而非默认 500 条）
 * --limit N          : 处理前 N 条（覆盖 --full）
 * --write            : 真正写入 KnowledgeAnnotation（必须显式加此参数）
 * --write --limit 100: 先写 100 条验证幂等性
 *
 * 幂等性：写入时每条 annotation 携带 commentId="mv6-{8位hash}"，
 *         重复运行前先 findFirst({ chunkId, commentId })，已存在则跳过。
 *
 * 审计：写入模式下自动创建 ImportBatch 记录（parserVersion, label, importedCount, notes）。
 */

import 'dotenv/config'
import { createHash } from 'crypto'
import prisma from '../src/prisma'

// ─── CLI 参数 ──────────────────────────────────────────────────────

const WRITE_MODE    = process.argv.includes('--write')
const FULL_MODE     = process.argv.includes('--full')
const PARSER_VER    = '1.1.0'

const SAMPLE_LIMIT  = (() => {
  const idx = process.argv.indexOf('--limit')
  if (idx !== -1) return parseInt(process.argv[idx + 1], 10)
  if (FULL_MODE)  return Infinity
  return WRITE_MODE ? 100 : 500   // dry-run 默认 500，write 不加 --limit 默认 100
})()

// ─── 类型定义 ──────────────────────────────────────────────────────

type AnchorTypeValue  = 'SPAN' | 'POINT_BEFORE' | 'POINT_AFTER' | 'RELATION' | 'TEACHER_NOTE'
type IssueCat         = 'GRAMMAR' | 'VOCABULARY' | 'LOGIC' | 'COHESION' | 'STRUCTURE' | 'TASK_RESPONSE' | 'STYLE' | null
type SeverityValue    = 'LOW' | 'MEDIUM' | 'HIGH'
type LocationStatus   = 'RESOLVED' | 'UNRESOLVED' | 'PENDING'

interface ParsedAnnotation {
  commentId       : string
  anchorText      : string | null
  teacherFeedback : string
  replacementText : string | null
  anchorType      : AnchorTypeValue
  issueType       : IssueCat
  issueSubtype    : string | null
  severity        : SeverityValue
  locationStatus  : LocationStatus
  parseNotes      : string[]
}

interface ParseResult {
  chunkId     : number
  documentId  : number
  rawChunkText: string
  parsed      : ParsedAnnotation | null
  error       : string | null
}

// ─── 幂等性 hash ─────────────────────────────────────────────────

/** 8 位 hex hash：chunkId + anchorText + teacherFeedback */
function makeCommentId(chunkId: number, anchorText: string | null, feedback: string): string {
  const raw = `${chunkId}|${anchorText ?? ''}|${feedback}`
  return 'mv6-' + createHash('sha256').update(raw).digest('hex').slice(0, 8)
}

// ─── 中文字符检测 ──────────────────────────────────────────────────

function chineseRatio(text: string): number {
  if (!text.length) return 0
  return (text.match(/[一-鿿]/g) || []).length / text.length
}

// ─── 主解析函数 ────────────────────────────────────────────────────

function parseChunkText(chunkId: number, chunkText: string): ParsedAnnotation {
  const notes: string[] = []

  // ① 没有 [学生原文] 标记 → TEACHER_NOTE
  if (!chunkText.includes('[学生原文]')) {
    const feedback = chunkText.split('[教师反馈]\n').slice(1).join('[教师反馈]\n').trim()
    return build(chunkId, null, feedback, 'TEACHER_NOTE', null, null, 'MEDIUM', 'UNRESOLVED', ['no_student_marker'])
  }

  const studentMarker  = '[学生原文]\n'
  const feedbackMarker = '\n\n[教师反馈]\n'
  const studentStart   = chunkText.indexOf(studentMarker)
  const feedbackSplit  = chunkText.indexOf(feedbackMarker)

  // ② 格式不完整：有 [学生原文] 但找不到 [教师反馈] 分隔
  if (feedbackSplit === -1) {
    notes.push('malformed_no_feedback_split')
    const anchor = chunkText.slice(studentStart + studentMarker.length).trim()
    return build(chunkId, anchor || null, '', 'TEACHER_NOTE', null, null, 'MEDIUM', 'UNRESOLVED', notes)
  }

  const rawAnchor   = chunkText.slice(studentStart + studentMarker.length, feedbackSplit).trim()
  const rawFeedback = chunkText.slice(feedbackSplit + feedbackMarker.length).trim()

  const anchorType    = classifyAnchorType(rawAnchor, rawFeedback, notes)
  const issueType     = classifyIssueType(rawFeedback, rawAnchor)
  const issueSubtype  = classifyIssueSubtype(rawFeedback, issueType)
  const severity      = classifySeverity(rawFeedback, issueType)
  const replacementText = extractReplacement(rawFeedback)

  // locationStatus: 有充分 anchor 则 PENDING（后续可用字符串搜索定位）；否则 UNRESOLVED
  const locationStatus: LocationStatus =
    anchorType === 'TEACHER_NOTE' || rawAnchor.length <= 3
      ? 'UNRESOLVED'
      : 'PENDING'

  return build(chunkId, rawAnchor || null, rawFeedback, anchorType, issueType, issueSubtype, severity, locationStatus, notes, replacementText)
}

function build(
  chunkId       : number,
  anchorText    : string | null,
  teacherFeedback: string,
  anchorType    : AnchorTypeValue,
  issueType     : IssueCat,
  issueSubtype  : string | null,
  severity      : SeverityValue,
  locationStatus: LocationStatus,
  parseNotes    : string[],
  replacementText: string | null = null,
): ParsedAnnotation {
  return {
    commentId: makeCommentId(chunkId, anchorText, teacherFeedback),
    anchorText,
    teacherFeedback,
    replacementText,
    anchorType,
    issueType,
    issueSubtype,
    severity,
    locationStatus,
    parseNotes,
  }
}

// ─── anchorType 分类 ──────────────────────────────────────────────

function classifyAnchorType(anchor: string, feedback: string, notes: string[]): AnchorTypeValue {
  if (!anchor) {
    notes.push('empty_anchor')
    return 'TEACHER_NOTE'
  }

  // anchor 里含大量中文 → 老师把自己的话写进了 [学生原文] 字段
  if (chineseRatio(anchor) > 0.3) {
    notes.push('anchor_is_chinese_teacher_text')
    return 'TEACHER_NOTE'
  }

  // anchor 超长（>300）→ 整段选中，视为全局批注
  if (anchor.length > 300) {
    notes.push('anchor_too_long_global')
    return 'TEACHER_NOTE'
  }

  // 短 anchor：零宽点批注
  if (anchor.length <= 3) {
    if (/^[,.\-!?;:'"()\[\]{}]+$/.test(anchor)) {
      notes.push('punctuation_anchor')
      return 'POINT_AFTER'
    }
    if (/^[A-Z]$/.test(anchor)) {
      notes.push('single_capital_anchor')
      return 'POINT_BEFORE'
    }
    if (/^[a-z]{1,3}$/.test(anchor)) {
      notes.push('short_lowercase_anchor')
      return 'POINT_AFTER'
    }
    notes.push('short_anchor_span')
    return 'SPAN'
  }

  // 段间/句间关系（需要明确的段/句指代词，避免"后面的句子缺主语"误判）
  const relationPattern = /第.句.*第.句|这两段|段落.*衔接|缺.*因果|句间|段间|这句.*那句|前后两句|上一句.*下一句/
  if (relationPattern.test(feedback) && anchor.length > 50) {
    notes.push('relation_detected')
    return 'RELATION'
  }

  return 'SPAN'
}

// ─── issueType 分类 ──────────────────────────────────────────────

const GRAMMAR_KEYWORDS = [
  '语法', '语法错误', '语法上', '语法问题',
  '可数名词', '不可数', '单复数', '时态', '词性', '虚拟语气', '比较级', '冠词', '主谓', '大写', '小写',
  '不需要s', '逗号', '标点', '句号', '拼写', 'plural', 'grammar', 'spelling', 'tense',
  '不需要逗号', '大写了', '小写了', '应该是the', '应该是a', '应该用a ', '应该用an',
  '介词', '从句', '连词', '动词', '名词', '形容词', '副词', '代词不清',
  '不能接', '只能接', '后接', '缺主语', '缺谓语', '缺宾语',
  '并列', '平行结构', '裸奔', 'countable', 'uncountable', 'article', 'preposition',
  '可数', '主语', '谓语', '宾语', '修饰', '后面加', '后面跟',
]

const VOCABULARY_KEYWORDS = [
  '换成', '替换', '改成', '可以用', '用这个', '这个词', '建议', '表达更好', '词汇', '用词',
  '记几个', '记一下', 'replace', 'word choice', '同义词', '近义词', '搭配', '短语',
  '表示的是', '如果想表示', '其实是', '应该用', '用的是', '这里应该用', '不能用这个', '用错了',
  '是X不是', '用X不用',
]

const LOGIC_KEYWORDS = [
  '逻辑', '观点不一致', '跟你开头', '跟前面', '矛盾', '因果', '不合理', '说不通',
  '前后', '一致性', 'inconsistent', 'logical', '答非所问',
]

const COHESION_KEYWORDS = [
  '衔接', '连接', '过渡', 'transition', '衔接不够', '连贯', 'cohesion', '上下文',
]

const STRUCTURE_KEYWORDS = [
  '结构', '段落', '开头', '结尾', '布局', '第一段', '主体段', 'structure', 'paragraph',
  '引入', '总结',
]

const TASK_KEYWORDS = [
  '题目', '要求', 'Task', '任务', '偏题', '没有回应', '没回答', '审题', 'task response',
]

const STYLE_KEYWORDS = [
  '太口语', '口语化', '正式', '不够正式', '文体', 'informal', 'formal',
  '删', '省', '不需要', '没必要', '可以省', '可以删', '不用', '不要加',
  '不要用这种', '奇怪的表达', '这种表达', '这样说', '这么说', '怎么能',
]

function classifyIssueType(feedback: string, anchor: string): IssueCat {
  // 注意优先级：GRAMMAR > LOGIC > COHESION > TASK > STRUCTURE > VOCABULARY > STYLE
  if (GRAMMAR_KEYWORDS.some(kw => feedback.includes(kw))) return 'GRAMMAR'
  if (LOGIC_KEYWORDS.some(kw => feedback.includes(kw)))   return 'LOGIC'
  if (COHESION_KEYWORDS.some(kw => feedback.includes(kw))) return 'COHESION'
  if (TASK_KEYWORDS.some(kw => feedback.includes(kw)))    return 'TASK_RESPONSE'
  if (STRUCTURE_KEYWORDS.some(kw => feedback.includes(kw))) return 'STRUCTURE'
  if (VOCABULARY_KEYWORDS.some(kw => feedback.includes(kw))) return 'VOCABULARY'
  if (STYLE_KEYWORDS.some(kw => feedback.includes(kw)))   return 'STYLE'
  return null
}

function classifyIssueSubtype(feedback: string, issueType: IssueCat): string | null {
  if (issueType !== 'GRAMMAR') return null
  if (feedback.includes('可数名词') || feedback.includes('单复数') || feedback.includes('不需要s') || feedback.includes('裸奔')) return 'PLURAL'
  if (feedback.includes('冠词') || /应该是(the|a|an)/.test(feedback)) return 'ARTICLE'
  if (feedback.includes('时态')) return 'TENSE'
  if (feedback.includes('大写') || feedback.includes('小写')) return 'CAPITALIZATION'
  if (feedback.includes('逗号') || feedback.includes('标点')) return 'PUNCTUATION'
  if (feedback.includes('虚拟语气')) return 'SUBJUNCTIVE'
  if (feedback.includes('词性')) return 'POS'
  if (feedback.includes('代词不清') || feedback.includes('代指不清')) return 'PRONOUN_REF'
  if (feedback.includes('介词') || feedback.includes('只能接') || feedback.includes('不能接')) return 'PREPOSITION'
  if (feedback.includes('并列') || feedback.includes('平行结构')) return 'PARALLEL'
  if (feedback.includes('主语') || feedback.includes('缺主语')) return 'SUBJECT'
  return null
}

// ─── severity 分类 ──────────────────────────────────────────────

function classifySeverity(feedback: string, issueType: IssueCat): SeverityValue {
  const lowKws  = ['可以省', '其实没必要', '可以不用', '没关系', '可以不加', '无伤大雅', '小问题']
  const highKws = ['逻辑', '观点不一致', '矛盾', '严重', '必须', '跟你开头不一致', '答非所问', '完全错误', '根本上']
  if (lowKws.some(kw => feedback.includes(kw)))  return 'LOW'
  if (highKws.some(kw => feedback.includes(kw))) return 'HIGH'
  if (issueType === 'LOGIC' || issueType === 'TASK_RESPONSE') return 'HIGH'
  if (issueType === 'STYLE') return 'LOW'
  return 'MEDIUM'
}

// ─── replacementText 提取 ─────────────────────────────────────────

function extractReplacement(feedback: string): string | null {
  const patterns = [
    /换成\s*([^\s，。！？、；：\n]{2,30})/,
    /改成\s*([^\s，。！？、；：\n]{2,30})/,
    /可以用\s*([^\s，。！？、；：\n]{2,30})/,
    /建议(?:用|写|改)?\s*([^\s，。！？、；：\n]{2,30})/,
    /"([A-Za-z][^"]{1,40})"/,
    /「([^」]{1,40})」/,
  ]
  for (const p of patterns) {
    const m = feedback.match(p)
    if (m) return m[1].trim()
  }
  return null
}

// ─── 主流程 ──────────────────────────────────────────────────────

async function run() {
  const runStartAt = new Date()

  console.log(`\n${'='.repeat(64)}`)
  console.log(`  教师批注结构化迁移  parserVersion=${PARSER_VER}`)
  console.log(`  模式: ${WRITE_MODE ? '🔴 写入数据库' : '🟢 Dry-run (只读)'}`)
  console.log(`  处理上限: ${SAMPLE_LIMIT === Infinity ? '全量' : SAMPLE_LIMIT} 条`)
  console.log(`  时间: ${runStartAt.toISOString()}`)
  console.log('='.repeat(64))

  // ① 加载 chunks
  const chunks = await prisma.knowledgeChunk.findMany({
    where: { chunkType: 'REVIEW_EXAMPLE' },
    select: { id: true, documentId: true, chunkText: true },
    ...(SAMPLE_LIMIT !== Infinity ? { take: SAMPLE_LIMIT } : {}),
    orderBy: { id: 'asc' },
  })

  console.log(`\n加载 ${chunks.length} 条 REVIEW_EXAMPLE chunks`)

  // ② 解析
  const results: ParseResult[] = []
  const stats = {
    total       : chunks.length,
    parsed      : 0,
    parseError  : 0,
    withReplacement: 0,
    anchorTypes : {} as Record<string, number>,
    issueTypes  : {} as Record<string, number>,
    severities  : {} as Record<string, number>,
    locationStatuses: {} as Record<string, number>,
    noteFreq    : {} as Record<string, number>,
  }

  for (const chunk of chunks) {
    try {
      const parsed = parseChunkText(chunk.id, chunk.chunkText)
      results.push({ chunkId: chunk.id, documentId: chunk.documentId, rawChunkText: chunk.chunkText, parsed, error: null })
      stats.parsed++

      const inc = (map: Record<string, number>, key: string) => { map[key] = (map[key] || 0) + 1 }
      inc(stats.anchorTypes,      parsed.anchorType)
      inc(stats.issueTypes,       parsed.issueType ?? 'UNKNOWN')
      inc(stats.severities,       parsed.severity)
      inc(stats.locationStatuses, parsed.locationStatus)
      if (parsed.replacementText) stats.withReplacement++
      for (const note of parsed.parseNotes) inc(stats.noteFreq, note)

    } catch (err) {
      results.push({ chunkId: chunk.id, documentId: chunk.documentId, rawChunkText: chunk.chunkText, parsed: null, error: String(err) })
      stats.parseError++
    }
  }

  // ③ 幂等性检查（dry-run 时也报告潜在重复）
  const commentIds   = results.flatMap(r => r.parsed ? [r.parsed.commentId] : [])
  const existingAnnotations = await prisma.knowledgeAnnotation.findMany({
    where: { commentId: { in: commentIds } },
    select: { commentId: true, chunkId: true },
  })
  const existingSet = new Set(existingAnnotations.map(a => a.commentId))
  const willSkip    = results.filter(r => r.parsed && existingSet.has(r.parsed.commentId)).length
  const willCreate  = results.filter(r => r.parsed && !existingSet.has(r.parsed.commentId)).length

  // ─── 报告 ──────────────────────────────────────────────────────

  console.log('\n──────────────── 解析统计 ────────────────')
  console.log(`总 chunk 数:      ${stats.total}`)
  console.log(`成功解析:         ${stats.parsed}`)
  console.log(`解析异常:         ${stats.parseError}`)
  console.log(`有替换建议:       ${stats.withReplacement}`)

  console.log('\n已存在（会跳过）:  ' + willSkip)
  console.log('将新创建:         ' + willCreate)

  const pct = (n: number) => ((n / stats.total) * 100).toFixed(1) + '%'

  console.log('\nanchorType 分布:')
  for (const [k, v] of sortDesc(stats.anchorTypes))
    console.log(`  ${k.padEnd(16)} ${String(v).padStart(5)}  (${pct(v)})`)

  console.log('\nissueType 分布:')
  for (const [k, v] of sortDesc(stats.issueTypes))
    console.log(`  ${k.padEnd(16)} ${String(v).padStart(5)}  (${pct(v)})`)

  const unknownCount = stats.issueTypes['UNKNOWN'] || 0
  console.log(`\nUNKNOWN 总数: ${unknownCount}  (${pct(unknownCount)})`)

  console.log('\nseverity 分布:')
  for (const [k, v] of sortDesc(stats.severities))
    console.log(`  ${k.padEnd(10)} ${v}`)

  console.log('\nlocationStatus 分布:')
  for (const [k, v] of sortDesc(stats.locationStatuses))
    console.log(`  ${k.padEnd(14)} ${v}  (${pct(v)})`)

  console.log('\nparseNotes 频率:')
  for (const [k, v] of sortDesc(stats.noteFreq))
    console.log(`  ${k.padEnd(40)} ${v}`)

  // ─── 样例：各 anchorType ─────────────────────────────────────

  console.log('\n──────────────── 各 anchorType 样例（各 2 条）────────────────')
  const byType = new Map<string, ParseResult[]>()
  for (const r of results) {
    if (!r.parsed) continue
    const t = r.parsed.anchorType
    if (!byType.has(t)) byType.set(t, [])
    if (byType.get(t)!.length < 2) byType.get(t)!.push(r)
  }
  for (const [t, samples] of byType) {
    console.log(`\n  [${t}]`)
    for (const s of samples) {
      const p = s.parsed!
      console.log(`    chunkId=${s.chunkId}  issueType=${p.issueType ?? '-'}  severity=${p.severity}  locationStatus=${p.locationStatus}`)
      console.log(`    anchor:   "${clip(p.anchorText ?? '', 60)}"`)
      console.log(`    feedback: "${clip(p.teacherFeedback, 80)}"`)
      if (p.replacementText) console.log(`    replace:  "${p.replacementText}"`)
      if (p.parseNotes.length) console.log(`    notes:    ${p.parseNotes.join(', ')}`)
    }
  }

  // ─── 样例：POINT_AFTER ──────────────────────────────────────

  const pointAfterSamples = results.filter(r => r.parsed?.anchorType === 'POINT_AFTER').slice(0, 5)
  if (pointAfterSamples.length) {
    console.log('\n──────────────── POINT_AFTER 样例（最多 5 条）────────────────')
    for (const s of pointAfterSamples) {
      const p = s.parsed!
      console.log(`  chunkId=${s.chunkId}  issueSubtype=${p.issueSubtype ?? '-'}`)
      console.log(`    anchor:   "${clip(p.anchorText ?? '', 40)}"`)
      console.log(`    feedback: "${clip(p.teacherFeedback, 80)}"`)
    }
  }

  // ─── 样例：TEACHER_NOTE ──────────────────────────────────────

  const tnSamples = results.filter(r => r.parsed?.anchorType === 'TEACHER_NOTE').slice(0, 5)
  if (tnSamples.length) {
    console.log('\n──────────────── TEACHER_NOTE 样例（最多 5 条）────────────────')
    for (const s of tnSamples) {
      const p = s.parsed!
      console.log(`  chunkId=${s.chunkId}  notes=${p.parseNotes.join(',')}`)
      console.log(`    anchor:   "${clip(p.anchorText ?? '(null)', 60)}"`)
      console.log(`    feedback: "${clip(p.teacherFeedback, 80)}"`)
    }
  }

  // ─── 样例：UNRESOLVED ───────────────────────────────────────

  const unresSamples = results.filter(r => r.parsed?.locationStatus === 'UNRESOLVED').slice(0, 5)
  if (unresSamples.length) {
    console.log('\n──────────────── UNRESOLVED 样例（最多 5 条）────────────────')
    for (const s of unresSamples) {
      const p = s.parsed!
      console.log(`  chunkId=${s.chunkId}`)
      console.log(`    anchor:   "${clip(p.anchorText ?? '(null)', 60)}"`)
      console.log(`    feedback: "${clip(p.teacherFeedback, 80)}"`)
    }
  }

  // ─── 20 条 UNKNOWN issueType 样例（含原始 chunkText 片段）──────

  const unknownSamples = results.filter(r => r.parsed?.issueType === null).slice(0, 20)
  if (unknownSamples.length) {
    console.log(`\n──────────────── UNKNOWN issueType 样例（${unknownSamples.length} 条）────────────────`)
    unknownSamples.forEach((s, i) => {
      const p = s.parsed!
      console.log(`\n  [${i + 1}] chunkId=${s.chunkId}  anchorType=${p.anchorType}  locationStatus=${p.locationStatus}`)
      console.log(`    anchorText:      "${clip(p.anchorText ?? '(null)', 60)}"`)
      console.log(`    teacherFeedback: "${clip(p.teacherFeedback, 100)}"`)
      // 原始 chunkText 片段（前 200 字符）
      const snippet = s.rawChunkText.replace(/\n/g, '↵').slice(0, 200)
      console.log(`    rawChunkText:    "${snippet}"`)
    })
  }

  // ─── 写入逻辑 ────────────────────────────────────────────────

  if (!WRITE_MODE) {
    console.log('\n✅ Dry-run 完成，未写入任何数据。')
    console.log('   --write --limit 100  写入前 100 条验证幂等性')
    console.log('   --write --full       全量写入')
    await prisma.$disconnect()
    return
  }

  // 创建 ImportBatch 审计记录
  const batch = await prisma.importBatch.create({
    data: {
      label        : `migrate-annotations-v6-${runStartAt.toISOString().slice(0, 10)}`,
      parserVersion: PARSER_VER,
      notes        : JSON.stringify({
        startedAt    : runStartAt.toISOString(),
        sampleLimit  : SAMPLE_LIMIT === Infinity ? 'full' : SAMPLE_LIMIT,
        totalChunks  : stats.total,
        willCreate,
        willSkip,
        issueTypeDist: stats.issueTypes,
        anchorTypeDist: stats.anchorTypes,
      }),
      isActive     : true,
    },
  })
  console.log(`\nImportBatch 已创建: id=${batch.id}  label=${batch.label}`)

  console.log('\n──────────────── 开始写入 KnowledgeAnnotation ────────────────')
  let written  = 0
  let skipped  = 0

  for (const r of results) {
    if (!r.parsed) { skipped++; continue }
    const p = r.parsed

    // 幂等性检查：已存在则跳过
    if (existingSet.has(p.commentId)) {
      skipped++
      continue
    }

    await prisma.knowledgeAnnotation.create({
      data: {
        documentId     : r.documentId,
        chunkId        : r.chunkId,
        commentId      : p.commentId,
        anchorType     : p.anchorType as any,
        anchorText     : p.anchorText,
        issueType      : p.issueType,
        issueSubtype   : p.issueSubtype,
        severity       : p.severity   as any,
        teacherFeedback: p.teacherFeedback || null,
        replacementText: p.replacementText,
        locationStatus : p.locationStatus as any,
      },
    })
    written++
    if (written % 500 === 0) {
      console.log(`  已写入 ${written}/${results.filter(r => r.parsed && !existingSet.has(r.parsed.commentId)).length}`)
    }
  }

  // 更新 ImportBatch 的 importedCount
  await prisma.importBatch.update({
    where: { id: batch.id },
    data : { importedCount: written },
  })

  const elapsed = ((Date.now() - runStartAt.getTime()) / 1000).toFixed(1)
  console.log(`\n✅ 写入完成  created=${written}  skipped=${skipped}  elapsed=${elapsed}s`)
  console.log(`   ImportBatch id=${batch.id} 已更新 importedCount=${written}`)

  await prisma.$disconnect()
}

// ─── 工具 ────────────────────────────────────────────────────────

function clip(s: string, max: number): string {
  const clean = s.replace(/\n/g, '↵')
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

function sortDesc(map: Record<string, number>): [string, number][] {
  return Object.entries(map).sort(([, a], [, b]) => b - a)
}

// ─── 入口 ────────────────────────────────────────────────────────

run().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
