import {
  PracticeDifficulty,
  PracticeItemStatus,
  PracticeItemType,
  PracticeTab,
  Prisma,
} from '@prisma/client'
import prisma from '../../prisma'
import { generateStructuredWithProvider } from '../ai/providers'

export interface ReviewPracticeAnnotation {
  id: number
  sentenceIndex: number | null
  issueType: string
  subtype: string | null
  originalText: string
  explanation: string
  replacementText: string | null
  severity: string
}

type GeneratedLanguageItem = {
  annotationId: number
  originalSentence: string
  referenceAnswer: string
  judgeCriterion: string
  explanation: string
}

type GeneratedThinkingItem = {
  annotationId: number
  title: string
  fullChain: string[]
  missingIndex: number
  englishExpansion: string
  judgeCriterion: string
  explanation: string
}

const LANGUAGE_ISSUES = new Set(['GRAMMAR', 'VOCABULARY', 'STYLE'])
const THINKING_ISSUES = new Set(['TASK_RESPONSE', 'LOGIC', 'COHESION', 'STRUCTURE'])

export function buildReviewPracticeFocus(annotations: ReviewPracticeAnnotation[], tab: PracticeTab) {
  const allowed = tab === PracticeTab.LANGUAGE ? LANGUAGE_ISSUES : THINKING_ISSUES
  const weights: Record<string, number> = {}
  const focus = new Map<string, { count: number; sentenceRefs: Set<string> }>()
  for (const annotation of annotations) {
    if (!allowed.has(annotation.issueType)) continue
    weights[annotation.issueType] = (weights[annotation.issueType] || 0) + 1
    for (const issueType of detailedIssues(annotation, tab)) {
      weights[issueType] = (weights[issueType] || 0) + 4
      const current = focus.get(issueType) || { count: 0, sentenceRefs: new Set<string>() }
      current.count += 1
      if (annotation.sentenceIndex) current.sentenceRefs.add(`S${annotation.sentenceIndex}`)
      focus.set(issueType, current)
    }
  }
  return {
    weights,
    focus: Array.from(focus.entries())
      .map(([issueType, value]) => ({ issueType, count: value.count, sentenceRefs: Array.from(value.sentenceRefs) }))
      .sort((a, b) => b.count - a.count),
  }
}

export async function ensurePersonalizedPracticeItems(input: {
  studentId: number
  reviewId: number
  tab: PracticeTab
  topic: string | null
  questionSubtype: string | null
  annotations: ReviewPracticeAnnotation[]
}) {
  const prefix = `practice-personal-v3-${input.studentId}-${input.reviewId}-${input.tab.toLowerCase()}-`
  const existing = await prisma.practiceItem.findMany({ where: { id: { startsWith: prefix } } })
  if (existing.length) return existing

  const allowed = input.tab === PracticeTab.LANGUAGE ? LANGUAGE_ISSUES : THINKING_ISSUES
  const candidates = uniqueByDetailedIssue(input.annotations.filter(annotation => allowed.has(annotation.issueType)), input.tab)
    .slice(0, input.tab === PracticeTab.LANGUAGE ? 4 : 3)
  if (!candidates.length) return []

  try {
    if (input.tab === PracticeTab.LANGUAGE) {
      const generated = await generateLanguageTransfers(input, candidates)
      return persistLanguageTransfers(input, prefix, candidates, generated)
    }
    const generated = await generateThinkingTransfers(input, candidates)
    return persistThinkingTransfers(input, prefix, candidates, generated)
  } catch (error) {
    console.warn('[practice] personalized generation skipped:', error instanceof Error ? error.message : error)
    return []
  }
}

async function generateLanguageTransfers(
  input: Parameters<typeof ensurePersonalizedPracticeItems>[0],
  annotations: ReviewPracticeAnnotation[],
) {
  const sources = annotations.map(annotation => ({
    annotationId: annotation.id,
    sentenceRef: annotation.sentenceIndex ? `S${annotation.sentenceIndex}` : null,
    broadIssue: annotation.issueType,
    detailedIssue: detailedIssues(annotation, PracticeTab.LANGUAGE)[0] || annotation.issueType,
    studentSentence: annotation.originalText,
    teacherDiagnosis: annotation.explanation,
    teacherReplacement: annotation.replacementText,
  }))
  const fallback = { items: [] as GeneratedLanguageItem[] }
  const generation = await generateStructuredWithProvider({
    systemPrompt: '你是IELTS个性化语言迁移题生成器。必须依据本次批改已确认的错误模式生成新题，禁止复制学生原句，禁止引入第二个错误，返回严格JSON。',
    userPrompt: `作文话题：${input.topic || '通用'}\n题型：${input.questionSubtype || '通用'}\n本篇已确认错误：${JSON.stringify(sources)}\n\n为每条错误生成一条全新的英文迁移病句。新句可以沿用话题语境，但不得复用学生原句的具体表达；只保留目标错误。referenceAnswer只修复目标错误。返回 {"items":[{"annotationId":1,"originalSentence":"...","referenceAnswer":"...","judgeCriterion":"...","explanation":"中文教师解析"}]}`,
    fallbackOutput: fallback,
    temperature: 0.2,
    maxOutputTokens: 5000,
    thinkingMode: 'disabled',
    reasoningEffort: 'medium',
  })
  const validation = await generateStructuredWithProvider({
    systemPrompt: '你是IELTS练习题终审员。逐题检查是否忠实迁移指定错误、是否一句一错、答案是否完整正确、是否没有复制学生原句。删除不合格题并可修正轻微问题。返回严格JSON。',
    userPrompt: `原始错误依据：${JSON.stringify(sources)}\n待审题目：${JSON.stringify(generation.output)}\n\n返回与输入相同结构的 {"items":[...]}，只保留通过终审的题。`,
    fallbackOutput: fallback,
    temperature: 0,
    maxOutputTokens: 5000,
    thinkingMode: 'disabled',
    reasoningEffort: 'medium',
  })
  return Array.isArray((validation.output as typeof fallback).items) ? (validation.output as typeof fallback).items : []
}

async function generateThinkingTransfers(
  input: Parameters<typeof ensurePersonalizedPracticeItems>[0],
  annotations: ReviewPracticeAnnotation[],
) {
  const sources = annotations.map(annotation => ({
    annotationId: annotation.id,
    sentenceRef: annotation.sentenceIndex ? `S${annotation.sentenceIndex}` : null,
    broadIssue: annotation.issueType,
    detailedIssue: detailedIssues(annotation, PracticeTab.THINKING)[0] || annotation.issueType,
    studentSentence: annotation.originalText,
    teacherDiagnosis: annotation.explanation,
    teacherReplacement: annotation.replacementText,
  }))
  const fallback = { items: [] as GeneratedThinkingItem[] }
  const generation = await generateStructuredWithProvider({
    systemPrompt: '你是IELTS个性化论证迁移题生成器。题目必须针对本次批改已确认的TR/CC错误模式，换一个具体论证情境练同一种思维缺口，不能复制学生原句。英文展开必须是纯英文完整段落，返回严格JSON。',
    userPrompt: `作文话题：${input.topic || '通用'}\n题型：${input.questionSubtype || '通用'}\n本篇已确认错误：${JSON.stringify(sources)}\n\n为每条错误建立3至5步中文逻辑链，并挖掉一个中间环节。英文展开用2至4句纯英文完整呈现同一条逻辑链，不得夹中文语法说明。返回 {"items":[{"annotationId":1,"title":"...","fullChain":["...","...","..."],"missingIndex":1,"englishExpansion":"...","judgeCriterion":"...","explanation":"中文解析"}]}`,
    fallbackOutput: fallback,
    temperature: 0.2,
    maxOutputTokens: 6500,
    thinkingMode: 'disabled',
    reasoningEffort: 'medium',
  })
  const validation = await generateStructuredWithProvider({
    systemPrompt: '你是IELTS论证练习终审员。检查逻辑链是否针对指定错误、缺口是否位于中间、英文段落是否与中文链语义一致且为纯英文。删除不合格题并可修正轻微问题，返回严格JSON。',
    userPrompt: `原始错误依据：${JSON.stringify(sources)}\n待审题目：${JSON.stringify(generation.output)}\n\n返回与输入相同结构的 {"items":[...]}，只保留通过终审的题。`,
    fallbackOutput: fallback,
    temperature: 0,
    maxOutputTokens: 6500,
    thinkingMode: 'disabled',
    reasoningEffort: 'medium',
  })
  return Array.isArray((validation.output as typeof fallback).items) ? (validation.output as typeof fallback).items : []
}

async function persistLanguageTransfers(
  input: Parameters<typeof ensurePersonalizedPracticeItems>[0],
  prefix: string,
  annotations: ReviewPracticeAnnotation[],
  generated: GeneratedLanguageItem[],
) {
  const sourceById = new Map(annotations.map(annotation => [annotation.id, annotation]))
  const stored = []
  for (const item of generated) {
    const source = sourceById.get(Number(item.annotationId))
    const original = cleanEnglish(item.originalSentence)
    const reference = cleanEnglish(item.referenceAnswer)
    if (!source || !original || !reference || normalize(original) === normalize(reference)) continue
    if (normalize(original) === normalize(source.originalText) || original.split(/\s+/).length < 5) continue
    const issueType = detailedIssues(source, PracticeTab.LANGUAGE)[0] || source.issueType
    const id = `${prefix}${source.id}`
    stored.push(await prisma.practiceItem.upsert({
      where: { id },
      create: {
        id,
        tab: PracticeTab.LANGUAGE,
        itemType: PracticeItemType.ERROR_CORRECTION,
        topic: input.topic,
        questionSubtype: input.questionSubtype,
        issueTypes: Array.from(new Set([issueType, source.issueType])) as Prisma.InputJsonValue,
        difficulty: PracticeDifficulty.CORE,
        stem: '请修正句中的目标错误，保持原意，不要改写无关部分。',
        materials: { originalSentence: original, sourceLabel: `根据本篇 ${source.sentenceIndex ? `S${source.sentenceIndex}` : '批改'} 错误生成的迁移题` } as Prisma.InputJsonValue,
        answerKey: { text: reference, referenceAnswer: reference } as Prisma.InputJsonValue,
        acceptableAnswers: { answers: [reference] } as Prisma.InputJsonValue,
        judgePoints: { issueType, criterion: item.judgeCriterion || source.explanation } as Prisma.InputJsonValue,
        explanation: item.explanation || source.explanation,
        sourceRefs: [{ role: 'CURRENT_REVIEW_ERROR', reviewId: input.reviewId, annotationId: source.id, sentenceRef: source.sentenceIndex ? `S${source.sentenceIndex}` : null }] as Prisma.InputJsonValue,
        status: PracticeItemStatus.VALIDATED,
        stats: emptyStats(),
        changelog: [{ at: new Date().toISOString(), action: 'generated_from_review_error', promptVersion: 'practice-personal-v3' }] as Prisma.InputJsonValue,
      },
      update: {},
    }))
  }
  return stored
}

async function persistThinkingTransfers(
  input: Parameters<typeof ensurePersonalizedPracticeItems>[0],
  prefix: string,
  annotations: ReviewPracticeAnnotation[],
  generated: GeneratedThinkingItem[],
) {
  const sourceById = new Map(annotations.map(annotation => [annotation.id, annotation]))
  const stored = []
  for (const item of generated) {
    const source = sourceById.get(Number(item.annotationId))
    const chain = Array.isArray(item.fullChain) ? item.fullChain.map(value => String(value).trim()).filter(Boolean) : []
    const missingIndex = Number(item.missingIndex)
    const english = cleanEnglishExpansion(item.englishExpansion)
    if (!source || chain.length < 3 || chain.length > 5 || !Number.isInteger(missingIndex) || missingIndex <= 0 || missingIndex >= chain.length - 1 || !english) continue
    const issueType = detailedIssues(source, PracticeTab.THINKING)[0] || source.issueType
    const id = `${prefix}${source.id}`
    const displayChain = chain.map((step, index) => index === missingIndex ? '____' : step)
    stored.push(await prisma.practiceItem.upsert({
      where: { id },
      create: {
        id,
        tab: PracticeTab.THINKING,
        itemType: PracticeItemType.CHAIN_CLOZE,
        topic: input.topic,
        questionSubtype: input.questionSubtype,
        issueTypes: Array.from(new Set([issueType, source.issueType])) as Prisma.InputJsonValue,
        difficulty: PracticeDifficulty.CORE,
        stem: `补全这条针对本篇 ${source.sentenceIndex ? `S${source.sentenceIndex}` : '批改'} 思维问题的迁移论证链。`,
        materials: { displayChain, sourceLabel: `根据本篇 ${source.sentenceIndex ? `S${source.sentenceIndex}` : '批改'} 错误生成的迁移题` } as Prisma.InputJsonValue,
        answerKey: { referenceAnswer: chain[missingIndex], fullChain: chain, englishExpansion: english } as Prisma.InputJsonValue,
        acceptableAnswers: { semanticCriterion: item.judgeCriterion } as Prisma.InputJsonValue,
        judgePoints: { issueType, criterion: item.judgeCriterion || source.explanation } as Prisma.InputJsonValue,
        explanation: item.explanation || `完整逻辑链：${chain.join(' → ')}`,
        sourceRefs: [{ role: 'CURRENT_REVIEW_ERROR', reviewId: input.reviewId, annotationId: source.id, sentenceRef: source.sentenceIndex ? `S${source.sentenceIndex}` : null }] as Prisma.InputJsonValue,
        status: PracticeItemStatus.VALIDATED,
        stats: emptyStats(),
        changelog: [{ at: new Date().toISOString(), action: 'generated_from_review_error', promptVersion: 'practice-personal-v3' }] as Prisma.InputJsonValue,
      },
      update: {},
    }))
  }
  return stored
}

function uniqueByDetailedIssue(annotations: ReviewPracticeAnnotation[], tab: PracticeTab) {
  const used = new Set<string>()
  return annotations.filter(annotation => {
    const key = detailedIssues(annotation, tab)[0] || annotation.issueType
    if (used.has(key)) return false
    used.add(key)
    return true
  })
}

function detailedIssues(annotation: ReviewPracticeAnnotation, tab: PracticeTab) {
  if (annotation.subtype?.trim()) return [annotation.subtype.split(',')[0].trim().toUpperCase().replace(/\s+/g, '_')]
  const text = `${annotation.explanation} ${annotation.replacementText || ''}`.toLocaleLowerCase()
  const issues: string[] = []
  const add = (value: string) => { if (!issues.includes(value)) issues.push(value) }
  if (tab === PracticeTab.LANGUAGE) {
    if (/拼写|spelling/.test(text)) add('SPELLING')
    if (/使役|宾补|make.{0,30}形容词|宾语\s*\+\s*形容词/.test(text)) add('COMPLEMENT_STRUCTURE')
    if (/介词(?:搭配|使用|错误|缺失)|preposition|agree with/.test(text) && !/不能接介词短语/.test(text)) add('PREPOSITION')
    if (/主谓|subject.?verb/.test(text)) add('SUBJECT_VERB_AGREEMENT')
    if (/并列|平行|parallel|不定式.*限定动词/.test(text)) add('PARALLELISM')
    if (/分词|participle|现在分词/.test(text)) add('PARTICIPLE_FORM')
    if (/定语从句|先行词|relative/.test(text)) add('RELATIVE_REFERENCE')
    else if (/指代|代词|reference/.test(text)) add('REFERENCE')
    if (/搭配|collocation|中式英语|地道|不说/.test(text)) add('COLLOCATION')
    if (/重复|冗余|口语|学术写作|clich/.test(text)) add('STYLE_ACADEMIC')
    if (/用词|词义|不精确|模糊|宽泛|范围|更具体/.test(text)) add('WORD_CHOICE')
  } else {
    if (/逻辑跳跃|因果链|缺乏支撑|未说明|无法推出|不能.*推出|断裂/.test(text)) add('CHAIN_COMPLETION')
    if (/立场|观点.*不清|回应题目|转述题目|争议焦点/.test(text)) add('TASK_RESPONSE')
    if (/新信息|突兀|未提及/.test(text)) add('CONCLUSION_NEW_INFORMATION')
    if (/指代|衔接|重复/.test(text)) add('COHESION')
  }
  return issues.length ? issues : [annotation.issueType]
}

export function cleanEnglishExpansion(value: unknown) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(part => part.trim())
    .filter(part => part && !/[\u3400-\u9fff]/.test(part) && (part.match(/[A-Za-z]+/g)?.length || 0) >= 5)
    .join(' ')
    .trim()
}

function cleanEnglish(value: unknown) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return /[\u3400-\u9fff]/.test(text) ? '' : text
}

function normalize(value: string) {
  return value.toLocaleLowerCase().replace(/[“”‘’]/g, "'").replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim()
}

function emptyStats() {
  return { attempts: 0, correct: 0, partial: 0, wrong: 0, correctRate: 0, optionDistribution: {}, appealCount: 0 } as Prisma.InputJsonValue
}
