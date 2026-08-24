import 'dotenv/config'
import { embedTexts, getEmbeddingConfig } from '../src/services/ai/embeddingProvider'
import { cosineSimilarity } from '../src/services/ai/hybridRanker'
import { getRerankConfig, rerankTexts } from '../src/services/ai/rerankProvider'

async function main() {
  const embeddingConfig = getEmbeddingConfig()
  const rerankConfig = getRerankConfig()
  if (!embeddingConfig.apiKey) {
    throw new Error(
      `No embedding key found for ${embeddingConfig.provider}. Configure VOYAGE_API_KEY, ZHIPU_API_KEY, or AI_EMBEDDING_API_KEY in .env.`,
    )
  }

  const query = 'The essay does not fully address whether the disadvantages outweigh the advantages.'
  const documents = [
    '该文章讨论了优缺点，但没有明确比较哪一方更重要，因此任务回应不完整。',
    'The writer uses a wide range of vocabulary with generally accurate collocations.',
    '主体段的中心句清楚，段内论证与题目保持一致。',
  ]
  const [documentResult, queryResult] = await Promise.all([
    embedTexts(documents, { inputType: 'document' }),
    embedTexts([query], { inputType: 'query' }),
  ])
  const similarities = documentResult.vectors.map((vector, index) => ({
    index,
    cosineSimilarity: Number(cosineSimilarity(queryResult.vectors[0], vector).toFixed(6)),
  })).sort((left, right) => right.cosineSimilarity - left.cosineSimilarity)

  const reranked = rerankConfig.enabled
    ? await rerankTexts(query, documents)
    : []

  console.log(JSON.stringify({
    embedding: {
      provider: embeddingConfig.provider,
      model: embeddingConfig.model,
      dimensions: documentResult.vectors[0]?.length || null,
      apiKeyConfigured: true,
      similarities,
    },
    rerank: {
      provider: rerankConfig.provider,
      model: rerankConfig.model || null,
      enabled: rerankConfig.enabled,
      apiKeyConfigured: Boolean(rerankConfig.apiKey),
      results: reranked,
    },
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
