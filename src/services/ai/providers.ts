import axios from 'axios'
import { AiReviewScoreDimension, AiFindingCategory, AiIssueSeverity, AiIssueType } from '@prisma/client'
import { PreprocessedEssay, ReviewOutput } from './types'

export interface AiProviderResult {
  provider: string
  model: string
  output: ReviewOutput
  rawOutput: unknown
  inputTokens?: number
  outputTokens?: number
  latencyMs: number
}

export async function generateReviewWithProvider(input: {
  prompt: string
  preprocessed: PreprocessedEssay
}): Promise<AiProviderResult> {
  const apiKey = process.env.AI_PROVIDER_API_KEY || process.env.OPENAI_API_KEY
  const provider = process.env.AI_PROVIDER || (apiKey ? 'OPENAI_COMPATIBLE' : 'LOCAL_FALLBACK')
  const model = process.env.AI_PROVIDER_MODEL || 'gpt-4o-mini'
  const baseUrl = (process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')

  if (!apiKey) {
    const started = Date.now()
    const output = buildFallbackReview(input.preprocessed)
    return {
      provider: 'LOCAL_FALLBACK',
      model: 'local-structured-review-v1',
      output,
      rawOutput: output,
      latencyMs: Date.now() - started,
    }
  }

  const started = Date.now()
  const response = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model,
      messages: [
        { role: 'system', content: 'You return strict JSON for IELTS writing review tasks.' },
        { role: 'user', content: input.prompt },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 90_000,
    }
  )

  const content = response.data?.choices?.[0]?.message?.content
  if (!content || typeof content !== 'string') {
    throw new Error('AI provider returned empty content')
  }

  return {
    provider,
    model,
    output: JSON.parse(content) as ReviewOutput,
    rawOutput: response.data,
    inputTokens: response.data?.usage?.prompt_tokens,
    outputTokens: response.data?.usage?.completion_tokens,
    latencyMs: Date.now() - started,
  }
}

function buildFallbackReview(preprocessed: PreprocessedEssay): ReviewOutput {
  const firstSentence = preprocessed.sentences[0]
  const secondSentence = preprocessed.sentences[1] || firstSentence
  const taskScore = preprocessed.wordCount < 180 ? 5.5 : 6

  return {
    overallBand: taskScore,
    summary: '本地占位批改：系统已完成预处理、结构化输出、入库和前端展示链路。配置 AI_PROVIDER_API_KEY 后将改为真实模型批改。',
    priorityAdvice: '优先检查观点展开是否充分、段落推进是否清楚，以及句子层面的语法准确性。',
    scores: [
      {
        dimension: AiReviewScoreDimension.OVERALL,
        score: taskScore,
        rationale: '本地占位评分，用于验证数据流和页面展示。',
        evidence: `词数约 ${preprocessed.wordCount}。`,
      },
      {
        dimension: AiReviewScoreDimension.TASK_RESPONSE,
        score: taskScore,
        rationale: '需要结合题目进一步判断是否完整回应任务。',
        evidence: preprocessed.normalizedQuestion || '未提供题目文本。',
      },
      {
        dimension: AiReviewScoreDimension.COHERENCE_COHESION,
        score: 6,
        rationale: '段落和句子已被系统识别，真实模型会进一步判断逻辑衔接。',
        evidence: `检测到 ${preprocessed.paragraphs.length} 个段落。`,
      },
      {
        dimension: AiReviewScoreDimension.LEXICAL_RESOURCE,
        score: 6,
        rationale: '本地模式不做完整词汇评估。',
        evidence: '等待真实模型批改。',
      },
      {
        dimension: AiReviewScoreDimension.GRAMMAR_RANGE_ACCURACY,
        score: 6,
        rationale: '本地模式不做完整语法评估。',
        evidence: '等待真实模型批改。',
      },
    ],
    globalFindings: [
      {
        category: AiFindingCategory.TASK_RESPONSE,
        severity: AiIssueSeverity.MEDIUM,
        title: '需要确认是否充分回应题目',
        explanation: '真实模型会根据题型和题目要求判断是否跑题、漏答或展开不足。',
        suggestion: '正式接入模型后，应重点查看 Task Response 和逻辑展开反馈。',
      },
      {
        category: AiFindingCategory.STRUCTURE,
        severity: AiIssueSeverity.LOW,
        title: '结构化链路已运行',
        explanation: '系统已把作文分段、分句并生成 sentenceIndex，可支持逐句批注。',
        suggestion: '下一步可以接入 RAG 材料和真实模型提升反馈质量。',
      },
    ],
    sentenceAnnotations: firstSentence
      ? [
          {
            sentenceIndex: firstSentence.index,
            originalText: firstSentence.text,
            issueType: AiIssueType.TASK_RESPONSE,
            subtype: 'fallback_check',
            severity: AiIssueSeverity.MEDIUM,
            explanation: '这是本地占位批注，用于验证逐句定位功能。',
            suggestion: '接入真实模型后，这里会显示具体语言、逻辑或结构问题。',
            rubricDimension: AiReviewScoreDimension.TASK_RESPONSE,
          },
        ]
      : [],
    rewrites: secondSentence
      ? [
          {
            sentenceIndex: secondSentence.index,
            originalText: secondSentence.text,
            rewrittenText: secondSentence.text,
            reason: '本地占位改写：真实模型接入后会生成更自然、更符合 IELTS 标准的表达。',
          },
        ]
      : [],
  }
}
