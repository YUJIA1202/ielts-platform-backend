import { TaskType } from '@prisma/client'
import prisma from '../../prisma'
import { PreprocessedEssay, RagChunk } from './types'

export async function retrieveRagChunks(input: {
  jobId: number
  questionText: string | null
  preprocessed: PreprocessedEssay
  topK?: number
}): Promise<RagChunk[]> {
  const topK = input.topK || 6
  const query = buildRetrievalQuery(input.questionText, input.preprocessed)
  const terms = tokenize(query)

  const candidates = await prisma.knowledgeChunk.findMany({
    where: {
      OR: [
        input.preprocessed.detectedTask ? { task: input.preprocessed.detectedTask } : {},
        input.preprocessed.detectedSubtype ? { subtype: input.preprocessed.detectedSubtype } : {},
        { task: null },
      ],
    },
    take: 80,
    orderBy: { createdAt: 'desc' },
  })

  const scored = candidates
    .map(chunk => ({
      id: chunk.id,
      chunkText: chunk.chunkText,
      chunkType: chunk.chunkType,
      task: chunk.task,
      subtype: chunk.subtype,
      topic: chunk.topic,
      score: scoreChunk(terms, chunk.chunkText, input.preprocessed.detectedTask, chunk.task, input.preprocessed.detectedSubtype, chunk.subtype),
    }))
    .filter(chunk => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)

  const event = await prisma.retrievalEvent.create({
    data: {
      jobId: input.jobId,
      query,
      topK,
      strategy: 'keyword_mvp',
    },
  })

  if (scored.length) {
    await prisma.retrievalEventChunk.createMany({
      data: scored.map((chunk, index) => ({
        retrievalEventId: event.id,
        chunkId: chunk.id,
        rank: index + 1,
        similarityScore: chunk.score,
        usedInPrompt: true,
      })),
      skipDuplicates: true,
    })
  }

  return scored
}

function buildRetrievalQuery(questionText: string | null, preprocessed: PreprocessedEssay): string {
  return [
    questionText || '',
    preprocessed.detectedTask || '',
    preprocessed.detectedSubtype || '',
    preprocessed.detectedTopic || '',
    preprocessed.normalizedEssay.slice(0, 800),
  ].join('\n')
}

function tokenize(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z]{3,}/g) || []
  return new Set(words)
}

function scoreChunk(
  terms: Set<string>,
  chunkText: string,
  detectedTask: TaskType | null,
  chunkTask: TaskType | null,
  detectedSubtype: string | null,
  chunkSubtype: string | null
): number {
  const chunkTerms = tokenize(chunkText)
  let score = 0
  for (const term of terms) {
    if (chunkTerms.has(term)) score += 1
  }
  if (detectedTask && chunkTask === detectedTask) score += 8
  if (detectedSubtype && chunkSubtype === detectedSubtype) score += 6
  return score
}
