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

export function getEmbeddingConfig(): EmbeddingConfig {
  const dimensions = Number(process.env.AI_EMBEDDING_DIMENSIONS || '')
  return {
    provider: process.env.AI_EMBEDDING_PROVIDER || 'OPENAI',
    model: process.env.AI_EMBEDDING_MODEL || 'text-embedding-3-large',
    baseUrl: (process.env.AI_EMBEDDING_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: process.env.AI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || null,
    dimensions: Number.isInteger(dimensions) && dimensions > 0 ? dimensions : undefined,
  }
}

export function hasEmbeddingApiKey() {
  return Boolean(getEmbeddingConfig().apiKey)
}

export async function embedTexts(texts: string[]): Promise<EmbeddingBatchResult> {
  if (!texts.length) return { vectors: [] }
  const config = getEmbeddingConfig()
  if (!config.apiKey) throw new Error('Embedding API key is not configured')
  const isZhipu = config.provider.toUpperCase() === 'ZHIPU'
    || config.baseUrl.includes('bigmodel.cn')
  if (isZhipu && texts.length > 64) {
    throw new Error('Zhipu embedding-3 accepts at most 64 inputs per request')
  }
  if (
    isZhipu
    && config.dimensions
    && ![256, 512, 1024, 2048].includes(config.dimensions)
  ) {
    throw new Error('Zhipu embedding-3 dimensions must be 256, 512, 1024, or 2048')
  }

  const response = await axios.post(
    `${config.baseUrl}/embeddings`,
    {
      model: config.model,
      input: texts,
      ...(config.dimensions ? { dimensions: config.dimensions } : {}),
    },
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
  const dimensions = vectors[0]?.length
  if (!dimensions || vectors.some(vector => vector.length !== dimensions)) {
    throw new Error('Embedding provider returned inconsistent vector dimensions')
  }
  return { vectors, inputTokens: response.data?.usage?.total_tokens }
}

export function embeddingContentHash(text: string) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}
