import 'dotenv/config'
import {
  PracticeDifficulty,
  PracticeItemStatus,
  PracticeItemType,
  PracticeTab,
  Prisma,
} from '@prisma/client'
import prisma from '../src/prisma'
import { generateStructuredWithProvider } from '../src/services/ai/providers'

type GeneratedCorrection = {
  valid: boolean
  stemSentence: string
  referenceAnswer: string
  judgeCriterion: string
  reason?: string
}

type OptionValidation = {
  valid: boolean
  options: Array<{ id: string; correct: boolean; reason: string }>
}

function argument(name: string) {
  const prefix = `${name}=`
  return process.argv.slice(2).find(value => value.startsWith(prefix))?.slice(prefix.length) || null
}

function hasFlag(name: string) {
  return process.argv.slice(2).includes(name)
}

function normalize(value: string) {
  return value.toLocaleLowerCase().replace(/[“”‘’]/g, "'").replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim()
}

function anonymize(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\bat\s+[A-Z][A-Za-z&.'’-]*(?:\s+[A-Z][A-Za-z&.'’-]*)*\s+(?:School|College|University)\b/g, 'at a local school')
    .replace(/\bmy name is\s+[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)?/gi, "the student's name is omitted")
}

function isUsableAnnotation(annotation: {
  issueType: string | null
  issueSubtype: string | null
  anchorText: string | null
  replacementText: string | null
  teacherFeedback: string | null
}) {
  if (!annotation.issueType || !['GRAMMAR', 'VOCABULARY', 'STYLE'].includes(annotation.issueType)) return false
  const original = annotation.anchorText?.trim() || ''
  const replacement = annotation.replacementText?.trim() || ''
  const feedback = annotation.teacherFeedback?.trim() || ''
  if (!original || !replacement || !feedback || normalize(original) === normalize(replacement)) return false
  const words = original.match(/[A-Za-z]+(?:[-'][A-Za-z]+)?/g)?.length || 0
  if (words < 4 || words > 70) return false
  if (/(?:没有|无)(?:明显)?(?:语法|句法|用词|搭配|表达)?错误|结构(?:完整|成立)|无需修改|不构成错误|并非错误|不是.*错误/.test(feedback)) return false
  return true
}

function issueKey(annotation: { issueType: string | null; issueSubtype: string | null }) {
  return annotation.issueSubtype?.split(',')[0]?.trim() || annotation.issueType || 'LANGUAGE'
}

function controlledMutations(correct: string) {
  const candidates: Array<{ text: string; operation: string }> = []
  const add = (text: string, operation: string) => {
    if (normalize(text) !== normalize(correct) && !candidates.some(candidate => normalize(candidate.text) === normalize(text))) {
      candidates.push({ text, operation })
    }
  }
  if (/\b(is|are|was|were|has|have)\b/i.test(correct)) {
    add(correct.replace(/\b(is|are|was|were|has|have)\b/i, match => ({ is: 'are', are: 'is', was: 'were', were: 'was', has: 'have', have: 'has' }[match.toLowerCase()] || match)), '主谓一致反转')
  }
  if (/\b(a|an|the)\s+/i.test(correct)) add(correct.replace(/\b(a|an|the)\s+/i, ''), '删除必要冠词')
  if (/\b(with|to|for|in|on|of|by)\b/i.test(correct)) {
    add(correct.replace(/\b(with|to|for|in|on|of|by)\b/i, match => ({ with: 'to', to: 'for', for: 'of', in: 'on', on: 'in', of: 'for', by: 'with' }[match.toLowerCase()] || match)), '替换为错误介词')
  }
  if (/\b(people|students|children|companies|governments)\s+([a-z]+)\b/i.test(correct)) {
    add(correct.replace(/\b(people|students|children|companies|governments)\s+([a-z]+)\b/i, (_, subject, verb: string) => `${subject} ${verb.endsWith('s') ? verb.slice(0, -1) : `${verb}s`}`), '复数主语后的动词形式反转')
  }
  if (/,/.test(correct)) add(correct.replace(',', ''), '删除必要标点')
  return candidates.slice(0, 2)
}

function shuffleOptions<T>(values: T[], seed: number) {
  return values
    .map((value, index) => ({ value, rank: ((seed + 1) * (index + 7) * 2654435761) >>> 0 }))
    .sort((a, b) => a.rank - b.rank)
    .map(item => item.value)
}

async function assembleSingleError(input: {
  original: string
  reference: string
  issue: string
  feedback: string
}): Promise<GeneratedCorrection> {
  const fallback: GeneratedCorrection = {
    valid: false,
    stemSentence: input.original,
    referenceAnswer: input.reference,
    judgeCriterion: input.feedback,
    reason: 'model validation unavailable',
  }
  let output: GeneratedCorrection
  try {
    const result = await generateStructuredWithProvider({
      systemPrompt: '你是IELTS语言练习题校验器。题目只能来自给定真实病句、教师改写和教师批注。你可以预修复非目标错误，但不能发明新的知识点。返回严格JSON。',
      userPrompt: `真实病句：${input.original}\n教师改写：${input.reference}\n目标错误：${input.issue}\n教师批注：${input.feedback}\n\n请把题面整理成“一句一错”：stemSentence 中只保留目标错误；referenceAnswer 修复该错误且不引入新错。若素材无法可靠做成单错题，valid=false。返回 {"valid":true,"stemSentence":"...","referenceAnswer":"...","judgeCriterion":"只描述目标错误的判定标准","reason":"..."}`,
      fallbackOutput: fallback,
      temperature: 0,
      maxOutputTokens: 2400,
      thinkingMode: 'disabled',
      reasoningEffort: 'low',
    })
    output = result.output as GeneratedCorrection
  } catch {
    return fallback
  }
  if (!output.valid || !output.stemSentence?.trim() || !output.referenceAnswer?.trim() || normalize(output.stemSentence) === normalize(output.referenceAnswer)) return fallback
  return {
    valid: true,
    stemSentence: anonymize(output.stemSentence.trim()),
    referenceAnswer: anonymize(output.referenceAnswer.trim()),
    judgeCriterion: output.judgeCriterion?.trim() || input.feedback,
    reason: output.reason,
  }
}

async function validateMcq(options: Array<{ id: string; text: string; source: string; mutation?: string }>, correctId: string, issue: string) {
  const fallback: OptionValidation = { valid: false, options: [] }
  let output: OptionValidation
  try {
    const result = await generateStructuredWithProvider({
      systemPrompt: '你是IELTS选择题唯一正确性校验器。逐项判断语法和表达是否正确，返回严格JSON。',
      userPrompt: `目标知识点：${issue}\n设计正确项ID：${correctId}\n选项：${JSON.stringify(options)}\n\n逐项判断。只有恰好一项正确且它等于设计正确项时 valid=true。返回 {"valid":true,"options":[{"id":"A","correct":true,"reason":"一句话"}]}`,
      fallbackOutput: fallback,
      temperature: 0,
      maxOutputTokens: 2400,
      thinkingMode: 'disabled',
      reasoningEffort: 'low',
    })
    output = result.output as OptionValidation
  } catch {
    return fallback
  }
  const correct = (output.options || []).filter(option => option.correct)
  return output.valid && correct.length === 1 && correct[0].id === correctId ? output : fallback
}

async function rebuildTopicStats() {
  const rows = await prisma.knowledgeAnnotation.findMany({
    where: { issueType: { not: null }, document: { allowedForRag: true } },
    select: {
      issueType: true,
      issueSubtype: true,
      document: { select: { topic: true, subtype: true, question: { select: { topicCategory: true, subtype: true } } } },
    },
  })
  const groups = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const topic = row.document.question?.topicCategory || row.document.topic || 'general'
    const subtype = row.document.question?.subtype || row.document.subtype || 'UNKNOWN'
    const issue = row.issueSubtype?.split(',')[0]?.trim() || row.issueType || 'UNKNOWN'
    const key = `${topic}\u0000${subtype}`
    const counts = groups.get(key) || new Map<string, number>()
    counts.set(issue, (counts.get(issue) || 0) + 1)
    groups.set(key, counts)
  }
  for (const [key, counts] of groups) {
    const [topic, subtype] = key.split('\u0000')
    const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0)
    for (const [issueType, frequency] of counts) {
      await prisma.topicErrorStat.upsert({
        where: { topic_questionSubtype_issueType: { topic, questionSubtype: subtype, issueType } },
        create: { topic, questionSubtype: subtype, issueType, frequency, share: frequency / total, sourceVersion: 'knowledge-2026-08-18' },
        update: { frequency, share: frequency / total, sourceVersion: 'knowledge-2026-08-18' },
      })
    }
  }
  return groups.size
}

async function main() {
  const limit = Math.max(1, Number(argument('--limit') || 100))
  const topicFilter = argument('--topic')
  const requestedStatus = (argument('--status') || 'draft').toLowerCase()
  const modelValidate = hasFlag('--model-validate')
  if (!['draft', 'validated', 'live'].includes(requestedStatus)) throw new Error('--status must be draft, validated, or live')
  if (requestedStatus === 'live' && !modelValidate) throw new Error('Publishing live items requires --model-validate')
  const finalStatus = requestedStatus === 'live'
    ? PracticeItemStatus.LIVE
    : requestedStatus === 'validated'
      ? PracticeItemStatus.VALIDATED
      : PracticeItemStatus.DRAFT

  const annotations = await prisma.knowledgeAnnotation.findMany({
    where: {
      anchorText: { not: null },
      replacementText: { not: null },
      teacherFeedback: { not: null },
      issueType: { in: ['GRAMMAR', 'VOCABULARY', 'STYLE'] },
      document: {
        allowedForRag: true,
        ...(topicFilter ? { OR: [{ topic: { contains: topicFilter } }, { question: { topicCategory: { contains: topicFilter } } }] } : {}),
      },
    },
    include: {
      document: {
        include: { question: { select: { topicCategory: true, subtype: true } } },
      },
    },
    take: limit * 8,
    orderBy: { id: 'asc' },
  })

  let created = 0
  let corrections = 0
  let mcqs = 0
  let discarded = 0
  for (const annotation of annotations) {
    if (created >= limit) break
    if (!isUsableAnnotation(annotation)) {
      discarded += 1
      continue
    }
    const issue = issueKey(annotation)
    const original = anonymize(annotation.anchorText!.trim())
    const teacherRewrite = anonymize(annotation.replacementText!.trim())
    const feedback = annotation.teacherFeedback!.trim()
    const assembled = modelValidate
      ? await assembleSingleError({ original, reference: teacherRewrite, issue, feedback })
      : { valid: true, stemSentence: original, referenceAnswer: teacherRewrite, judgeCriterion: feedback }
    if (!assembled.valid) {
      discarded += 1
      continue
    }
    const topic = annotation.document.question?.topicCategory || annotation.document.topic
    const subtype = annotation.document.question?.subtype || annotation.document.subtype
    const sourceRefs = [{
      documentId: annotation.documentId,
      annotationId: annotation.id,
      chunkId: annotation.chunkId,
      sentenceRef: annotation.sourceRef || (annotation.sentenceIndex != null ? `S${annotation.sentenceIndex + 1}` : null),
      paragraphRef: annotation.paragraphIndex != null ? `P${annotation.paragraphIndex + 1}` : null,
      sourceTitle: annotation.document.title,
    }]
    const baseData = {
      tab: PracticeTab.LANGUAGE,
      topic,
      questionSubtype: subtype,
      issueTypes: [issue, annotation.issueType].filter((value, index, all) => all.indexOf(value) === index) as Prisma.InputJsonValue,
      difficulty: PracticeDifficulty.CORE,
      materials: {
        originalSentence: assembled.stemSentence,
        errorAnchor: annotation.anchorText,
        sourceLabel: '往届学生真实例句',
        preRepaired: normalize(assembled.stemSentence) !== normalize(original),
      } as Prisma.InputJsonValue,
      judgePoints: { issueType: issue, criterion: assembled.judgeCriterion } as Prisma.InputJsonValue,
      explanation: feedback,
      sourceRefs: sourceRefs as Prisma.InputJsonValue,
      status: finalStatus,
      stats: { attempts: 0, correct: 0, partial: 0, wrong: 0, correctRate: 0, optionDistribution: {}, appealCount: 0 } as Prisma.InputJsonValue,
      changelog: [{ at: new Date().toISOString(), action: 'generated', source: 'knowledge_annotation', modelValidated: modelValidate }] as Prisma.InputJsonValue,
    }

    const correctionId = `practice-error-${annotation.id}`
    await prisma.practiceItem.upsert({
      where: { id: correctionId },
      create: {
        id: correctionId,
        itemType: PracticeItemType.ERROR_CORRECTION,
        stem: '下句有一处语言问题，请找出并改正。',
        answerKey: { referenceAnswer: assembled.referenceAnswer } as Prisma.InputJsonValue,
        ...baseData,
      },
      update: {
        stem: '下句有一处语言问题，请找出并改正。',
        answerKey: { referenceAnswer: assembled.referenceAnswer } as Prisma.InputJsonValue,
        ...baseData,
      },
    })
    created += 1
    corrections += 1
    if (created >= limit) break

    const variants = controlledMutations(assembled.referenceAnswer)
    if (variants.length < 2) continue
    const rawOptions = shuffleOptions([
      { text: assembled.referenceAnswer, source: 'teacher_rewrite' },
      { text: assembled.stemSentence, source: 'student_original' },
      ...variants.map(variant => ({ text: variant.text, source: 'controlled_mutation', mutation: variant.operation })),
    ], annotation.id).map((option, index) => ({ id: String.fromCharCode(65 + index), ...option }))
    if (new Set(rawOptions.map(option => normalize(option.text))).size !== 4) continue
    const correctId = rawOptions.find(option => option.source === 'teacher_rewrite')!.id
    const validation = modelValidate ? await validateMcq(rawOptions, correctId, issue) : null
    if (modelValidate && !validation?.valid) {
      discarded += 1
      continue
    }
    const optionReasons = Object.fromEntries((validation?.options || []).map(option => [option.id, option.reason]))
    const options = rawOptions.map(option => ({ ...option, reason: optionReasons[option.id] || (option.source === 'student_original' ? feedback : option.mutation) }))
    const mcqId = `practice-mcq-${annotation.id}`
    await prisma.practiceItem.upsert({
      where: { id: mcqId },
      create: {
        id: mcqId,
        itemType: PracticeItemType.MCQ,
        stem: '选出语法与表达最恰当的一项。',
        options: options as Prisma.InputJsonValue,
        answerKey: { optionId: correctId } as Prisma.InputJsonValue,
        ...baseData,
      },
      update: {
        stem: '选出语法与表达最恰当的一项。',
        options: options as Prisma.InputJsonValue,
        answerKey: { optionId: correctId } as Prisma.InputJsonValue,
        ...baseData,
      },
    })
    created += 1
    mcqs += 1
  }

  const statGroups = await rebuildTopicStats()
  console.log(JSON.stringify({
    requested: limit,
    status: finalStatus,
    modelValidated: modelValidate,
    createdOrUpdated: created,
    corrections,
    mcqs,
    discarded,
    topicStatGroups: statGroups,
  }, null, 2))
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
