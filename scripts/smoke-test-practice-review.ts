import 'dotenv/config'
import assert from 'node:assert/strict'
import prisma from '../src/prisma'
import {
  createPracticeSession,
  getPracticeHistory,
  getPracticeItemForUser,
  submitPracticeAttempt,
} from '../src/services/practice/practiceService'

const reviewId = Number(process.argv[2])
if (!Number.isInteger(reviewId) || reviewId <= 0) {
  throw new Error('Usage: tsx scripts/smoke-test-practice-review.ts <reviewId>')
}

async function main() {
  const review = await prisma.aiReview.findUnique({ where: { id: reviewId }, select: { userId: true } })
  if (!review) throw new Error(`Review ${reviewId} not found`)

  const summaries = []
  for (const tab of ['language', 'thinking'] as const) {
    const session = await createPracticeSession({
      studentId: review.userId,
      mode: 'essay',
      tab,
      aiReviewId: reviewId,
    })
    assert.equal(session.personalization.source, 'current_review')
    assert.equal(session.personalization.reviewId, reviewId)
    assert.ok(session.itemIds.length > 0, `${tab} session must contain at least one item`)

    const item = await prisma.practiceItem.findUnique({ where: { id: session.itemIds[0] } })
    assert.ok(item)
    const publicItem = await getPracticeItemForUser(item.id, review.userId, session.sessionId)
    const attempt = await submitPracticeAttempt({
      studentId: review.userId,
      sessionId: session.sessionId,
      itemId: item.id,
      answerPayload: correctPayload(item),
    })
    assert.equal(attempt.verdict, 'correct')

    summaries.push({
      tab,
      sessionId: session.sessionId,
      itemCount: session.itemCount,
      matchedErrorCount: session.personalization.matchedErrorCount,
      generatedItemCount: session.personalization.generatedItemCount,
      firstItemType: publicItem.itemType,
      firstItemSource: publicItem.sourceLabel,
      smokeAttemptVerdict: attempt.verdict,
    })
  }

  const history = await getPracticeHistory({ studentId: review.userId, limit: 30 })
  const linkedHistory = history.sessions.filter(session => session.aiReviewId === reviewId)
  assert.ok(linkedHistory.length >= 2)
  console.log(JSON.stringify({ reviewId, sessions: summaries, linkedHistoryCount: linkedHistory.length }, null, 2))
}

function correctPayload(item: NonNullable<Awaited<ReturnType<typeof prisma.practiceItem.findUnique>>>) {
  const key = asRecord(item.answerKey)
  const acceptable = asRecord(item.acceptableAnswers)
  switch (item.itemType) {
    case 'MCQ': return { optionId: key.optionId }
    case 'CONCESSION_MATCH':
    case 'FUNCTION_ID': return { matches: key.matches || key.mapping }
    case 'REASON_FILTER':
    case 'STANCE_ID': return { selectedIds: key.selectedIds }
    case 'ORDERING': return { order: key.order }
    case 'CLOZE': {
      const answers: Record<string, unknown> = {}
      for (const blank of asArray(acceptable.blanks).map(asRecord)) {
        const values = asArray(blank.answers)
        answers[String(blank.id)] = values[0]
      }
      return { answers }
    }
    case 'BREAK_LOCATE': return { sentenceIndex: key.sentenceIndex, explanation: key.explanation || '该句破坏了前后论证关系。' }
    case 'ERROR_CORRECTION':
    case 'CHAIN_CLOZE': return { text: key.referenceAnswer || key.text }
    default: return { selfVerdict: 'CORRECT' }
  }
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
