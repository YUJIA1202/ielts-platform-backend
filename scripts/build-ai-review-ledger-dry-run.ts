import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'

interface ExtractedComment {
  commentId: string
  paragraphIndex: number
  anchorText: string
  feedback: string
}

interface ExtractedDocument {
  collection: 'TEACHER_REVIEW' | 'MODEL_ESSAY'
  fileName: string
  sourcePath: string
  rawText: string
  paragraphs: string[]
  comments: ExtractedComment[]
}

interface ExperimentManifest {
  documents: ExtractedDocument[]
}

type SentenceSource = 'STUDENT' | 'TEACHER' | 'UNKNOWN'
type SentenceRole = 'ORIGINAL' | 'REWRITE' | 'MODEL_ESSAY' | 'TEACHING_NOTE' | 'GRAMMAR_LESSON' | 'UNKNOWN'
type CoverageGrain = 'SENTENCE' | 'PARAGRAPH'
type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'NA'
type AnnotationNature = 'ERROR_POINT' | 'EXPLANATION' | 'REWRITE' | 'EXPANSION' | 'ENCOURAGEMENT'

interface SentenceRow {
  sid: string
  document: string
  sentenceSource: SentenceSource
  sentenceRole: SentenceRole
  text: string
  charStart: number | null
  charEnd: number | null
  coverageGrain: CoverageGrain
  multiSent: boolean
  revisionOf: string
  revisionScope: string
}

interface AnnotationRow {
  cid: string
  document: string
  targetSentences: string[]
  crossSentence: boolean
  anchorRaw: string
  fullWord: string
  issueType: string[]
  rubric: string[]
  severity: Severity
  annotationNature: AnnotationNature
  mergedFrom: string[]
  evaluationBy: 'AI' | 'NEEDS_REVIEW'
}

interface LocatedAnchor {
  start: number | null
  end: number | null
  anchor: string
}

const DEFAULT_MANIFEST = path.resolve('data/ai-review-experiment/manifest.json')
const DEFAULT_OUTPUT_DIR = path.resolve('data/ai-review-experiment/ledger-dry-run')
const SENTENCE_END_RE = /[.!?。！？]/

function argValue(name: string, fallback: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : fallback
}

function argLimit() {
  const index = process.argv.indexOf('--limit')
  if (index < 0 || !process.argv[index + 1]) return null
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) && value > 0 ? value : null
}

function normalize(text: string) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function chineseRatio(text: string) {
  if (!text.length) return 0
  return (text.match(/[\u3400-\u9fff]/g) || []).length / text.length
}

function containsAny(text: string, keywords: string[]) {
  const lower = text.toLowerCase()
  return keywords.some(keyword => lower.includes(keyword.toLowerCase()))
}

function locateAnchor(document: ExtractedDocument, comment: ExtractedComment, occurrenceByAnchor: Map<string, number>): LocatedAnchor {
  const anchor = comment.anchorText.trim()
  if (!anchor) return { start: null, end: null, anchor }

  const key = normalize(anchor)
  const occurrence = occurrenceByAnchor.get(key) ?? 0
  occurrenceByAnchor.set(key, occurrence + 1)

  let from = 0
  for (let i = 0; i <= occurrence; i++) {
    const next = document.rawText.indexOf(anchor, from)
    if (next === -1) break
    if (i === occurrence) return { start: next, end: next + anchor.length, anchor }
    from = next + anchor.length
  }

  const first = document.rawText.indexOf(anchor)
  if (first >= 0) return { start: first, end: first + anchor.length, anchor }

  return { start: null, end: null, anchor }
}

function paragraphFallback(document: ExtractedDocument, comment: ExtractedComment) {
  const direct = document.paragraphs[comment.paragraphIndex]
  if (direct) return direct
  const anchor = comment.anchorText.trim()
  return document.paragraphs.find(paragraph => anchor && paragraph.includes(anchor)) ?? anchor
}

function expandToSentenceBlock(rawText: string, located: LocatedAnchor, fallbackText: string) {
  if (located.start == null || located.end == null) {
    return {
      text: fallbackText.trim(),
      charStart: null,
      charEnd: null,
      coverageGrain: 'PARAGRAPH' as CoverageGrain,
    }
  }

  let start = located.start
  while (start > 0 && !SENTENCE_END_RE.test(rawText[start - 1])) start--
  while (start < located.start && /\s/.test(rawText[start])) start++

  let end = located.end
  while (end < rawText.length && !SENTENCE_END_RE.test(rawText[end - 1])) end++
  while (end < rawText.length && /\s/.test(rawText[end])) end++

  return {
    text: rawText.slice(start, end).trim(),
    charStart: start,
    charEnd: end,
    coverageGrain: 'SENTENCE' as CoverageGrain,
  }
}

function isCrossSentence(anchor: string, unitText: string) {
  const sentenceEndsInAnchor = (anchor.match(/[.!?。！？]/g) || []).length
  const sentenceEndsInUnit = (unitText.match(/[.!?。！？]/g) || []).length
  return (sentenceEndsInAnchor >= 1 && anchor.length > 80) || sentenceEndsInUnit > 1
}

function detectRole(feedback: string, anchor: string, document: ExtractedDocument): Pick<SentenceRow, 'sentenceSource' | 'sentenceRole'> {
  const sample = `${feedback}\n${anchor}\n${document.fileName}`
  if (containsAny(sample, ['Teaching note']) && containsAny(sample, ['语法', 'grammar'])) {
    return { sentenceSource: 'TEACHER', sentenceRole: 'GRAMMAR_LESSON' }
  }
  if (containsAny(sample, ['Teaching note'])) {
    return { sentenceSource: 'TEACHER', sentenceRole: 'TEACHING_NOTE' }
  }
  if (containsAny(sample, ['Model essay', '范文'])) {
    return { sentenceSource: 'TEACHER', sentenceRole: 'MODEL_ESSAY' }
  }
  if (containsAny(sample, ['Rewrite', '我写的', '改写'])) {
    return { sentenceSource: 'TEACHER', sentenceRole: 'REWRITE' }
  }
  if (document.collection === 'MODEL_ESSAY') {
    return { sentenceSource: 'TEACHER', sentenceRole: 'MODEL_ESSAY' }
  }
  if (anchor && chineseRatio(anchor) > 0.25) {
    return { sentenceSource: 'TEACHER', sentenceRole: 'UNKNOWN' }
  }
  return { sentenceSource: 'STUDENT', sentenceRole: 'ORIGINAL' }
}

function restoreFullWord(unitText: string, anchor: string) {
  const cleanAnchor = anchor.trim()
  if (!cleanAnchor) return ''
  const index = unitText.indexOf(cleanAnchor)
  if (index === -1) return cleanAnchor

  const wordChar = /[A-Za-z'-]/
  let start = index
  let end = index + cleanAnchor.length

  while (start > 0 && wordChar.test(unitText[start - 1])) start--
  while (end < unitText.length && wordChar.test(unitText[end])) end++

  return unitText.slice(start, end).trim()
}

function classify(feedback: string, anchor: string, role: SentenceRole): Omit<AnnotationRow, 'cid' | 'document' | 'targetSentences' | 'crossSentence' | 'anchorRaw' | 'fullWord' | 'mergedFrom'> {
  const issueType = new Set<string>()
  const rubric = new Set<string>()
  let annotationNature: AnnotationNature = 'ERROR_POINT'
  let severity: Severity = 'MEDIUM'

  const add = (issue: string, dims: string[], sev: Severity = severity) => {
    issueType.add(issue)
    dims.forEach(dim => rubric.add(dim))
    severity = sev
  }

  if (role === 'GRAMMAR_LESSON') {
    return { issueType: ['教学说明'], rubric: ['GRA'], severity: 'NA', annotationNature: 'EXPLANATION', evaluationBy: 'AI' }
  }
  if (role === 'TEACHING_NOTE') {
    return { issueType: ['教学说明'], rubric: [], severity: 'NA', annotationNature: 'EXPLANATION', evaluationBy: 'AI' }
  }
  if (role === 'REWRITE') {
    return { issueType: ['教师改写'], rubric: [], severity: 'NA', annotationNature: 'REWRITE', evaluationBy: 'AI' }
  }
  if (role === 'MODEL_ESSAY') {
    return { issueType: ['范文段'], rubric: [], severity: 'NA', annotationNature: 'REWRITE', evaluationBy: 'AI' }
  }

  if (containsAny(feedback, ['不错', '很好', '可以', 'good', 'nice', '清楚'])) {
    annotationNature = 'ENCOURAGEMENT'
    add('正面肯定', [], 'NA')
  }
  if (containsAny(feedback, ['提示', '或者这里说', '可以补充', '拓展', '举一反三'])) {
    annotationNature = 'EXPANSION'
    add('教学说明', [], 'NA')
  }
  if (containsAny(feedback, ['指什么', '这啥', '看不懂', '什么意思']) || feedback.trim() === '?') {
    add('表意不清', ['CC'], 'HIGH')
  }
  if (containsAny(feedback, ['没论述出来', '论述不充分', '展开不够'])) add('逻辑/衔接', ['CC', 'LR'], 'HIGH')
  if (containsAny(feedback, ['逻辑不清', '前后', '衔接', '因果', '连贯'])) add('逻辑/衔接', ['TR', 'CC'], 'HIGH')
  if (containsAny(feedback, ['题目', '任务', '偏题', '审题', '没有回应', '没回答', 'task response'])) add('任务回应', ['TR'], 'HIGH')
  if (containsAny(feedback, ['绝对', '太绝对', 'always', 'never'])) add('表述绝对', ['TR', 'LR'], 'MEDIUM')

  if (containsAny(feedback, ['冠词', 'the ', ' a ', ' an ', '裸奔'])) add('冠词/可数名词', ['GRA'], 'MEDIUM')
  if (containsAny(feedback, ['可数', '不可数', '单复数', 'plural', 's不要', '不需要s'])) add('冠词/可数名词', ['GRA'], 'MEDIUM')
  if (containsAny(feedback, ['主谓', '主语', '谓语'])) add('主谓一致', ['GRA'], 'MEDIUM')
  if (containsAny(feedback, ['时态', 'tense'])) add('时态一致', ['GRA'], 'MEDIUM')
  if (containsAny(feedback, ['虚拟语气'])) add('虚拟语气', ['GRA'], 'MEDIUM')
  if (containsAny(feedback, ['介词', '及物', '后接', '不能接', '只能接'])) add('介词/及物', ['GRA', 'LR'], 'MEDIUM')
  if (containsAny(feedback, ['动词形式', 'doing', 'to do', '过去分词', '现在分词'])) add('动词形式', ['GRA'], 'MEDIUM')
  if (containsAny(feedback, ['并列', '平行结构'])) add('并列不平行', ['GRA'], 'MEDIUM')
  if (containsAny(feedback, ['语法', '句子结构', '从句', '缺主语', '缺谓语', 'grammar'])) add('句子结构/语法', ['GRA'], 'MEDIUM')
  if (containsAny(feedback, ['拼写', 'spelling'])) add('拼写', ['LR'], 'LOW')
  if (containsAny(feedback, ['标点', '逗号', '句号', 'punctuation'])) add('标点', ['GRA'], 'LOW')
  if (containsAny(feedback, ['所有格'])) add('所有格', ['GRA'], 'LOW')

  if (containsAny(feedback, ['搭配', 'collocation'])) add('搭配', ['LR'], 'MEDIUM')
  if (containsAny(feedback, ['口语', '正式', 'informal', 'formal'])) add('语域不当', ['LR'], 'LOW')
  if (containsAny(feedback, ['重复', '反复'])) add('用词重复', ['LR'], 'LOW')
  if (containsAny(feedback, ['模板', '生硬'])) add('表述生硬/模板化', ['LR'], 'MEDIUM')
  if (containsAny(feedback, ['用词', '这个词', '换成', '替换', '改成']) && issueType.size === 0) {
    add('用词不当', ['LR'], 'MEDIUM')
  }

  if (issueType.size === 0) {
    issueType.add('NEEDS_REVIEW')
    severity = 'MEDIUM'
  }

  if (annotationNature !== 'ERROR_POINT' && issueType.has('NEEDS_REVIEW')) {
    issueType.delete('NEEDS_REVIEW')
    issueType.add('教学说明')
  }

  return {
    issueType: [...issueType],
    rubric: [...rubric],
    severity,
    annotationNature,
    evaluationBy: issueType.has('NEEDS_REVIEW') ? 'NEEDS_REVIEW' : 'AI',
  }
}

function sentenceKey(row: Omit<SentenceRow, 'sid'>) {
  return [
    row.document,
    row.sentenceSource,
    row.sentenceRole,
    normalize(row.text),
    row.coverageGrain,
  ].join('|')
}

function annotationKey(sentenceIds: string[], feedback: string) {
  return `${sentenceIds.join(',')}|${normalize(feedback)}`
}

function tsvEscape(value: unknown) {
  if (Array.isArray(value)) return value.join('|').replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
  return String(value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
}

async function writeTsv(filePath: string, rows: Record<string, unknown>[]) {
  const header = Object.keys(rows[0] ?? {})
  const body = rows.map(row => header.map(key => tsvEscape(row[key])).join('\t'))
  await fs.writeFile(filePath, [header.join('\t'), ...body].join('\n'), 'utf8')
}

async function main() {
  const manifestPath = argValue('--manifest', DEFAULT_MANIFEST)
  const outputDir = argValue('--output-dir', DEFAULT_OUTPUT_DIR)
  const limit = argLimit()

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as ExperimentManifest
  const documents = limit ? manifest.documents.slice(0, limit) : manifest.documents

  const sentences: SentenceRow[] = []
  const annotations: AnnotationRow[] = []
  const sentenceByKey = new Map<string, SentenceRow>()
  const annotationByKey = new Map<string, AnnotationRow>()

  for (const [docIndex, document] of documents.entries()) {
    const occurrenceByAnchor = new Map<string, number>()
    for (const comment of document.comments) {
      const located = locateAnchor(document, comment, occurrenceByAnchor)
      const fallback = paragraphFallback(document, comment)
      const role = detectRole(comment.feedback, located.anchor || fallback, document)
      const unit = role.sentenceRole === 'TEACHING_NOTE' || role.sentenceRole === 'GRAMMAR_LESSON'
        ? { text: (located.anchor || fallback).trim(), charStart: located.start, charEnd: located.end, coverageGrain: 'PARAGRAPH' as CoverageGrain }
        : expandToSentenceBlock(document.rawText, located, fallback)

      if (!unit.text) continue

      const crossSentence = isCrossSentence(located.anchor, unit.text)
      const sentenceDraft: Omit<SentenceRow, 'sid'> = {
        document: document.fileName,
        ...role,
        text: unit.text,
        charStart: unit.charStart,
        charEnd: unit.charEnd,
        coverageGrain: unit.coverageGrain,
        multiSent: crossSentence,
        revisionOf: '',
        revisionScope: crossSentence ? 'MULTI_SENTENCE' : unit.coverageGrain,
      }

      const sKey = sentenceKey(sentenceDraft)
      let sentence = sentenceByKey.get(sKey)
      if (!sentence) {
        sentence = { sid: `s${String(sentences.length + 1).padStart(5, '0')}`, ...sentenceDraft }
        sentences.push(sentence)
        sentenceByKey.set(sKey, sentence)
      }

      const fullWord = restoreFullWord(sentence.text, located.anchor)
      const classified = classify(comment.feedback, located.anchor, role.sentenceRole)
      const aKey = annotationKey([sentence.sid], comment.feedback)
      const cid = `${document.fileName}#${comment.commentId || `${docIndex}-${annotations.length}`}`
      const existing = annotationByKey.get(aKey)
      if (existing) {
        existing.mergedFrom.push(cid)
        continue
      }

      const annotation: AnnotationRow = {
        cid,
        document: document.fileName,
        targetSentences: [sentence.sid],
        crossSentence,
        anchorRaw: located.anchor,
        fullWord,
        ...classified,
        mergedFrom: [cid],
      }
      annotations.push(annotation)
      annotationByKey.set(aKey, annotation)
    }
  }

  await fs.mkdir(outputDir, { recursive: true })
  await writeTsv(path.join(outputDir, 'sentences.tsv'), sentences as unknown as Record<string, unknown>[])
  await writeTsv(path.join(outputDir, 'annotations.tsv'), annotations as unknown as Record<string, unknown>[])
  await fs.writeFile(path.join(outputDir, 'ledger.json'), JSON.stringify({ sentences, annotations }, null, 2), 'utf8')

  const needsReview = annotations.filter(row => row.evaluationBy === 'NEEDS_REVIEW').length
  const merged = annotations.reduce((sum, row) => sum + Math.max(0, row.mergedFrom.length - 1), 0)

  console.log('AI review ledger dry-run complete')
  console.log({
    manifestPath,
    outputDir,
    documents: documents.length,
    sentences: sentences.length,
    annotations: annotations.length,
    mergedDuplicates: merged,
    needsReview,
  })
}

main().catch(error => {
  console.error('Fatal:', error)
  process.exit(1)
})
