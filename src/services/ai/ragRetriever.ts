import {
  KnowledgeChunkType,
  KnowledgeSourceType,
  Prisma,
  TaskType,
} from '@prisma/client'
import prisma from '../../prisma'
import {
  PreprocessedEssay,
  RagChunk,
  RagEvidenceGroup,
  RagRetrievalPlan,
  RagRetrievalStage,
} from './types'
import { cosineSimilarity, hybridRankChunks } from './hybridRanker'

interface RetrievalInput {
  jobId: number
  questionText: string | null
  preprocessed: PreprocessedEssay
  stage?: RagRetrievalStage
  targetText?: string
  targetIndex?: number | null
  topK?: number
  previouslySelectedChunkIds?: ReadonlySet<number>
}

interface RetrievalResult {
  eventId: number
  group: RagEvidenceGroup
}

export async function retrieveHierarchicalRagPlan(input: {
  jobId: number
  questionText: string | null
  preprocessed: PreprocessedEssay
  maxPromptChunks?: number
}): Promise<RagRetrievalPlan> {
  const groups: RagEvidenceGroup[] = []
  const results: RetrievalResult[] = []
  const previouslySelectedChunkIds = new Set<number>()

  const globalResult = await retrieveRagChunks({
    ...input,
    stage: 'GLOBAL',
    targetText: input.preprocessed.normalizedEssay.slice(0, 1600),
    targetIndex: null,
    topK: 12,
    previouslySelectedChunkIds,
  })
  results.push(globalResult)
  globalResult.group.chunks.forEach(chunk => previouslySelectedChunkIds.add(chunk.id))

  for (const paragraph of input.preprocessed.paragraphs.slice(0, 10)) {
    const result = await retrieveRagChunks({
      ...input,
      stage: 'PARAGRAPH',
      targetText: paragraph.text,
      targetIndex: paragraph.index,
      topK: 8,
      previouslySelectedChunkIds,
    })
    results.push(result)
    result.group.chunks.forEach(chunk => previouslySelectedChunkIds.add(chunk.id))
  }

  for (const sentence of input.preprocessed.sentences.slice(0, 40)) {
    const result = await retrieveRagChunks({
      ...input,
      stage: 'SENTENCE',
      targetText: sentence.text,
      targetIndex: sentence.index,
      topK: 6,
      previouslySelectedChunkIds,
    })
    results.push(result)
    result.group.chunks.forEach(chunk => previouslySelectedChunkIds.add(chunk.id))
  }

  groups.push(...results.map(result => result.group))
  const promptChunks = selectPromptEvidence(groups, input.maxPromptChunks || 90)
  const promptChunkIds = new Set(promptChunks.map(chunk => chunk.id))

  await Promise.all(results.map(result => {
    const usedIds = result.group.chunks
      .filter(chunk => promptChunkIds.has(chunk.id))
      .map(chunk => chunk.id)
    if (!usedIds.length) return Promise.resolve({ count: 0 })
    return prisma.retrievalEventChunk.updateMany({
      where: {
        retrievalEventId: result.eventId,
        chunkId: { in: usedIds },
      },
      data: { usedInPrompt: true },
    })
  }))

  return { groups, promptChunks }
}

export async function retrieveRagChunks(input: RetrievalInput): Promise<RetrievalResult> {
  const stage = input.stage || 'GLOBAL'
  const topK = input.topK || defaultTopK(stage)
  const query = buildRetrievalQuery(
    input.questionText,
    input.preprocessed,
    stage,
    input.targetText,
  )
  const terms = tokenize(query)
  const searchableTerms = Array.from(terms).filter(term => !STOP_WORDS.has(term)).slice(0, 30)
  const baseWhere = buildMetadataFilter(input.preprocessed)
  const keywordWhere: Prisma.KnowledgeChunkWhereInput = searchableTerms.length
    ? {
        AND: [
          baseWhere,
          { OR: searchableTerms.map(term => ({ chunkText: { contains: term } })) },
        ],
      }
    : baseWhere

  let candidates = await prisma.knowledgeChunk.findMany({
    where: keywordWhere,
    include: { document: { include: { source: true } } },
    take: 700,
    orderBy: { createdAt: 'desc' },
  })
  if (!candidates.length && searchableTerms.length) {
    candidates = await prisma.knowledgeChunk.findMany({
      where: baseWhere,
      include: { document: { include: { source: true } } },
      take: 400,
      orderBy: { createdAt: 'desc' },
    })
  }

  candidates = await addMissingChannelCandidates(
    candidates,
    baseWhere,
    stageQuotas(stage, topK),
  )
  const keywordRanked = candidates
    .map(chunk => ({
      id: chunk.id,
      documentId: chunk.documentId,
      chunkText: chunk.chunkText,
      chunkType: chunk.chunkType,
      sourceType: chunk.document.source.sourceType,
      documentTitle: chunk.document.title,
      task: chunk.task,
      subtype: chunk.subtype,
      topic: chunk.topic,
      score: scoreChunk(
        terms,
        chunk.chunkText,
        input.preprocessed.detectedTask,
        chunk.task,
        input.preprocessed.detectedSubtype,
        chunk.subtype,
        chunk.document.source.sourceType,
        chunk.chunkType,
        stage,
      ),
    }))
    .filter(chunk => chunk.score > 0)
    .sort((a, b) => b.score - a.score)

  const hybrid = await hybridRankChunks(query, keywordRanked)
  const noveltyRanked = rankWithCrossStageNovelty(hybrid.chunks, input.previouslySelectedChunkIds)
  const selected = selectStageChunks(noveltyRanked, topK, stage, hybrid.vectors, hybrid.queryVector)
  const event = await prisma.retrievalEvent.create({
    data: {
      jobId: input.jobId,
      query: JSON.stringify({
        stage,
        targetIndex: input.targetIndex ?? null,
        text: query,
      }),
      topK,
      strategy: `hierarchical_${hybrid.strategy}_v1:${stage.toLowerCase()}`,
    },
  })

  if (selected.length) {
    await prisma.retrievalEventChunk.createMany({
      data: selected.map((chunk, index) => ({
        retrievalEventId: event.id,
        chunkId: chunk.id,
        rank: index + 1,
        similarityScore: chunk.score,
        usedInPrompt: false,
      })),
      skipDuplicates: true,
    })
  }

  return {
    eventId: event.id,
    group: {
      stage,
      targetIndex: input.targetIndex ?? null,
      targetText: input.targetText || null,
      chunks: selected,
    },
  }
}

function buildMetadataFilter(preprocessed: PreprocessedEssay): Prisma.KnowledgeChunkWhereInput {
  const filters: Prisma.KnowledgeChunkWhereInput[] = []
  if (preprocessed.detectedTask) {
    filters.push({ OR: [{ task: preprocessed.detectedTask }, { task: null }] })
  }
  if (preprocessed.detectedSubtype) {
    filters.push({ OR: [{ subtype: preprocessed.detectedSubtype }, { subtype: null }] })
  }
  return filters.length ? { AND: filters } : {}
}

async function addMissingChannelCandidates(
  candidates: Awaited<ReturnType<typeof findChannelCandidates>>,
  baseWhere: Prisma.KnowledgeChunkWhereInput,
  required: Record<EvidenceChannel, number>,
) {
  const counts: Record<EvidenceChannel, number> = {
    ANNOTATION: 0,
    TEACHER_CONTEXT: 0,
    MODEL_REFERENCE: 0,
    RUBRIC: 0,
  }
  for (const candidate of candidates) {
    counts[classifyChannel(candidate.document.source.sourceType, candidate.chunkType)] += 1
  }
  const missing = (Object.keys(required) as EvidenceChannel[])
    .filter(channel => required[channel] > 0 && counts[channel] < required[channel])
  if (!missing.length) return candidates

  const additions = await findChannelCandidates(baseWhere, missing)
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]))
  for (const candidate of additions) byId.set(candidate.id, candidate)
  return Array.from(byId.values())
}

function findChannelCandidates(
  baseWhere: Prisma.KnowledgeChunkWhereInput,
  channels: readonly EvidenceChannel[] = ['ANNOTATION', 'TEACHER_CONTEXT', 'MODEL_REFERENCE', 'RUBRIC'],
) {
  const channelFilters = channels.map(channel => channelWhere(channel))
  return prisma.knowledgeChunk.findMany({
    where: { AND: [baseWhere, { OR: channelFilters }] },
    include: { document: { include: { source: true } } },
    take: 500,
    orderBy: { createdAt: 'desc' },
  })
}

function channelWhere(channel: EvidenceChannel): Prisma.KnowledgeChunkWhereInput {
  if (channel === 'ANNOTATION') {
    return {
      chunkType: { in: [KnowledgeChunkType.REVIEW_EXAMPLE, KnowledgeChunkType.ERROR_EXPLANATION] },
      document: { source: { sourceType: { in: [KnowledgeSourceType.TEACHER_REVIEW, KnowledgeSourceType.ERROR_LIBRARY] } } },
    }
  }
  if (channel === 'TEACHER_CONTEXT') {
    return {
      chunkType: KnowledgeChunkType.ESSAY_PARAGRAPH,
      document: { source: { sourceType: KnowledgeSourceType.TEACHER_REVIEW } },
    }
  }
  if (channel === 'MODEL_REFERENCE') {
    return { document: { source: { sourceType: KnowledgeSourceType.MODEL_ESSAY } } }
  }
  return {
    OR: [
      { chunkType: KnowledgeChunkType.RUBRIC },
      { document: { source: { sourceType: KnowledgeSourceType.IELTS_RUBRIC } } },
    ],
  }
}

function buildRetrievalQuery(
  questionText: string | null,
  preprocessed: PreprocessedEssay,
  stage: RagRetrievalStage,
  targetText?: string,
): string {
  return [
    questionText || '',
    preprocessed.detectedTask || '',
    preprocessed.detectedSubtype || '',
    preprocessed.detectedTopic || '',
    stage,
    targetText || preprocessed.normalizedEssay.slice(0, 1200),
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
  chunkSubtype: string | null,
  sourceType: KnowledgeSourceType,
  chunkType: KnowledgeChunkType,
  stage: RagRetrievalStage,
): number {
  const chunkTerms = tokenize(chunkText)
  let score = 0
  for (const term of terms) {
    if (chunkTerms.has(term)) score += 1
  }
  if (detectedTask && chunkTask === detectedTask) score += 8
  if (detectedSubtype && chunkSubtype?.toLowerCase() === detectedSubtype.toLowerCase()) score += 6

  const channel = classifyChannel(sourceType, chunkType)
  if (channel === 'ANNOTATION') score += stage === 'SENTENCE' ? 10 : 6
  if (channel === 'TEACHER_CONTEXT') score += stage === 'PARAGRAPH' ? 8 : 4
  if (channel === 'MODEL_REFERENCE') score += stage === 'GLOBAL' ? 5 : 3
  if (channel === 'RUBRIC') score += stage === 'GLOBAL' ? 8 : 3
  return score
}

// λ for MMR: 0.5 balances relevance and diversity (Carbonell & Goldstein, 1998)
const MMR_LAMBDA = 0.5

function selectStageChunks(
  ranked: RagChunk[],
  topK: number,
  stage: RagRetrievalStage,
  vectors?: Map<number, number[]>,
  queryVector?: number[],
): RagChunk[] {
  const quotas = stageQuotas(stage, topK)
  const selected: RagChunk[] = []
  const selectedIds = new Set<number>()
  const useMMR = !!(vectors && queryVector && vectors.size >= 5)

  for (const [channel, limit] of Object.entries(quotas) as [EvidenceChannel, number][]) {
    const channelItems = ranked.filter(chunk =>
      classifyChannel(chunk.sourceType as KnowledgeSourceType, chunk.chunkType as KnowledgeChunkType) === channel
    )
    const channelSelected = useMMR
      ? mmrSelect(channelItems, limit, vectors!, queryVector!, selected)
      : channelItems.slice(0, limit)

    for (const chunk of channelSelected) {
      if (selectedIds.has(chunk.id)) continue
      selected.push(chunk)
      selectedIds.add(chunk.id)
    }
  }

  for (const chunk of ranked) {
    if (selected.length >= topK) break
    if (selectedIds.has(chunk.id)) continue
    selected.push(chunk)
    selectedIds.add(chunk.id)
  }
  return selected.slice(0, topK)
}

function mmrSelect(
  candidates: RagChunk[],
  limit: number,
  vectors: Map<number, number[]>,
  queryVector: number[],
  globallySelected: RagChunk[],
): RagChunk[] {
  if (!limit || !candidates.length) return []
  const globalIds = new Set(globallySelected.map(c => c.id))
  const remaining = candidates.filter(c => !globalIds.has(c.id))
  const result: RagChunk[] = []
  const localSelected: number[] = []

  while (result.length < limit && remaining.length > 0) {
    let bestIdx = 0
    let bestMMR = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const chunk = remaining[i]
      const vec = vectors.get(chunk.id)
      const relevance = vec ? normCos(cosineSimilarity(queryVector, vec)) : chunk.score

      let maxRedundancy = 0
      if (localSelected.length > 0 && vec) {
        for (const selId of localSelected) {
          const selVec = vectors.get(selId)
          if (selVec) maxRedundancy = Math.max(maxRedundancy, normCos(cosineSimilarity(vec, selVec)))
        }
      }

      const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxRedundancy
      if (mmr > bestMMR) {
        bestMMR = mmr
        bestIdx = i
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0]
    result.push(chosen)
    localSelected.push(chosen.id)
  }
  return result
}

function normCos(value: number): number {
  return Math.max(0, Math.min(1, (value + 1) / 2))
}

function selectPromptEvidence(groups: RagEvidenceGroup[], limit: number): RagChunk[] {
  const selected: RagChunk[] = []
  const ids = new Set<number>()
  const queues = [
    groups.filter(group => group.stage === 'GLOBAL'),
    groups.filter(group => group.stage === 'PARAGRAPH'),
    groups.filter(group => group.stage === 'SENTENCE'),
  ]

  for (const stageGroups of queues) {
    let offset = 0
    while (selected.length < limit) {
      let added = false
      for (const group of stageGroups) {
        const chunk = group.chunks[offset]
        if (!chunk || ids.has(chunk.id)) continue
        selected.push(chunk)
        ids.add(chunk.id)
        added = true
        if (selected.length >= limit) break
      }
      if (!added) break
      offset += 1
    }
  }
  return selected
}

function rankWithCrossStageNovelty(
  ranked: RagChunk[],
  previouslySelectedChunkIds?: ReadonlySet<number>,
): RagChunk[] {
  if (!previouslySelectedChunkIds?.size) return ranked
  // Penalty is relative to the top score so it stays meaningful at any score scale
  // (RRF scores are ~0–0.033; keyword scores can be 0–30+).
  const maxScore = ranked[0]?.score ?? 1
  const penalty = maxScore * 0.3
  return [...ranked].sort((a, b) => {
    const adjustedA = a.score - (previouslySelectedChunkIds.has(a.id) ? penalty : 0)
    const adjustedB = b.score - (previouslySelectedChunkIds.has(b.id) ? penalty : 0)
    return adjustedB - adjustedA
  })
}

function defaultTopK(stage: RagRetrievalStage) {
  if (stage === 'GLOBAL') return 12
  if (stage === 'PARAGRAPH') return 8
  return 6
}

function stageQuotas(stage: RagRetrievalStage, topK: number): Record<EvidenceChannel, number> {
  if (stage === 'GLOBAL') {
    return { ANNOTATION: 4, TEACHER_CONTEXT: 3, MODEL_REFERENCE: 3, RUBRIC: 2 }
  }
  if (stage === 'PARAGRAPH') {
    return { ANNOTATION: 3, TEACHER_CONTEXT: 2, MODEL_REFERENCE: 2, RUBRIC: 1 }
  }
  return { ANNOTATION: 4, TEACHER_CONTEXT: 1, MODEL_REFERENCE: 1, RUBRIC: 0 }
}

function classifyChannel(sourceType: KnowledgeSourceType, chunkType: KnowledgeChunkType): EvidenceChannel {
  if (
    (sourceType === KnowledgeSourceType.TEACHER_REVIEW || sourceType === KnowledgeSourceType.ERROR_LIBRARY) &&
    (chunkType === KnowledgeChunkType.REVIEW_EXAMPLE || chunkType === KnowledgeChunkType.ERROR_EXPLANATION)
  ) return 'ANNOTATION'
  if (sourceType === KnowledgeSourceType.TEACHER_REVIEW && chunkType === KnowledgeChunkType.ESSAY_PARAGRAPH) {
    return 'TEACHER_CONTEXT'
  }
  if (sourceType === KnowledgeSourceType.MODEL_ESSAY) return 'MODEL_REFERENCE'
  if (sourceType === KnowledgeSourceType.IELTS_RUBRIC || chunkType === KnowledgeChunkType.RUBRIC) return 'RUBRIC'
  return 'TEACHER_CONTEXT'
}

type EvidenceChannel = 'ANNOTATION' | 'TEACHER_CONTEXT' | 'MODEL_REFERENCE' | 'RUBRIC'

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'among', 'because', 'been', 'before',
  'being', 'between', 'both', 'could', 'does', 'from', 'have', 'into', 'many', 'more',
  'most', 'other', 'people', 'should', 'some', 'such', 'than', 'that', 'their', 'there',
  'these', 'they', 'this', 'those', 'through', 'very', 'what', 'when', 'where', 'which',
  'while', 'with', 'would', 'your',
])
