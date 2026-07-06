import { KnowledgeEmbeddingStatus } from '@prisma/client'
import prisma from '../../prisma'
import { embedTexts, getEmbeddingConfig, hasEmbeddingApiKey } from './embeddingProvider'
import { RagChunk } from './types'

export interface HybridRankResult {
  chunks: RagChunk[]
  strategy: 'keyword_metadata' | 'hybrid_keyword_vector'
  embeddedCandidates: number
  vectors?: Map<number, number[]>
  queryVector?: number[]
}

// RRF constant: k=60 is the standard default (Cormack, Clarke & Büttcher, SIGIR 2009)
const RRF_K = 60

export async function hybridRankChunks(query: string, ranked: RagChunk[]): Promise<HybridRankResult> {
  const ragMode = process.env.AI_RAG_MODE?.trim().toLowerCase()
  if (!ranked.length || !hasEmbeddingApiKey() || ragMode === 'keyword') {
    return { chunks: ranked, strategy: 'keyword_metadata', embeddedCandidates: 0 }
  }
  const config = getEmbeddingConfig()
  const embeddings = await prisma.knowledgeEmbedding.findMany({
    where: {
      chunkId: { in: ranked.map(chunk => chunk.id) },
      provider: config.provider,
      model: config.model,
      status: KnowledgeEmbeddingStatus.COMPLETED,
    },
    select: { chunkId: true, vectorJson: true },
  })
  const vectors = new Map<number, number[]>()
  for (const row of embeddings) {
    if (isNumberVector(row.vectorJson)) vectors.set(row.chunkId, row.vectorJson)
  }
  if (vectors.size < 5) {
    return { chunks: ranked, strategy: 'keyword_metadata', embeddedCandidates: vectors.size }
  }

  const queryVector = (await embedTexts([query])).vectors[0]

  // Build semantic rank: sort candidates by cosine similarity (descending)
  const semanticSorted = ranked
    .filter(chunk => vectors.has(chunk.id))
    .map(chunk => ({ id: chunk.id, cosSim: cosineSimilarity(queryVector, vectors.get(chunk.id)!) }))
    .sort((a, b) => b.cosSim - a.cosSim)

  const semanticRankMap = new Map<number, number>()
  semanticSorted.forEach((item, idx) => semanticRankMap.set(item.id, idx + 1))

  // RRF fusion: score = 1/(k + keyword_rank) + 1/(k + semantic_rank)
  // Chunks without a semantic vector contribute only keyword rank term.
  const chunks = ranked.map((chunk, idx) => {
    const keywordRank = idx + 1
    const semanticRank = semanticRankMap.get(chunk.id) ?? null
    const rrfScore =
      1 / (RRF_K + keywordRank) +
      (semanticRank !== null ? 1 / (RRF_K + semanticRank) : 0)
    const vec = vectors.get(chunk.id)
    const semanticScore = vec ? cosineSimilarity(queryVector, vec) : null
    return { ...chunk, score: rrfScore, semanticScore }
  }).sort((a, b) => b.score - a.score)

  return {
    chunks,
    strategy: 'hybrid_keyword_vector',
    embeddedCandidates: vectors.size,
    vectors,
    queryVector,
  }
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm)
  return denominator ? dot / denominator : 0
}

function isNumberVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'number' && Number.isFinite(item))
}
