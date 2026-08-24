import { TaskType } from '@prisma/client'
import prisma from '../prisma'
import { canonicalQuestionHash, normalizeCanonicalQuestion } from '../utils/canonicalQuestion'

export async function ensureCanonicalQuestion(input: {
  content: string | null | undefined
  task?: string | null
  subtype?: string | null
  topic?: string | null
}) {
  const promptHash = canonicalQuestionHash(input.content)
  if (!promptHash) return null

  const normalizedPrompt = normalizeCanonicalQuestion(input.content)
  const displayPrompt = String(input.content || '').trim()
  const task = input.task === TaskType.TASK1 || input.task === TaskType.TASK2
    ? input.task
    : null

  const canonical = await prisma.canonicalQuestion.upsert({
    where: { promptHash },
    create: {
      promptHash,
      normalizedPrompt,
      displayPrompt,
      task,
      subtype: input.subtype || null,
      topic: input.topic || null,
    },
    update: {
      ...(task && { task }),
      ...(input.subtype && { subtype: input.subtype }),
      ...(input.topic && { topic: input.topic }),
    },
    select: { id: true },
  })

  return canonical.id
}
