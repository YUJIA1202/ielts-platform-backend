import 'dotenv/config'
import { generateStructuredWithProvider } from '../src/services/ai/providers'

async function main() {
  const result = await generateStructuredWithProvider<{ status: string }>({
    systemPrompt: 'Return strict JSON only. Do not include markdown.',
    userPrompt: 'Return exactly one JSON object with the field status set to ok.',
    fallbackOutput: { status: 'fallback' },
  })
  if (result.output?.status !== 'ok') {
    throw new Error(`Unexpected provider response: ${JSON.stringify(result.output)}`)
  }
  console.log(JSON.stringify({
    provider: result.provider,
    model: result.model,
    status: result.output.status,
    inputTokens: result.inputTokens ?? null,
    outputTokens: result.outputTokens ?? null,
    latencyMs: result.latencyMs,
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
