import { KnowledgeEmbeddingStatus, Prisma } from '@prisma/client'
import prisma from '../../prisma'
import {
  embedTexts,
  embeddingContentHash,
  getEmbeddingBatchLimit,
  getEmbeddingConfig,
} from './embeddingProvider'

export interface EmbedKnowledgeOptions {
  limit?: number
  batchSize?: number
  dryRun?: boolean
  retryFailed?: boolean
}

export async function getEmbeddingStatus() {
  const config = getEmbeddingConfig()
  const [totalChunks, byStatus, byDimensions, recentFailures] = await Promise.all([
    prisma.knowledgeChunk.count({ where: { document: { allowedForRag: true } } }),
    prisma.knowledgeEmbedding.groupBy({
      by: ['status'],
      where: { provider: config.provider, model: config.model },
      _count: { _all: true },
    }),
    prisma.knowledgeEmbedding.groupBy({
      by: ['dimensions'],
      where: {
        provider: config.provider,
        model: config.model,
        status: KnowledgeEmbeddingStatus.COMPLETED,
      },
      _count: { _all: true },
    }),
    prisma.knowledgeEmbedding.findMany({
      where: {
        provider: config.provider,
        model: config.model,
        status: KnowledgeEmbeddingStatus.FAILED,
      },
      select: { chunkId: true, errorMessage: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    }),
  ])
  const statusCounts = Object.fromEntries(byStatus.map(row => [row.status, row._count._all]))
  const completed = statusCounts[KnowledgeEmbeddingStatus.COMPLETED] || 0
  return {
    provider: config.provider,
    model: config.model,
    apiKeyConfigured: Boolean(config.apiKey),
    totalChunks,
    embeddingsForModel: byStatus.reduce((sum, row) => sum + row._count._all, 0),
    completed,
    remaining: Math.max(0, totalChunks - completed),
    byStatus,
    byDimensions,
    recentFailures,
  }
}

export async function embedKnowledgeChunks(options: EmbedKnowledgeOptions = {}) {
  const config = getEmbeddingConfig()
  const limit = Math.max(1, Math.min(options.limit || 100, 10_000))
  const providerBatchLimit = getEmbeddingBatchLimit(config)
  const batchSize = Math.max(1, Math.min(options.batchSize || 50, providerBatchLimit))
  const pending: Awaited<ReturnType<typeof loadChunkPage>> = []
  let cursorId: number | undefined
  while (pending.length < limit) {
    const page = await loadChunkPage(config.provider, config.model, cursorId)
    if (!page.length) break
    cursorId = page[page.length - 1].id
    for (const chunk of page) {
      if (shouldEmbedChunk(chunk, Boolean(options.retryFailed))) pending.push(chunk)
      if (pending.length >= limit) break
    }
  }

  if (options.dryRun) {
    return {
      dryRun: true,
      provider: config.provider,
      model: config.model,
      selected: pending.length,
      chunkIds: pending.map(chunk => chunk.id),
    }
  }
  if (!config.apiKey) {
    throw new Error('Embedding API key is not configured; use --dry-run until a key is available')
  }

  let completed = 0
  let failed = 0
  for (let start = 0; start < pending.length; start += batchSize) {
    const batch = pending.slice(start, start + batchSize)
    await Promise.all(batch.map(chunk => prisma.knowledgeEmbedding.upsert({
      where: { chunkId_provider_model_embeddingRole: { chunkId: chunk.id, provider: config.provider, model: config.model, embeddingRole: 'PRIMARY' } },
      create: {
        chunkId: chunk.id,
        provider: config.provider,
        model: config.model,
        contentHash: embeddingContentHash(chunk.chunkText),
        status: KnowledgeEmbeddingStatus.PENDING,
      },
      update: {
        contentHash: embeddingContentHash(chunk.chunkText),
        vectorJson: Prisma.JsonNull,
        dimensions: null,
        status: KnowledgeEmbeddingStatus.PENDING,
        errorMessage: null,
      },
    })))

    try {
      const result = await embedTexts(
        batch.map(chunk => chunk.chunkText),
        { inputType: 'document' },
      )
      await prisma.$transaction(batch.map((chunk, index) => prisma.knowledgeEmbedding.update({
        where: { chunkId_provider_model_embeddingRole: { chunkId: chunk.id, provider: config.provider, model: config.model, embeddingRole: 'PRIMARY' } },
        data: {
          vectorJson: result.vectors[index] as unknown as Prisma.InputJsonValue,
          dimensions: result.vectors[index].length,
          status: KnowledgeEmbeddingStatus.COMPLETED,
          errorMessage: null,
        },
      })))
      completed += batch.length
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Embedding batch failed'
      await prisma.knowledgeEmbedding.updateMany({
        where: { chunkId: { in: batch.map(chunk => chunk.id) }, provider: config.provider, model: config.model },
        data: { status: KnowledgeEmbeddingStatus.FAILED, errorMessage: message },
      })
      failed += batch.length
    }
  }
  return { provider: config.provider, model: config.model, selected: pending.length, completed, failed }
}

function loadChunkPage(provider: string, model: string, cursorId?: number) {
  return prisma.knowledgeChunk.findMany({
    where: {
      document: { allowedForRag: true },
      ...(cursorId ? { id: { gt: cursorId } } : {}),
    },
    include: { embeddings: { where: { provider, model } } },
    orderBy: { id: 'asc' },
    take: 500,
  })
}

function shouldEmbedChunk(
  chunk: Awaited<ReturnType<typeof loadChunkPage>>[number],
  retryFailed: boolean,
) {
  const hash = embeddingContentHash(chunk.chunkText)
  const existing = chunk.embeddings[0]
  if (!existing || existing.contentHash !== hash) return true
  if (existing.status === KnowledgeEmbeddingStatus.FAILED) return retryFailed
  if (existing.status !== KnowledgeEmbeddingStatus.COMPLETED) return true
  return !Array.isArray(existing.vectorJson)
    || !existing.dimensions
    || existing.vectorJson.length !== existing.dimensions
}
