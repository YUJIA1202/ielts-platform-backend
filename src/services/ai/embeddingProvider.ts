import axios from 'axios'
import crypto from 'crypto'

export interface EmbeddingConfig {
  provider: string
  model: string
  baseUrl: string
  apiKey: string | null
  dimensions?: number
}

export interface EmbeddingBatchResult {
  vectors: number[][]
  inputTokens?: number
}

export type EmbeddingInputType = 'query' | 'document'

export interface EmbedTextsOptions {
  inputType?: EmbeddingInputType
}

export function getEmbeddingConfig(): EmbeddingConfig {
  const provider = resolveEmbeddingProvider()
  const dimensions = Number(process.env.AI_EMBEDDING_DIMENSIONS || '')
  return {
    provider,
    model: process.env.AI_EMBEDDING_MODEL || defaultEmbeddingModel(provider),
    baseUrl: (process.env.AI_EMBEDDING_BASE_URL || defaultEmbeddingBaseUrl(provider)).replace(/\/$/, ''),
    apiKey: resolveEmbeddingApiKey(provider),
    dimensions: Number.isInteger(dimensions) && dimensions > 0 ? dimensions : undefined,
  }
}

export function hasEmbeddingApiKey() {
  return Boolean(getEmbeddingConfig().apiKey)
}

export function getEmbeddingBatchLimit(config = getEmbeddingConfig()) {
  if (isZhipuProvider(config)) return 64
  if (isVoyageProvider(config)) return 128
  return 200
}

export async function embedTexts(
  texts: string[],
  options: EmbedTextsOptions = {},
): Promise<EmbeddingBatchResult> {
  if (!texts.length) return { vectors: [] }
  const config = getEmbeddingConfig()
  if (!config.apiKey) throw new Error('Embedding API key is not configured')
  const batchLimit = getEmbeddingBatchLimit(config)
  if (texts.length > batchLimit) {
    throw new Error(`${config.provider} embedding accepts at most ${batchLimit} inputs per application batch`)
  }
  if (
    isZhipuProvider(config)
    && config.dimensions
    && ![256, 512, 1024, 2048].includes(config.dimensions)
  ) {
    throw new Error('Zhipu embedding-3 dimensions must be 256, 512, 1024, or 2048')
  }

  const expanded = texts.flatMap((text, ownerIndex) => (
    splitEmbeddingText(config, text).map(segment => ({ ownerIndex, segment }))
  ))
  const segmentVectors: number[][] = []
  let inputTokens = 0
  let hasTokenUsage = false
  try {
    for (let start = 0; start < expanded.length; start += batchLimit) {
      const batch = expanded.slice(start, start + batchLimit)
      const result = await requestEmbeddingBatch(
        config,
        batch.map(item => item.segment),
        options,
      )
      segmentVectors.push(...result.vectors)
      if (typeof result.inputTokens === 'number') {
        inputTokens += result.inputTokens
        hasTokenUsage = true
      }
    }

    const dimensions = segmentVectors[0]?.length
    if (!dimensions || segmentVectors.some(vector => vector.length !== dimensions)) {
      throw new Error('Embedding provider returned inconsistent vector dimensions')
    }
    const grouped = Array.from({ length: texts.length }, () => [] as number[][])
    expanded.forEach((item, index) => grouped[item.ownerIndex].push(segmentVectors[index]))
    const vectors = grouped.map(group => averageAndNormalizeVectors(group))
    return { vectors, inputTokens: hasTokenUsage ? inputTokens : undefined }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status
      const providerMessage = readProviderError(error.response?.data)
      throw new Error(
        `${config.provider} embedding request failed${status ? ` (${status})` : ''}${providerMessage ? `: ${providerMessage}` : ''}`,
      )
    }
    throw error
  }
}

export function embeddingContentHash(text: string) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function resolveEmbeddingProvider() {
  const explicit = process.env.AI_EMBEDDING_PROVIDER?.trim()
  if (explicit) return explicit.toUpperCase()
  if (process.env.VOYAGE_API_KEY) return 'VOYAGE'
  if (process.env.ZHIPU_API_KEY) return 'ZHIPU'
  return 'OPENAI'
}

function resolveEmbeddingApiKey(provider: string) {
  if (process.env.AI_EMBEDDING_API_KEY) return process.env.AI_EMBEDDING_API_KEY
  if (provider === 'VOYAGE') return process.env.VOYAGE_API_KEY || null
  if (provider === 'ZHIPU') return process.env.ZHIPU_API_KEY || null
  return process.env.OPENAI_API_KEY || null
}

function defaultEmbeddingModel(provider: string) {
  if (provider === 'VOYAGE') return 'voyage-4-large'
  if (provider === 'ZHIPU') return 'embedding-3'
  return 'text-embedding-3-large'
}

function defaultEmbeddingBaseUrl(provider: string) {
  if (provider === 'VOYAGE') return 'https://api.voyageai.com/v1'
  if (provider === 'ZHIPU') return 'https://open.bigmodel.cn/api/paas/v4'
  return 'https://api.openai.com/v1'
}

function isVoyageProvider(config: EmbeddingConfig) {
  return config.provider === 'VOYAGE' || config.baseUrl.includes('voyageai.com')
}

function isZhipuProvider(config: EmbeddingConfig) {
  return config.provider === 'ZHIPU' || config.baseUrl.includes('bigmodel.cn')
}

function buildEmbeddingRequest(
  config: EmbeddingConfig,
  texts: string[],
  options: EmbedTextsOptions,
) {
  if (isVoyageProvider(config)) {
    return {
      model: config.model,
      input: texts,
      input_type: options.inputType || 'document',
      ...(config.dimensions ? { output_dimension: config.dimensions } : {}),
    }
  }
  return {
    model: config.model,
    input: texts,
    ...(config.dimensions ? { dimensions: config.dimensions } : {}),
  }
}

async function requestEmbeddingBatch(
  config: EmbeddingConfig,
  texts: string[],
  options: EmbedTextsOptions,
): Promise<EmbeddingBatchResult> {
  const response = await axios.post(
    `${config.baseUrl}/embeddings`,
    buildEmbeddingRequest(config, texts, options),
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 120_000,
    },
  )
  const rows = Array.isArray(response.data?.data)
    ? [...response.data.data].sort((a, b) => a.index - b.index)
    : []
  const vectors = rows.map(row => row.embedding).filter(Array.isArray) as number[][]
  if (vectors.length !== texts.length) {
    throw new Error(`Embedding provider returned ${vectors.length} vectors for ${texts.length} inputs`)
  }
  return { vectors, inputTokens: response.data?.usage?.total_tokens }
}

function splitEmbeddingText(config: EmbeddingConfig, text: string): string[] {
  if (!isZhipuProvider(config)) return [text]
  const configured = Number(process.env.AI_ZHIPU_EMBEDDING_SEGMENT_CHARS || '')
  const maxChars = Number.isInteger(configured) && configured >= 500
    ? Math.min(configured, 2_800)
    : 2_400
  if (text.length <= maxChars) return [text]

  const segments: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars)
    if (end < text.length) {
      const minimumBreak = start + Math.floor(maxChars * 0.65)
      const newline = text.lastIndexOf('\n', end)
      const sentence = Math.max(
        text.lastIndexOf('. ', end),
        text.lastIndexOf('。', end),
        text.lastIndexOf('；', end),
        text.lastIndexOf('; ', end),
      )
      const whitespace = text.lastIndexOf(' ', end)
      const boundary = Math.max(newline, sentence >= 0 ? sentence + 1 : -1, whitespace)
      if (boundary >= minimumBreak) end = boundary
    }
    const segment = text.slice(start, end).trim()
    if (segment) segments.push(segment)
    start = end
    while (start < text.length && /\s/.test(text[start])) start += 1
  }
  return segments.length ? segments : [text]
}

function averageAndNormalizeVectors(vectors: number[][]): number[] {
  if (!vectors.length) throw new Error('Embedding provider returned no vector for an input')
  if (vectors.length === 1) return vectors[0]
  const dimensions = vectors[0].length
  const average = Array.from({ length: dimensions }, (_, dimension) => (
    vectors.reduce((sum, vector) => sum + vector[dimension], 0) / vectors.length
  ))
  const norm = Math.sqrt(average.reduce((sum, value) => sum + value * value, 0))
  return norm ? average.map(value => value / norm) : average
}

function readProviderError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.message === 'string') return record.message
  if (record.error && typeof record.error === 'object') {
    const message = (record.error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return null
}
