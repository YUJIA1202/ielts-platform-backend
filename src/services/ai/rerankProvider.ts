import axios from 'axios'

export interface RerankConfig {
  provider: string
  model: string
  baseUrl: string
  apiKey: string | null
  candidateLimit: number
  enabled: boolean
}

export interface RerankResult {
  index: number
  relevanceScore: number
}

export function getRerankConfig(): RerankConfig {
  const embeddingProvider = process.env.AI_EMBEDDING_PROVIDER?.trim().toUpperCase()
  const provider = (process.env.AI_RERANK_PROVIDER?.trim()
    || (embeddingProvider === 'VOYAGE' || process.env.VOYAGE_API_KEY ? 'VOYAGE' : 'NONE'))
    .toUpperCase()
  const candidateLimitValue = Number(process.env.AI_RERANK_CANDIDATE_LIMIT || '')
  const candidateLimit = Number.isInteger(candidateLimitValue) && candidateLimitValue > 0
    ? Math.min(candidateLimitValue, 1_000)
    : 60
  const apiKey = process.env.AI_RERANK_API_KEY
    || (provider === 'VOYAGE'
      ? process.env.VOYAGE_API_KEY || process.env.AI_EMBEDDING_API_KEY
      : null)
    || null
  const enabledFlag = process.env.AI_RERANK_ENABLED?.trim().toLowerCase()

  return {
    provider,
    model: process.env.AI_RERANK_MODEL || (provider === 'VOYAGE' ? 'rerank-2.5' : ''),
    baseUrl: (process.env.AI_RERANK_BASE_URL
      || (provider === 'VOYAGE' ? 'https://api.voyageai.com/v1' : '')).replace(/\/$/, ''),
    apiKey,
    candidateLimit,
    enabled: enabledFlag !== 'false' && provider !== 'NONE' && Boolean(apiKey),
  }
}

export function hasRerankApiKey() {
  return getRerankConfig().enabled
}

export async function rerankTexts(query: string, documents: string[]): Promise<RerankResult[]> {
  if (!documents.length) return []
  const config = getRerankConfig()
  if (!config.enabled || !config.apiKey) return []
  if (config.provider !== 'VOYAGE') {
    throw new Error(`Unsupported rerank provider: ${config.provider}`)
  }

  try {
    const response = await axios.post(
      `${config.baseUrl}/rerank`,
      {
        query,
        documents,
        model: config.model,
        top_k: documents.length,
        return_documents: false,
        truncation: true,
      },
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 120_000,
      },
    )
    const results = Array.isArray(response.data?.data)
      ? response.data.data
      : Array.isArray(response.data?.results)
        ? response.data.results
        : []
    const parsed = results
      .map((item: unknown) => parseRerankResult(item))
      .filter((item: RerankResult | null): item is RerankResult => Boolean(item))
    if (parsed.length !== documents.length) {
      throw new Error(`Rerank provider returned ${parsed.length} results for ${documents.length} documents`)
    }
    return parsed.sort((left: RerankResult, right: RerankResult) => (
      right.relevanceScore - left.relevanceScore
    ))
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status
      const providerMessage = readProviderError(error.response?.data)
      throw new Error(
        `${config.provider} rerank request failed${status ? ` (${status})` : ''}${providerMessage ? `: ${providerMessage}` : ''}`,
      )
    }
    throw error
  }
}

function parseRerankResult(value: unknown): RerankResult | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const index = record.index
  const score = record.relevance_score ?? record.relevanceScore
  if (!Number.isInteger(index) || typeof score !== 'number' || !Number.isFinite(score)) return null
  return { index: index as number, relevanceScore: score }
}

function readProviderError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.message === 'string') return record.message
  if (record.detail && typeof record.detail === 'string') return record.detail
  if (record.error && typeof record.error === 'object') {
    const message = (record.error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return null
}
