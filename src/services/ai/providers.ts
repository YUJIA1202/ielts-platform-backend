import axios from 'axios'
import {
  AiAnnotationLevel,
  AiAnnotationLocationStatus,
  AiFindingCategory,
  AiIssueSeverity,
  AiIssueType,
  AiRevisionOperation,
  AiReviewScoreDimension,
} from '@prisma/client'
import { PreprocessedEssay, ReviewOutput } from './types'

export interface StructuredProviderInput<T> {
  systemPrompt: string
  userPrompt: string
  fallbackOutput: T
  temperature?: number
  maxOutputTokens?: number
  thinkingMode?: 'enabled' | 'disabled'
  reasoningEffort?: 'low' | 'medium' | 'high'
}

export interface AiProviderResult<T> {
  provider: string
  model: string
  output: T
  rawOutput: unknown
  inputTokens?: number
  outputTokens?: number
  latencyMs: number
}

export interface StructuredModelProvider {
  readonly providerName: string
  readonly model: string
  generateJson<T>(input: StructuredProviderInput<T>): Promise<AiProviderResult<T>>
}

export async function generateStructuredWithProvider<T>(input: StructuredProviderInput<T>) {
  return resolveModelProvider().generateJson(input)
}

export function resolveModelProvider(): StructuredModelProvider {
  const providerName = resolveGenerationProvider()
  const apiKey = process.env.AI_PROVIDER_API_KEY
    || (providerName === 'DEEPSEEK' ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY)
  if (!apiKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('AI provider API key is required in production')
    }
    return new LocalFallbackProvider()
  }
  const model = process.env.AI_PROVIDER_MODEL?.trim()
    || (providerName === 'DEEPSEEK' ? 'deepseek-v4-pro' : '')
  if (!model) {
    throw new Error('AI_PROVIDER_MODEL must be configured explicitly when an AI provider API key is present')
  }
  return new OpenAiCompatibleProvider({
    providerName,
    apiKey,
    baseUrl: process.env.AI_PROVIDER_BASE_URL
      || (providerName === 'DEEPSEEK' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1'),
    model,
  })
}

export async function generateReviewWithProvider(input: { prompt: string; preprocessed: PreprocessedEssay }) {
  return generateStructuredWithProvider<ReviewOutput>({
    systemPrompt: 'You return strict JSON for IELTS writing feedback tasks.',
    userPrompt: input.prompt,
    fallbackOutput: buildFallbackReview(input.preprocessed),
    temperature: 0.2,
  })
}

class OpenAiCompatibleProvider implements StructuredModelProvider {
  readonly providerName: string
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(config: { providerName: string; apiKey: string; baseUrl: string; model: string }) {
    this.providerName = config.providerName
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.model = config.model
  }

  async generateJson<T>(input: StructuredProviderInput<T>): Promise<AiProviderResult<T>> {
    const started = Date.now()
    const isDeepSeek = this.providerName.toUpperCase() === 'DEEPSEEK'
      || this.baseUrl.includes('api.deepseek.com')
    const requestBody = {
      model: this.model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt },
      ],
      response_format: { type: 'json_object' },
      stream: false,
      ...(input.maxOutputTokens ? { max_tokens: input.maxOutputTokens } : {}),
      ...(isDeepSeek
        ? {
            thinking: { type: input.thinkingMode || process.env.AI_PROVIDER_THINKING || 'enabled' },
            reasoning_effort: input.reasoningEffort || process.env.AI_PROVIDER_REASONING_EFFORT || 'high',
          }
        : { temperature: input.temperature ?? 0.2 }),
    }
    try {
      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        requestBody,
        {
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 300_000,
        },
      )
      const choice = response.data?.choices?.[0]
      const content = choice?.message?.content
      if (!content || typeof content !== 'string') throw new Error('AI provider returned empty content')
      return {
        provider: this.providerName,
        model: this.model,
        output: parseStructuredJson<T>(content),
        // DeepSeek can return reasoning_content. Thinking is used by the model, but raw CoT is
        // deliberately not persisted; the product stores conclusions, evidence and validation.
        rawOutput: {
          id: response.data?.id,
          model: response.data?.model,
          finishReason: choice?.finish_reason,
          content,
          usage: response.data?.usage,
        },
        inputTokens: response.data?.usage?.prompt_tokens,
        outputTokens: response.data?.usage?.completion_tokens,
        latencyMs: Date.now() - started,
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status
        const providerMessage = readProviderError(error.response?.data)
        throw new Error(
          `${this.providerName} generation request failed${status ? ` (${status})` : ''}${providerMessage ? `: ${providerMessage}` : ''}`,
        )
      }
      throw error
    }
  }
}

class LocalFallbackProvider implements StructuredModelProvider {
  readonly providerName = 'LOCAL_FALLBACK'
  readonly model = 'local-structured-pipeline-v1'

  async generateJson<T>(input: StructuredProviderInput<T>): Promise<AiProviderResult<T>> {
    const started = Date.now()
    return {
      provider: this.providerName,
      model: this.model,
      output: input.fallbackOutput,
      rawOutput: input.fallbackOutput,
      latencyMs: Date.now() - started,
    }
  }
}

export function buildFallbackReview(preprocessed: PreprocessedEssay): ReviewOutput {
  const firstSentence = preprocessed.sentences[0]
  const secondSentence = preprocessed.sentences[1] || firstSentence
  const anchorText = firstSentence?.text.split(/\s+/).slice(0, 2).join(' ') || null
  return {
    overallBand: null,
    summary: '本地流程测试已完成预处理、分层RAG检索、多阶段结构、精确定位和结果入库。当前没有配置模型API，因此这不是正式AI批改结果。',
    priorityAdvice: '配置模型API后，再评估错误识别、逐词批注、段落反馈和改写质量。',
    scores: [],
    globalFindings: [{
      category: AiFindingCategory.TASK_RESPONSE,
      severity: AiIssueSeverity.MEDIUM,
      title: '等待真实模型分析',
      explanation: '本地Fallback只验证工程流程，不判断文章是否跑题、漏答或展开不足。',
      suggestion: '接入真实模型后再检查任务回应和论证展开。',
    }],
    sentenceAnnotations: firstSentence ? [{
      paragraphIndex: firstSentence.paragraphIndex,
      sentenceIndex: firstSentence.index,
      level: anchorText ? AiAnnotationLevel.PHRASE : AiAnnotationLevel.SENTENCE,
      originalText: firstSentence.text,
      anchorText,
      locationStatus: AiAnnotationLocationStatus.PENDING,
      issueType: AiIssueType.TASK_RESPONSE,
      subtype: 'fallback_check',
      severity: AiIssueSeverity.MEDIUM,
      explanation: '这是本地占位批注，仅用于验证原文范围定位和右侧批注所需的数据。',
      suggestion: '接入真实模型后，这里会显示具体语言、逻辑或结构问题。',
      replacementText: null,
      rubricDimension: AiReviewScoreDimension.TASK_RESPONSE,
    }] : [],
    rewrites: secondSentence ? [{
      sentenceIndex: secondSentence.index,
      paragraphIndex: secondSentence.paragraphIndex,
      level: AiAnnotationLevel.SENTENCE,
      operation: AiRevisionOperation.REPLACE,
      anchorText: secondSentence.text,
      occurrence: 1,
      originalText: secondSentence.text,
      rewrittenText: secondSentence.text,
      reason: '本地占位改写：真实模型接入后会生成更自然、符合IELTS写作要求的表达。',
    }] : [],
  }
}

function resolveGenerationProvider() {
  const explicit = process.env.AI_PROVIDER?.trim()
  if (explicit) return explicit.toUpperCase()
  if (process.env.DEEPSEEK_API_KEY) return 'DEEPSEEK'
  return 'OPENAI_COMPATIBLE'
}

function parseStructuredJson<T>(content: string): T {
  const normalized = content.trim().replace(/^\uFEFF/, '')
  try {
    return JSON.parse(normalized) as T
  } catch {
    const withoutFence = normalized
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()
    try {
      return JSON.parse(withoutFence) as T
    } catch {
      const firstObject = withoutFence.indexOf('{')
      const lastObject = withoutFence.lastIndexOf('}')
      if (firstObject >= 0 && lastObject > firstObject) {
        return JSON.parse(withoutFence.slice(firstObject, lastObject + 1)) as T
      }
      throw new Error('AI provider returned invalid JSON')
    }
  }
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
