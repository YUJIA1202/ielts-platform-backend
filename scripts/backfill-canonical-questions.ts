import { Prisma, TaskType } from '@prisma/client'
import prisma from '../src/prisma'
import { canonicalQuestionHash, normalizeCanonicalQuestion } from '../src/utils/canonicalQuestion'

const WRITE = process.argv.includes('--write')

type QuestionRow = {
  id: number
  task: TaskType
  subtype: string | null
  topic: string | null
  content: string
}

type CanonicalSeed = {
  promptHash: string
  normalizedPrompt: string
  displayPrompt: string
  task: TaskType
  subtype: string | null
  topic: string | null
  questionIds: number[]
}

async function main() {
  const questions = await prisma.question.findMany({
    select: { id: true, task: true, subtype: true, topic: true, content: true },
    orderBy: { id: 'asc' },
  })
  const seeds = buildSeeds(questions)
  const seedByQuestionId = new Map<number, CanonicalSeed>()
  for (const seed of seeds.values()) {
    for (const questionId of seed.questionIds) seedByQuestionId.set(questionId, seed)
  }

  const documents = await prisma.knowledgeDocument.findMany({
    select: {
      id: true,
      questionId: true,
      task: true,
      title: true,
      rawText: true,
      sourceRecords: { select: { rawJson: true }, take: 20 },
      chunks: { select: { chunkText: true }, take: 20 },
    },
    orderBy: { id: 'asc' },
  })

  const direct = new Map<number, CanonicalSeed>()
  const inferred = new Map<number, CanonicalSeed>()
  const unresolved: number[] = []
  for (const document of documents) {
    const directSeed = document.questionId ? seedByQuestionId.get(document.questionId) : null
    if (directSeed) {
      direct.set(document.id, directSeed)
      continue
    }
    const inferredSeed = inferDocumentSeed(document, Array.from(seeds.values()))
    if (inferredSeed) inferred.set(document.id, inferredSeed)
    else unresolved.push(document.id)
  }

  console.log(JSON.stringify({
    mode: WRITE ? 'write' : 'dry-run',
    questions: questions.length,
    canonicalQuestions: seeds.size,
    duplicateQuestionRowsMerged: questions.length - seeds.size,
    documents: documents.length,
    documentLinks: {
      directFromQuestionId: direct.size,
      inferredByExactPromptContainment: inferred.size,
      unresolved: unresolved.length,
    },
    unresolvedDocumentIds: unresolved.slice(0, 50),
  }, null, 2))

  if (!WRITE) return

  const canonicalIdByHash = new Map<string, number>()
  for (const seed of seeds.values()) {
    const canonical = await prisma.canonicalQuestion.upsert({
      where: { promptHash: seed.promptHash },
      create: {
        promptHash: seed.promptHash,
        normalizedPrompt: seed.normalizedPrompt,
        displayPrompt: seed.displayPrompt,
        task: seed.task,
        subtype: seed.subtype,
        topic: seed.topic,
      },
      update: {
        normalizedPrompt: seed.normalizedPrompt,
        displayPrompt: seed.displayPrompt,
        task: seed.task,
        subtype: seed.subtype,
        topic: seed.topic,
      },
      select: { id: true },
    })
    canonicalIdByHash.set(seed.promptHash, canonical.id)
  }

  await prisma.$transaction(Array.from(seedByQuestionId.entries()).map(([questionId, seed]) =>
    prisma.question.update({
      where: { id: questionId },
      data: { canonicalQuestionId: canonicalIdByHash.get(seed.promptHash) },
    })
  ))

  const documentLinks = new Map([...direct, ...inferred])
  await prisma.$transaction(Array.from(documentLinks.entries()).map(([documentId, seed]) =>
    prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { canonicalQuestionId: canonicalIdByHash.get(seed.promptHash) },
    })
  ))

  console.log(JSON.stringify({
    written: true,
    canonicalQuestions: canonicalIdByHash.size,
    linkedQuestions: seedByQuestionId.size,
    linkedDocuments: documentLinks.size,
  }, null, 2))
}

function buildSeeds(questions: QuestionRow[]) {
  const seeds = new Map<string, CanonicalSeed>()
  for (const question of questions) {
    const normalizedPrompt = normalizeCanonicalQuestion(question.content)
    const promptHash = canonicalQuestionHash(question.content)
    if (!promptHash || normalizedPrompt.length < 12) continue
    const existing = seeds.get(promptHash)
    if (existing) {
      existing.questionIds.push(question.id)
      if (!existing.subtype && question.subtype) existing.subtype = question.subtype
      if (!existing.topic && question.topic) existing.topic = question.topic
      continue
    }
    seeds.set(promptHash, {
      promptHash,
      normalizedPrompt,
      displayPrompt: question.content.trim(),
      task: question.task,
      subtype: question.subtype,
      topic: question.topic,
      questionIds: [question.id],
    })
  }
  return seeds
}

function inferDocumentSeed(
  document: {
    task: TaskType | null
    title: string
    rawText: string
    sourceRecords: { rawJson: Prisma.JsonValue }[]
    chunks: { chunkText: string }[]
  },
  seeds: CanonicalSeed[],
) {
  const searchable = normalizeCanonicalQuestion([
    document.title,
    document.rawText,
    ...document.chunks.map(chunk => chunk.chunkText),
    ...document.sourceRecords.map(record => JSON.stringify(record.rawJson)),
  ].join('\n'))
  if (!searchable) return null

  const matches = seeds
    .filter(seed => (!document.task || document.task === seed.task)
      && seed.normalizedPrompt.length >= 40
      && searchable.includes(seed.normalizedPrompt))
    .sort((left, right) => right.normalizedPrompt.length - left.normalizedPrompt.length)
  if (!matches.length) return null
  if (matches.length > 1 && matches[0].normalizedPrompt.length === matches[1].normalizedPrompt.length) {
    return null
  }
  return matches[0]
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
