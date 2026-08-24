import {
  PracticeAppealStatus,
  PracticeItemStatus,
  PracticeItemType,
  PracticeJudgedBy,
  PracticeSessionMode,
  PracticeSessionStatus,
  PracticeTab,
  PracticeVerdict,
  Prisma,
} from '@prisma/client'
import prisma from '../../prisma'
import { generateStructuredWithProvider } from '../ai/providers'
import {
  buildReviewPracticeFocus,
  cleanEnglishExpansion,
  ensurePersonalizedPracticeItems,
  ReviewPracticeAnnotation,
} from './personalizedPracticeGenerator'

type JsonRecord = Record<string, unknown>

export class PracticeServiceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export interface CreatePracticeSessionInput {
  studentId: number
  mode: 'topic' | 'essay'
  tab: 'language' | 'thinking'
  topic?: string | null
  questionSubtype?: string | null
  aiReviewId?: number | null
  essaySubmissionId?: number | null
}

export interface SubmitPracticeAttemptInput {
  studentId: number
  sessionId: string
  itemId: string
  answerPayload: unknown
}

interface JudgeResult {
  verdict: PracticeVerdict
  judgedBy: PracticeJudgedBy
  rationale: string
  fixed: string[]
  remaining: string[]
}

const LANGUAGE_ISSUES = new Set(['GRAMMAR', 'VOCABULARY', 'STYLE'])
const THINKING_ISSUES = new Set(['TASK_RESPONSE', 'LOGIC', 'COHESION', 'STRUCTURE'])

export async function createPracticeSession(input: CreatePracticeSessionInput) {
  const tab = input.tab === 'thinking' ? PracticeTab.THINKING : PracticeTab.LANGUAGE
  const mode = input.mode === 'essay' ? PracticeSessionMode.ESSAY : PracticeSessionMode.TOPIC
  let aiReviewId: number | null = input.aiReviewId || null
  let topic = cleanOptional(input.topic)
  let questionSubtype = cleanOptional(input.questionSubtype)
  let personalIssueWeights: Record<string, number> = {}
  let reviewAnnotations: ReviewPracticeAnnotation[] = []
  let reviewFocus: ReturnType<typeof buildReviewPracticeFocus>['focus'] = []

  if (mode === PracticeSessionMode.ESSAY) {
    const review = aiReviewId
      ? await prisma.aiReview.findFirst({
          where: { id: aiReviewId, userId: input.studentId },
          include: { request: true, annotations: true },
        })
      : input.essaySubmissionId
        ? await prisma.aiReview.findFirst({
            where: { submissionId: input.essaySubmissionId, userId: input.studentId },
            orderBy: { createdAt: 'desc' },
            include: { request: true, annotations: true },
          })
        : null
    if (!review) throw new PracticeServiceError('找不到可用于个性化练习的批改结果', 404)
    aiReviewId = review.id
    topic ||= review.request.topic
    questionSubtype ||= review.request.subtype
    reviewAnnotations = review.annotations.map(annotation => ({
      id: annotation.id,
      sentenceIndex: annotation.sentenceIndex,
      issueType: annotation.issueType,
      subtype: annotation.subtype,
      originalText: annotation.originalText,
      explanation: annotation.explanation,
      replacementText: annotation.replacementText,
      severity: annotation.severity,
    }))
    const focus = buildReviewPracticeFocus(reviewAnnotations, tab)
    personalIssueWeights = focus.weights
    reviewFocus = focus.focus
  } else if (!topic || !questionSubtype) {
    throw new PracticeServiceError('通用练习需要选择话题和题型')
  }

  const profile = await ensureProfile(input.studentId, aiReviewId)
  if (!Object.keys(personalIssueWeights).length) {
    personalIssueWeights = await issueWeightsFromTopicStats(topic, questionSubtype, tab)
  }

  const attempted = await prisma.practiceAttempt.findMany({
    where: { studentId: input.studentId },
    select: { itemId: true },
  })
  const attemptedIds = new Set(attempted.map(item => item.itemId))
  const personalizedItems = aiReviewId && reviewAnnotations.length
    ? await ensurePersonalizedPracticeItems({
        studentId: input.studentId,
        reviewId: aiReviewId,
        tab,
        topic,
        questionSubtype,
        annotations: reviewAnnotations,
      })
    : []
  const poolResult = await loadItemPool(tab)
  const targetCount = tab === PracticeTab.LANGUAGE ? 40 : 20
  const learningItems = reserveLearningItems(poolResult.items, tab, targetCount, personalIssueWeights)
  const learningIds = new Set(learningItems.map(item => item.id))
  const retrieved = selectItems({
    items: poolResult.items.filter(item => !learningIds.has(item.id)),
    targetCount: Math.max(0, targetCount - personalizedItems.length),
    topic,
    questionSubtype,
    issueWeights: personalIssueWeights,
    masteryFlags: asRecord(profile.masteryFlags),
    attemptedIds,
    seed: `${input.studentId}:${aiReviewId || topic}:${Date.now()}`,
  })
  const selected = [
    ...personalizedItems,
    ...retrieved.filter(item => !personalizedItems.some(personalized => personalized.id === item.id)),
  ].slice(0, targetCount)
  const itemIds = selected.map(item => item.id)
  const issueSummary = summarizeIssues(selected, personalIssueWeights)

  const session = await prisma.practiceSession.create({
    data: {
      studentId: input.studentId,
      aiReviewId,
      mode,
      tab,
      topic,
      questionSubtype,
      itemIds: itemIds as Prisma.InputJsonValue,
      profileSnapshot: toInputJson({
        issueWeights: personalIssueWeights,
        reviewFocus,
        personalizedItemIds: personalizedItems.map(item => item.id),
        masteryFlags: asRecord(profile.masteryFlags),
        inventoryStatus: poolResult.preview ? 'VALIDATED_PREVIEW' : 'LIVE',
      }),
    },
  })

  const caseCards = tab === PracticeTab.LANGUAGE
    ? buildCaseCards(learningItems, 8)
    : []
  const thinkingMap = tab === PracticeTab.THINKING
    ? buildThinkingMap([...personalizedItems, ...learningItems], 6)
    : []

  return {
    sessionId: session.id,
    mode: mode.toLowerCase(),
    tab: tab.toLowerCase(),
    topic,
    questionSubtype,
    itemIds,
    itemSequence: selected.map(item => ({
      itemId: item.id,
      itemType: item.itemType.toLowerCase(),
      issueTypes: jsonStringArray(item.issueTypes),
      difficulty: item.difficulty.toLowerCase(),
    })),
    itemCount: itemIds.length,
    requestedCount: targetCount,
    inventoryStatus: itemIds.length === 0 ? 'EMPTY' : poolResult.preview ? 'VALIDATED_PREVIEW' : 'LIVE',
    issueSummary,
    personalization: {
      source: aiReviewId ? 'current_review' : 'topic_profile',
      reviewId: aiReviewId,
      matchedErrorCount: reviewAnnotations.filter(annotation => (tab === PracticeTab.LANGUAGE ? LANGUAGE_ISSUES : THINKING_ISSUES).has(annotation.issueType)).length,
      generatedItemCount: personalizedItems.length,
      focus: reviewFocus.map(item => ({ ...item, label: issueLabel(item.issueType) })),
    },
    caseCards,
    thinkingMap,
  }
}

export async function getPracticeItemForUser(itemId: string, studentId: number, sessionId?: string | null) {
  if (sessionId) {
    const session = await prisma.practiceSession.findFirst({ where: { id: sessionId, studentId } })
    if (!session || !jsonStringArray(session.itemIds).includes(itemId)) {
      throw new PracticeServiceError('该题目不属于当前练习', 403)
    }
  }
  const item = await prisma.practiceItem.findUnique({ where: { id: itemId } })
  if (!item || (!sessionId && item.status !== PracticeItemStatus.LIVE)) {
    throw new PracticeServiceError('练习题不存在或尚未上架', 404)
  }
  return publicItem(item)
}

export async function submitPracticeAttempt(input: SubmitPracticeAttemptInput) {
  const session = await prisma.practiceSession.findFirst({
    where: { id: input.sessionId, studentId: input.studentId, status: PracticeSessionStatus.ACTIVE },
  })
  if (!session) throw new PracticeServiceError('练习会话不存在或已经结束', 404)
  if (!jsonStringArray(session.itemIds).includes(input.itemId)) {
    throw new PracticeServiceError('该题目不属于当前练习', 403)
  }
  const item = await prisma.practiceItem.findUnique({ where: { id: input.itemId } })
  if (!item) throw new PracticeServiceError('练习题不存在', 404)

  const judged = await judgeAnswer(item, input.answerPayload)
  const nowIso = new Date().toISOString()
  const issueTypes = jsonStringArray(item.issueTypes)
  const answerPayload = toInputJson(input.answerPayload)

  const result = await prisma.$transaction(async tx => {
    const attempt = await tx.practiceAttempt.create({
      data: {
        studentId: input.studentId,
        sessionId: session.id,
        itemId: item.id,
        answerPayload,
        verdict: judged.verdict,
        judgedBy: judged.judgedBy,
        judgeRationale: judged.rationale,
        fixed: judged.fixed as Prisma.InputJsonValue,
        remaining: judged.remaining as Prisma.InputJsonValue,
      },
    })

    const profile = await tx.practiceProfile.findUnique({ where: { studentId: input.studentId } })
    const counters = asRecord(profile?.issueCounters)
    const mastery = asRecord(profile?.masteryFlags)
    for (const issueType of issueTypes) {
      const current = asRecord(counters[issueType])
      const streak = judged.verdict === PracticeVerdict.CORRECT ? numberValue(current.streak) + 1 : 0
      counters[issueType] = {
        seen: numberValue(current.seen) + 1,
        correct: numberValue(current.correct) + (judged.verdict === PracticeVerdict.CORRECT ? 1 : 0),
        partial: numberValue(current.partial) + (judged.verdict === PracticeVerdict.PARTIAL ? 1 : 0),
        wrong: numberValue(current.wrong) + (judged.verdict === PracticeVerdict.WRONG ? 1 : 0),
        streak,
        lastSeenAt: nowIso,
      }
      if (streak >= 3) mastery[issueType] = { masteredAt: nowIso, streak }
      else if (mastery[issueType] && judged.verdict !== PracticeVerdict.CORRECT) delete mastery[issueType]
    }
    await tx.practiceProfile.upsert({
      where: { studentId: input.studentId },
      create: {
        studentId: input.studentId,
        issueCounters: counters as Prisma.InputJsonValue,
        sourceEssays: [] as Prisma.InputJsonValue,
        masteryFlags: mastery as Prisma.InputJsonValue,
      },
      update: {
        issueCounters: counters as Prisma.InputJsonValue,
        masteryFlags: mastery as Prisma.InputJsonValue,
      },
    })

    const stats = asRecord(item.stats)
    const attempts = numberValue(stats.attempts) + 1
    const correct = numberValue(stats.correct) + (judged.verdict === PracticeVerdict.CORRECT ? 1 : 0)
    const partial = numberValue(stats.partial) + (judged.verdict === PracticeVerdict.PARTIAL ? 1 : 0)
    const wrong = numberValue(stats.wrong) + (judged.verdict === PracticeVerdict.WRONG ? 1 : 0)
    const optionDistribution = asRecord(stats.optionDistribution)
    const chosenOption = cleanOptional(asRecord(input.answerPayload).optionId)
    if (chosenOption) optionDistribution[chosenOption] = numberValue(optionDistribution[chosenOption]) + 1
    await tx.practiceItem.update({
      where: { id: item.id },
      data: {
        stats: {
          ...stats,
          attempts,
          correct,
          partial,
          wrong,
          correctRate: attempts ? correct / attempts : 0,
          optionDistribution,
          appealCount: numberValue(stats.appealCount),
        } as Prisma.InputJsonValue,
      },
    })

    const distinctAttempts = await tx.practiceAttempt.findMany({
      where: { sessionId: session.id },
      distinct: ['itemId'],
      select: { itemId: true },
    })
    if (distinctAttempts.length >= jsonStringArray(session.itemIds).length && jsonStringArray(session.itemIds).length > 0) {
      await tx.practiceSession.update({
        where: { id: session.id },
        data: { status: PracticeSessionStatus.COMPLETED, completedAt: new Date() },
      })
    }
    return attempt
  })

  return {
    attemptId: result.id,
    verdict: judged.verdict.toLowerCase(),
    judgedBy: judged.judgedBy.toLowerCase(),
    judgeRationale: judged.rationale,
    fixed: judged.fixed,
    remaining: judged.remaining,
    explanation: item.explanation,
    referenceAnswer: publicReferenceAnswer(item),
    optionFeedback: item.itemType === PracticeItemType.MCQ
      ? jsonArray(item.options).map(asRecord).map(option => ({ id: option.id, text: option.text, reason: option.reason || null }))
      : null,
  }
}

export async function appealPracticeAttempt(input: { studentId: number; attemptId: string; reason?: string | null }) {
  const attempt = await prisma.practiceAttempt.findFirst({
    where: { id: input.attemptId, studentId: input.studentId },
    include: { item: true },
  })
  if (!attempt) throw new PracticeServiceError('作答记录不存在', 404)
  if (attempt.appealStatus === PracticeAppealStatus.PENDING) {
    throw new PracticeServiceError('该作答已经提交申诉')
  }
  await prisma.$transaction(async tx => {
    await tx.practiceAttempt.update({
      where: { id: attempt.id },
      data: { appealStatus: PracticeAppealStatus.PENDING, appealReason: cleanOptional(input.reason) },
    })
    const stats = asRecord(attempt.item.stats)
    await tx.practiceItem.update({
      where: { id: attempt.itemId },
      data: {
        stats: {
          ...stats,
          appealCount: numberValue(stats.appealCount) + 1,
        } as Prisma.InputJsonValue,
      },
    })
  })
  return { attemptId: attempt.id, appealStatus: 'pending' }
}

export async function getPracticeProfile(studentId: number) {
  const profile = await ensureProfile(studentId, null)
  const counters = asRecord(profile.issueCounters)
  const mastery = asRecord(profile.masteryFlags)
  return {
    studentId,
    issues: Object.entries(counters).map(([issueType, value]) => {
      const counter = asRecord(value)
      const seen = numberValue(counter.seen)
      const score = numberValue(counter.correct) + numberValue(counter.partial) * 0.5
      return {
        issueType,
        seen,
        correct: numberValue(counter.correct),
        partial: numberValue(counter.partial),
        wrong: numberValue(counter.wrong),
        mastery: seen ? score / seen : 0,
        mastered: Boolean(mastery[issueType]),
        lastSeenAt: counter.lastSeenAt || null,
      }
    }).sort((a, b) => b.seen - a.seen),
    sourceEssays: jsonNumberArray(profile.sourceEssays),
  }
}

export async function getPracticeHistory(input: {
  studentId: number
  tab?: 'language' | 'thinking' | null
  limit?: number | null
}) {
  const tab = input.tab === 'language'
    ? PracticeTab.LANGUAGE
    : input.tab === 'thinking'
      ? PracticeTab.THINKING
      : undefined
  const limit = Math.min(30, Math.max(1, input.limit || 12))
  const sessions = await prisma.practiceSession.findMany({
    where: {
      studentId: input.studentId,
      ...(tab ? { tab } : {}),
      attempts: { some: {} },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      attempts: {
        orderBy: { createdAt: 'desc' },
        include: { item: true },
      },
    },
  })

  return {
    sessions: sessions.map(session => {
      const counts = { correct: 0, partial: 0, wrong: 0 }
      for (const attempt of session.attempts) {
        counts[attempt.verdict.toLowerCase() as keyof typeof counts] += 1
      }
      return {
        sessionId: session.id,
        tab: session.tab.toLowerCase(),
        topic: session.topic,
        questionSubtype: session.questionSubtype,
        aiReviewId: session.aiReviewId,
        status: session.status.toLowerCase(),
        createdAt: session.createdAt,
        completedAt: session.completedAt,
        totals: { attempts: session.attempts.length, ...counts },
        attempts: session.attempts.map(attempt => ({
          attemptId: attempt.id,
          itemId: attempt.itemId,
          itemType: attempt.item.itemType.toLowerCase(),
          issueTypes: jsonStringArray(attempt.item.issueTypes),
          stem: attempt.item.stem,
          answer: attempt.answerPayload,
          verdict: attempt.verdict.toLowerCase(),
          judgedBy: attempt.judgedBy.toLowerCase(),
          judgeRationale: attempt.judgeRationale,
          fixed: jsonStringArray(attempt.fixed),
          remaining: jsonStringArray(attempt.remaining),
          referenceAnswer: publicReferenceAnswer(attempt.item),
          explanation: attempt.item.explanation,
          appealStatus: attempt.appealStatus.toLowerCase(),
          createdAt: attempt.createdAt,
        })),
      }
    }),
  }
}

async function loadItemPool(tab: PracticeTab) {
  const live = await prisma.practiceItem.findMany({
    where: { tab, status: PracticeItemStatus.LIVE },
    take: 500,
  })
  if (live.length) return { items: live, preview: false }
  const validated = await prisma.practiceItem.findMany({
    where: { tab, status: PracticeItemStatus.VALIDATED },
    take: 500,
  })
  return { items: validated, preview: validated.length > 0 }
}

function reserveLearningItems(
  items: Awaited<ReturnType<typeof loadItemPool>>['items'],
  tab: PracticeTab,
  targetCount: number,
  issueWeights: Record<string, number>,
) {
  const desired = tab === PracticeTab.LANGUAGE ? 8 : 6
  const extra = Math.max(0, items.length - targetCount)
  const reserveCount = Math.min(desired, extra || Math.max(1, Math.floor(items.length * 0.2)))
  const preferredType = tab === PracticeTab.LANGUAGE ? PracticeItemType.ERROR_CORRECTION : PracticeItemType.CHAIN_CLOZE
  const preferred = items
    .filter(item => item.itemType === preferredType)
    .sort((a, b) => itemIssueWeight(b, issueWeights) - itemIssueWeight(a, issueWeights))
  const selected: typeof items = []
  const usedIssues = new Set<string>()
  for (const item of preferred) {
    const issue = jsonStringArray(item.issueTypes)[0] || item.id
    if (tab === PracticeTab.LANGUAGE && usedIssues.has(issue)) continue
    selected.push(item)
    usedIssues.add(issue)
    if (selected.length >= reserveCount) break
  }
  if (selected.length < reserveCount) {
    selected.push(...items.filter(item => !selected.some(chosen => chosen.id === item.id)).slice(0, reserveCount - selected.length))
  }
  return selected
}

function selectItems(input: {
  items: Awaited<ReturnType<typeof loadItemPool>>['items']
  targetCount: number
  topic: string | null
  questionSubtype: string | null
  issueWeights: Record<string, number>
  masteryFlags: JsonRecord
  attemptedIds: Set<string>
  seed: string
}) {
  const normalizedTopic = normalize(input.topic)
  const normalizedSubtype = normalize(input.questionSubtype)
  const scored = input.items.map(item => {
    const issues = jsonStringArray(item.issueTypes)
    const weighted = issues.reduce((total, issue) => {
      const broad = issue.split(/[,_]/)[0]
      const base = input.issueWeights[issue] || input.issueWeights[broad] || 1
      return total + base * (input.masteryFlags[issue] ? 0.2 : 1)
    }, 0)
    const topicMatch = normalizedTopic && normalize(item.topic).includes(normalizedTopic) ? 8 : 0
    const subtypeMatch = normalizedSubtype && normalize(item.questionSubtype) === normalizedSubtype ? 5 : 0
    const unseen = input.attemptedIds.has(item.id) ? 0 : 6
    return { item, score: weighted * 10 + topicMatch + subtypeMatch + unseen + seededFraction(`${input.seed}:${item.id}`) }
  }).sort((a, b) => b.score - a.score)

  const selected: typeof input.items = []
  const perIssue = new Map<string, number>()
  const languageQuota: Partial<Record<PracticeItemType, number>> = {
    [PracticeItemType.ERROR_CORRECTION]: 15,
    [PracticeItemType.MCQ]: 15,
    [PracticeItemType.CLOZE]: 10,
  }
  const perType = new Map<PracticeItemType, number>()
  for (const candidate of scored) {
    if (selected.length >= input.targetCount) break
    const primary = jsonStringArray(candidate.item.issueTypes)[0] || 'GENERAL'
    if ((perIssue.get(primary) || 0) >= 12) continue
    const quota = languageQuota[candidate.item.itemType]
    if (quota && (perType.get(candidate.item.itemType) || 0) >= quota) continue
    selected.push(candidate.item)
    perIssue.set(primary, (perIssue.get(primary) || 0) + 1)
    perType.set(candidate.item.itemType, (perType.get(candidate.item.itemType) || 0) + 1)
  }
  if (selected.length < input.targetCount) {
    for (const candidate of scored) {
      if (selected.length >= input.targetCount) break
      if (!selected.some(item => item.id === candidate.item.id)) selected.push(candidate.item)
    }
  }
  return selected
}

function publicItem(item: Awaited<ReturnType<typeof prisma.practiceItem.findUnique>> & {}) {
  const materials = asRecord(item.materials)
  return {
    itemId: item.id,
    tab: item.tab.toLowerCase(),
    itemType: item.itemType.toLowerCase(),
    topic: item.topic,
    questionSubtype: item.questionSubtype,
    issueTypes: jsonStringArray(item.issueTypes),
    difficulty: item.difficulty.toLowerCase(),
    stem: item.stem,
    materials: item.materials,
    options: item.options
      ? jsonArray(item.options).map(asRecord).map(option => ({ id: option.id, text: option.text }))
      : null,
    sourceLabel: cleanOptional(materials.sourceLabel) || '往届学生真实例句 / 教师批改资料',
  }
}

function buildCaseCards(items: Awaited<ReturnType<typeof loadItemPool>>['items'], limit: number) {
  const cards: Array<Record<string, unknown>> = []
  const used = new Set<string>()
  for (const item of items) {
    if (item.itemType !== PracticeItemType.ERROR_CORRECTION) continue
    const issueType = jsonStringArray(item.issueTypes)[0] || 'LANGUAGE'
    if (used.has(issueType)) continue
    const materials = asRecord(item.materials)
    cards.push({
      issueType,
      label: issueLabel(issueType),
      originalSentence: materials.originalSentence || materials.text || '',
      errorAnchor: materials.errorAnchor || null,
      teacherComment: item.explanation,
      correctedSentence: publicReferenceAnswer(item),
      extensions: jsonArray(materials.extensions),
      sourceLabel: '往届学生真实例句',
    })
    used.add(issueType)
    if (cards.length >= limit) break
  }
  return cards
}

function buildThinkingMap(items: Awaited<ReturnType<typeof loadItemPool>>['items'], limit: number) {
  return items.slice(0, limit * 3).flatMap(item => {
    const materials = asRecord(item.materials)
    const answerKey = asRecord(item.answerKey)
    const map = answerKey.fullChain || materials.argumentMap || materials.teachingNote
    if (!map) return []
    const englishExpansion = cleanEnglishExpansion(answerKey.englishExpansion)
    return [{
      title: issueLabel(jsonStringArray(item.issueTypes)[0] || 'TR_CC'),
      content: {
        logic: map,
        englishExpansion: englishExpansion || null,
      },
    }]
  }).slice(0, limit)
}

function itemIssueWeight(item: Awaited<ReturnType<typeof loadItemPool>>['items'][number], weights: Record<string, number>) {
  return jsonStringArray(item.issueTypes).reduce((total, issue) => total + (weights[issue] || 0), 0)
}

function summarizeIssues(items: Awaited<ReturnType<typeof loadItemPool>>['items'], weights: Record<string, number>) {
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const issue of jsonStringArray(item.issueTypes)) counts.set(issue, (counts.get(issue) || 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([issueType, count]) => ({ issueType, label: issueLabel(issueType), count, weight: weights[issueType] || 0 }))
    .sort((a, b) => b.count - a.count)
}

async function judgeAnswer(item: NonNullable<Awaited<ReturnType<typeof prisma.practiceItem.findUnique>>>, payload: unknown): Promise<JudgeResult> {
  const answer = asRecord(payload)
  const answerKey = asRecord(item.answerKey)
  if (item.itemType === PracticeItemType.MCQ) {
    const correct = cleanOptional(answer.optionId) === cleanOptional(answerKey.optionId)
    return programResult(correct, correct ? '选项与标准答案一致。' : '所选项仍包含目标错误。')
  }
  if (([PracticeItemType.CONCESSION_MATCH, PracticeItemType.FUNCTION_ID] as PracticeItemType[]).includes(item.itemType)) {
    const correct = stableJson(answer.matches || answer.mapping) === stableJson(answerKey.matches || answerKey.mapping)
    return programResult(correct, correct ? '配对关系完整正确。' : '至少一组配对关系不正确。')
  }
  if (([PracticeItemType.REASON_FILTER, PracticeItemType.STANCE_ID] as PracticeItemType[]).includes(item.itemType)) {
    const expected = stringSet(answerKey.selectedIds)
    const actual = stringSet(answer.selectedIds)
    const intersection = actual.filter(value => expected.includes(value)).length
    if (setEquals(actual, expected)) return programResult(true, '所选理由与标准集合一致。')
    if (intersection >= Math.ceil(expected.length * 0.75)) return partialProgramResult('大部分选择正确，但仍有漏选或误选。')
    return programResult(false, '所选理由没有完整支撑题目要求。')
  }
  if (item.itemType === PracticeItemType.ORDERING) {
    const correct = JSON.stringify(jsonStringArray(answer.order)) === JSON.stringify(jsonStringArray(answerKey.order))
    return programResult(correct, correct ? '顺序正确。' : '句子顺序与唯一标准顺序不一致。')
  }
  if (item.itemType === PracticeItemType.CLOZE) return judgeCloze(item, answer)
  if (item.itemType === PracticeItemType.BREAK_LOCATE) {
    const expectedIndex = numberValue(answerKey.sentenceIndex)
    if (numberValue(answer.sentenceIndex) !== expectedIndex) return programResult(false, '断链位置判断不正确。')
    const explanation = cleanOptional(answer.explanation)
    if (!explanation) return partialProgramResult('位置正确，但尚未说明逻辑为什么断裂。')
    const model = await modelEquivalenceJudge(item, explanation)
    return model.verdict === PracticeVerdict.WRONG
      ? { ...model, verdict: PracticeVerdict.PARTIAL, fixed: ['断链句编号正确'], remaining: model.remaining }
      : model
  }
  if (item.itemType === PracticeItemType.ERROR_CORRECTION || item.itemType === PracticeItemType.CHAIN_CLOZE) {
    const response = cleanOptional(answer.text || answer.answer)
    if (!response) return programResult(false, '尚未提交可判定的答案。')
    const reference = cleanOptional(answerKey.referenceAnswer || answerKey.text)
    if (reference && normalizeSentence(response) === normalizeSentence(reference)) {
      return programResult(true, '答案与教师参考修复一致。')
    }
    return modelEquivalenceJudge(item, response)
  }
  if (cleanOptional(answer.selfVerdict)) {
    const value = String(answer.selfVerdict).toUpperCase()
    const verdict = value === 'CORRECT' ? PracticeVerdict.CORRECT : value === 'PARTIAL' ? PracticeVerdict.PARTIAL : PracticeVerdict.WRONG
    return { verdict, judgedBy: PracticeJudgedBy.SELF, rationale: '学生根据参考答案完成自评。', fixed: [], remaining: [] }
  }
  return programResult(false, '当前题型没有收到有效答案。')
}

function judgeCloze(item: NonNullable<Awaited<ReturnType<typeof prisma.practiceItem.findUnique>>>, answer: JsonRecord): JudgeResult {
  const acceptable = asRecord(item.acceptableAnswers)
  const blanks = jsonArray(acceptable.blanks).map(asRecord)
  const submitted = asRecord(answer.answers)
  let correct = 0
  const remaining: string[] = []
  for (const blank of blanks) {
    const id = String(blank.id || '')
    const value = normalizeSentence(cleanOptional(submitted[id]) || '')
    const options = jsonStringArray(blank.answers).map(normalizeSentence)
    if (value && options.includes(value)) correct += 1
    else remaining.push(`${id || '空格'} 尚未命中可接受答案清单`)
  }
  if (blanks.length && correct === blanks.length) {
    return { verdict: PracticeVerdict.CORRECT, judgedBy: PracticeJudgedBy.LIST, rationale: '所有空格均命中可接受答案。', fixed: ['全部空格'], remaining: [] }
  }
  if (correct > 0) {
    return { verdict: PracticeVerdict.PARTIAL, judgedBy: PracticeJudgedBy.LIST, rationale: '部分空格正确。', fixed: [`${correct} 个空格`], remaining }
  }
  return { verdict: PracticeVerdict.WRONG, judgedBy: PracticeJudgedBy.LIST, rationale: '答案未命中当前可接受答案清单。', fixed: [], remaining }
}

async function modelEquivalenceJudge(
  item: NonNullable<Awaited<ReturnType<typeof prisma.practiceItem.findUnique>>>,
  studentAnswer: string,
): Promise<JudgeResult> {
  const answerKey = asRecord(item.answerKey)
  const fallback = {
    verdict: 'partial',
    fixed: [] as string[],
    remaining: ['当前环境未配置判分模型，请对照参考答案自查。'],
    rationale: '无法完成可靠的等价判定，因此按 partial 处理。',
  }
  const result = await generateStructuredWithProvider({
    systemPrompt: '你是受控的IELTS练习判分器。只按judgePoints判断，不增加新标准；不确定时判partial；返回严格JSON，不输出思维过程。',
    userPrompt: `题目：${item.stem}\n学生答案：${studentAnswer}\n参考答案：${JSON.stringify(answerKey)}\n判定要点：${JSON.stringify(item.judgePoints)}\n必要材料：${JSON.stringify(item.materials)}\n\n返回 {"verdict":"correct|partial|wrong","fixed":["已达成要点"],"remaining":["未达成或新引入问题"],"rationale":"必须引用学生答案具体表述的一句话依据"}`,
    fallbackOutput: fallback,
    temperature: 0,
    maxOutputTokens: 1200,
    thinkingMode: 'enabled',
    reasoningEffort: 'medium',
  })
  const output = asRecord(result.output)
  const verdict = String(output.verdict || '').toLowerCase() === 'correct'
    ? PracticeVerdict.CORRECT
    : String(output.verdict || '').toLowerCase() === 'wrong'
      ? PracticeVerdict.WRONG
      : PracticeVerdict.PARTIAL
  return {
    verdict,
    judgedBy: PracticeJudgedBy.MODEL,
    rationale: cleanOptional(output.rationale) || fallback.rationale,
    fixed: jsonStringArray(output.fixed),
    remaining: jsonStringArray(output.remaining),
  }
}

function programResult(correct: boolean, rationale: string): JudgeResult {
  return {
    verdict: correct ? PracticeVerdict.CORRECT : PracticeVerdict.WRONG,
    judgedBy: PracticeJudgedBy.PROGRAM,
    rationale,
    fixed: correct ? ['标准答案要求'] : [],
    remaining: correct ? [] : ['请对照参考答案与解析'],
  }
}

function partialProgramResult(rationale: string): JudgeResult {
  return {
    verdict: PracticeVerdict.PARTIAL,
    judgedBy: PracticeJudgedBy.PROGRAM,
    rationale,
    fixed: ['部分判定要点'],
    remaining: ['仍有未完成的判定要点'],
  }
}

function publicReferenceAnswer(item: { answerKey: Prisma.JsonValue; options: Prisma.JsonValue | null }) {
  const key = asRecord(item.answerKey)
  if (key.referenceAnswer) return key.referenceAnswer
  if (key.text) return key.text
  if (key.optionId) {
    const option = jsonArray(item.options).map(asRecord).find(value => String(value.id) === String(key.optionId))
    return option?.text || key.optionId
  }
  if (key.order) return key.order
  if (key.selectedIds) return key.selectedIds
  if (key.matches || key.mapping) return key.matches || key.mapping
  return key
}

async function ensureProfile(studentId: number, aiReviewId: number | null) {
  const existing = await prisma.practiceProfile.findUnique({ where: { studentId } })
  if (existing) {
    if (aiReviewId && !jsonNumberArray(existing.sourceEssays).includes(aiReviewId)) {
      return prisma.practiceProfile.update({
        where: { studentId },
        data: { sourceEssays: [...jsonNumberArray(existing.sourceEssays), aiReviewId] as Prisma.InputJsonValue },
      })
    }
    return existing
  }
  return prisma.practiceProfile.create({
    data: {
      studentId,
      issueCounters: {} as Prisma.InputJsonValue,
      sourceEssays: (aiReviewId ? [aiReviewId] : []) as Prisma.InputJsonValue,
      masteryFlags: {} as Prisma.InputJsonValue,
    },
  })
}

function issueWeightsFromReview(
  annotations: Array<{ issueType: string; subtype: string | null }>,
  tab: PracticeTab,
) {
  const allowed = tab === PracticeTab.LANGUAGE ? LANGUAGE_ISSUES : THINKING_ISSUES
  const weights: Record<string, number> = {}
  for (const annotation of annotations) {
    if (!allowed.has(annotation.issueType)) continue
    const keys = [annotation.subtype, annotation.issueType].filter((value): value is string => Boolean(value))
    for (const key of keys) weights[key] = (weights[key] || 0) + 1
  }
  return weights
}

async function issueWeightsFromTopicStats(topic: string | null, subtype: string | null, tab: PracticeTab) {
  if (!topic || !subtype) return {}
  const stats = await prisma.topicErrorStat.findMany({ where: { topic, questionSubtype: subtype } })
  const allowed = tab === PracticeTab.LANGUAGE ? LANGUAGE_ISSUES : THINKING_ISSUES
  return Object.fromEntries(stats.filter(item => allowed.has(item.issueType.split(/[,_]/)[0])).map(item => [item.issueType, item.share || item.frequency]))
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  if (value === undefined) return {} as Prisma.InputJsonValue
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function jsonStringArray(value: unknown): string[] {
  return jsonArray(value).map(item => String(item)).filter(Boolean)
}

function jsonNumberArray(value: unknown): number[] {
  return jsonArray(value).map(Number).filter(Number.isFinite)
}

function cleanOptional(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalize(value: unknown) {
  return cleanOptional(value)?.toLocaleLowerCase().replace(/\s+/g, ' ') || ''
}

function normalizeSentence(value: string) {
  return value.toLocaleLowerCase().replace(/[“”‘’]/g, "'").replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => stableJson(item)).sort())
  if (value && typeof value === 'object') {
    return JSON.stringify(Object.entries(value as JsonRecord).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableJson(item)]))
  }
  return JSON.stringify(value)
}

function stringSet(value: unknown) {
  return Array.from(new Set(jsonStringArray(value))).sort()
}

function setEquals(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function seededFraction(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 0xffffffff
}

function issueLabel(issueType: string) {
  const labels: Record<string, string> = {
    GRAMMAR: '语法准确性',
    VOCABULARY: '用词与搭配',
    STYLE: '表达自然度',
    TASK_RESPONSE: '任务回应',
    LOGIC: '论证逻辑',
    COHESION: '衔接与指代',
    STRUCTURE: '段落结构',
    COLLOCATION: '搭配不当',
    WORD_CHOICE: '词义选择',
    VOCAB_WORD_CHOICE: '词义选择',
    WORD_FORM: '词形',
    PREPOSITION: '介词搭配',
    REFERENCE: '指代',
    RELATIVE_REFERENCE: '关系指代',
    PARTICIPLE_FORM: '分词形式',
    CATEGORY_PRECISION: '概念范围',
    SCOPE_NARROWING: '任务范围控制',
    VAGUE_EVALUATION: '表达过于笼统',
    SUBJECT_VERB_AGREEMENT: '主谓一致',
    ARTICLE: '冠词',
    GRAMMAR_ARTICLE: '冠词',
    PUNCTUATION: '标点',
    PARALLELISM: '平行结构',
    COMPLEMENT_STRUCTURE: '宾补结构',
    STYLE_ACADEMIC: '学术表达冗余',
    SPELLING: '拼写',
    CHAIN_COMPLETION: '论证链补全',
    CONCLUSION_NEW_INFORMATION: '结尾引入新信息',
    TR_CC: '任务回应与逻辑',
  }
  return labels[issueType] || issueType.replace(/_/g, ' ').toLocaleLowerCase()
}
