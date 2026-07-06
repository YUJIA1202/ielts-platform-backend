import {
  AiAnnotationLevel,
  AiAnnotationLocationStatus,
  AiFindingCategory,
  AiIssueSeverity,
  AiIssueType,
  AiModelCallStatus,
  AiModelCallType,
  AiRevisionOperation,
  AiReviewScoreDimension,
  AiReviewStage,
  AiStageValidationStatus,
  Prisma,
} from '@prisma/client'
import prisma from '../../prisma'
import { AiProviderResult, generateStructuredWithProvider, resolveModelProvider } from './providers'
import { buildReviewStagePlan } from './stagePlanner'
import {
  composeGlobalStagePrompt,
  composeParagraphStagePrompt,
  composeRepairStagePrompt,
  composeSentenceStagePrompt,
  composeVerifierStagePrompt,
} from './stagePromptComposer'
import {
  GlobalAnalysisOutput,
  ParagraphAnalysisOutput,
  ParagraphBatchAnalysisOutput,
  SentenceBatchAnalysisOutput,
  VerificationOutput,
} from './stageTypes'
import { PreprocessedEssay, RagChunk, RagRetrievalPlan, ReviewOutput } from './types'
import { validateReviewOutput } from './reviewValidator'

const STAGE_PROMPT_VERSION = 'ai-review-multistage-v1'

export async function runMultiStageReviewPipeline(input: {
  userId: number
  jobId: number
  questionText: string | null
  essay: PreprocessedEssay
  ragPlan: RagRetrievalPlan
}) {
  const started = Date.now()
  const plan = buildReviewStagePlan(input.essay)
  const global = await executeStage({
    ...input,
    stage: AiReviewStage.GLOBAL_ANALYSIS,
    targetIndex: null,
    systemPrompt: 'You are the global IELTS essay analyst. Return strict JSON and no hidden reasoning.',
    userPrompt: composeGlobalStagePrompt({
      questionText: input.questionText,
      essay: input.essay,
      evidence: evidenceFor(input.ragPlan, 'GLOBAL', []),
    }),
    fallbackOutput: fallbackGlobal(input.essay),
    validate: validateGlobal,
  })

  const paragraphAnalyses: ParagraphAnalysisOutput[] = []
  let totalInputTokens = global.inputTokens
  let totalOutputTokens = global.outputTokens
  for (const batch of plan.paragraphBatches) {
    const result = await executeStage({
      ...input,
      stage: AiReviewStage.PARAGRAPH_ANALYSIS,
      targetIndex: batch.targetIndexes[0] || null,
      systemPrompt: 'You are the IELTS paragraph analyst. Return strict JSON and no hidden reasoning.',
      userPrompt: composeParagraphStagePrompt({
        questionText: input.questionText,
        essay: input.essay,
        paragraphIndexes: batch.targetIndexes,
        globalAnalysis: global.output,
        evidence: evidenceFor(input.ragPlan, 'PARAGRAPH', batch.targetIndexes),
      }),
      fallbackOutput: fallbackParagraphBatch(input.essay, batch.targetIndexes),
      validate: value => validateParagraphBatch(value, batch.targetIndexes),
    })
    paragraphAnalyses.push(...result.output.paragraphs)
    totalInputTokens += result.inputTokens
    totalOutputTokens += result.outputTokens
  }

  const sentenceBatches: SentenceBatchAnalysisOutput[] = []
  for (const batch of plan.sentenceBatches) {
    const paragraphIndexes = new Set(input.essay.sentences
      .filter(sentence => batch.targetIndexes.includes(sentence.index))
      .map(sentence => sentence.paragraphIndex))
    const relevantParagraphs = paragraphAnalyses.filter(paragraph => paragraphIndexes.has(paragraph.paragraphIndex))
    const result = await executeStage({
      ...input,
      stage: AiReviewStage.SENTENCE_ANALYSIS,
      targetIndex: batch.targetIndexes[0] || null,
      systemPrompt: 'You are the IELTS language and local-logic analyst. Return strict JSON and no hidden reasoning.',
      userPrompt: composeSentenceStagePrompt({
        essay: input.essay,
        sentenceIndexes: batch.targetIndexes,
        globalAnalysis: global.output,
        paragraphAnalyses: relevantParagraphs,
        evidence: evidenceFor(input.ragPlan, 'SENTENCE', batch.targetIndexes),
      }),
      fallbackOutput: fallbackSentenceBatch(input.essay, batch.targetIndexes),
      validate: value => validateSentenceBatch(value, batch.targetIndexes, input.essay),
    })
    sentenceBatches.push(result.output)
    totalInputTokens += result.inputTokens
    totalOutputTokens += result.outputTokens
  }

  const draft = mergeDraft(global.output, paragraphAnalyses, sentenceBatches, input.essay)
  const identity = resolveModelProvider()
  await prisma.aiReviewStageResult.create({
    data: {
      jobId: input.jobId,
      stage: AiReviewStage.MERGE,
      provider: identity.providerName,
      model: identity.model,
      promptVersion: STAGE_PROMPT_VERSION,
      inputJson: {
        paragraphStageCount: plan.paragraphBatches.length,
        sentenceStageCount: plan.sentenceBatches.length,
      },
      outputJson: draft as unknown as Prisma.InputJsonValue,
      validationStatus: AiStageValidationStatus.VALID,
    },
  })
  const verification = await executeStage({
    ...input,
    stage: AiReviewStage.VERIFICATION,
    targetIndex: null,
    systemPrompt: 'You verify IELTS feedback. Return only correction decisions as strict JSON.',
    userPrompt: composeVerifierStagePrompt({ essay: input.essay, draft }),
    fallbackOutput: fallbackVerification(),
    validate: value => validateVerification(value, draft.sentenceAnnotations.length, input.essay),
  })
  let output = applyVerification(draft, verification.output)
  totalInputTokens += verification.inputTokens
  totalOutputTokens += verification.outputTokens
  if (
    !verification.output.accepted
    || verification.output.repairInstructions.length > 0
    || verification.output.contradictoryFindings.length > 0
    || verification.output.revisionProblems.length > 0
  ) {
    const repair = await executeStage({
      ...input,
      stage: AiReviewStage.REPAIR,
      targetIndex: null,
      systemPrompt: 'You repair verified IELTS feedback. Return strict JSON and no hidden reasoning.',
      userPrompt: composeRepairStagePrompt({ essay: input.essay, draft: output, verification: verification.output }),
      fallbackOutput: output,
      fallbackOnFailure: true,
      validate: value => validateRepairOutput(value, input.essay, output),
    })
    output = repair.output
    totalInputTokens += repair.inputTokens
    totalOutputTokens += repair.outputTokens
  }

  return {
    provider: identity.providerName,
    model: identity.model,
    output,
    rawOutput: {
      pipelineVersion: STAGE_PROMPT_VERSION,
      global: global.output,
      paragraphs: paragraphAnalyses,
      sentenceBatchCount: sentenceBatches.length,
      verification: verification.output,
    },
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    latencyMs: Date.now() - started,
  }
}

async function executeStage<T>(input: {
  userId: number
  jobId: number
  stage: AiReviewStage
  targetIndex: number | null
  systemPrompt: string
  userPrompt: string
  fallbackOutput: T
  validate: (value: unknown) => T
  maxOutputTokens?: number
  fallbackOnFailure?: boolean
}) {
  const identity = resolveModelProvider()
  let userPrompt = input.userPrompt
  let finalError: unknown = new Error('AI stage failed')
  let totalInputTokens = 0
  let totalOutputTokens = 0
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let result: AiProviderResult<T> | null = null
    try {
      result = await generateStructuredWithProvider({
        systemPrompt: input.systemPrompt,
        userPrompt,
        fallbackOutput: input.fallbackOutput,
        temperature: 0.15,
        maxOutputTokens: input.maxOutputTokens,
      })
      totalInputTokens += result.inputTokens || 0
      totalOutputTokens += result.outputTokens || 0
      const output = input.validate(result.output)
      await prisma.$transaction([
        prisma.aiModelCall.create({ data: {
          userId: input.userId,
          jobId: input.jobId,
          callType: input.stage === AiReviewStage.VERIFICATION ? AiModelCallType.CLASSIFY : AiModelCallType.REVIEW,
          provider: result.provider,
          model: result.model,
          promptVersion: STAGE_PROMPT_VERSION,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          latencyMs: result.latencyMs,
          status: AiModelCallStatus.SUCCESS,
        } }),
        prisma.aiReviewStageResult.create({ data: {
          jobId: input.jobId,
          stage: input.stage,
          targetIndex: input.targetIndex,
          attempt,
          provider: result.provider,
          model: result.model,
          promptVersion: STAGE_PROMPT_VERSION,
          inputJson: { targetIndex: input.targetIndex },
          outputJson: output as unknown as Prisma.InputJsonValue,
          validationStatus: AiStageValidationStatus.VALID,
        } }),
      ])
      return {
        output,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      }
    } catch (error) {
      finalError = error
      const message = error instanceof Error ? error.message : 'AI stage failed'
      await prisma.$transaction([
        prisma.aiModelCall.create({ data: {
          userId: input.userId,
          jobId: input.jobId,
          callType: input.stage === AiReviewStage.VERIFICATION ? AiModelCallType.CLASSIFY : AiModelCallType.REVIEW,
          provider: result?.provider || identity.providerName,
          model: result?.model || identity.model,
          promptVersion: STAGE_PROMPT_VERSION,
          inputTokens: result?.inputTokens,
          outputTokens: result?.outputTokens,
          latencyMs: result?.latencyMs,
          status: AiModelCallStatus.FAILED,
          errorMessage: message,
        } }),
        prisma.aiReviewStageResult.create({ data: {
          jobId: input.jobId,
          stage: input.stage,
          targetIndex: input.targetIndex,
          attempt,
          provider: result?.provider || identity.providerName,
          model: result?.model || identity.model,
          promptVersion: STAGE_PROMPT_VERSION,
          inputJson: { targetIndex: input.targetIndex },
          outputJson: result?.output as unknown as Prisma.InputJsonValue | undefined,
          validationStatus: AiStageValidationStatus.FAILED,
          errorMessage: message,
        } }),
      ])
      if (attempt < 2) {
        userPrompt = `${input.userPrompt}\n\nYour previous response failed validation: ${message}. Return a corrected complete JSON object and obey the allowed indexes and enums exactly.`
      }
    }
  }
  if (input.fallbackOnFailure) {
    return { output: input.fallbackOutput, inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
  }
  throw finalError
}

function evidenceFor(plan: RagRetrievalPlan, stage: 'GLOBAL' | 'PARAGRAPH' | 'SENTENCE', indexes: number[]) {
  const allowedChunkIds = new Set(plan.promptChunks.map(chunk => chunk.id))
  const chunks = plan.groups
    .filter(group => group.stage === stage && (!indexes.length || (group.targetIndex != null && indexes.includes(group.targetIndex))))
    .flatMap(group => group.chunks)
    .filter(chunk => allowedChunkIds.has(chunk.id))
  const unique = new Map<number, RagChunk>()
  for (const chunk of chunks) unique.set(chunk.id, chunk)
  return Array.from(unique.values()).slice(0, stage === 'GLOBAL' ? 16 : 24)
}

function mergeDraft(
  global: GlobalAnalysisOutput,
  paragraphs: ParagraphAnalysisOutput[],
  batches: SentenceBatchAnalysisOutput[],
  essay: PreprocessedEssay,
): ReviewOutput {
  const paragraphFindings = paragraphs.flatMap(paragraph => paragraph.findings.map(finding => ({
    category: finding.category,
    severity: finding.severity,
    title: `第 ${paragraph.paragraphIndex} 段`,
    explanation: finding.explanation,
    suggestion: finding.suggestion,
  })))
  const paragraphRewrites = paragraphs.flatMap(paragraph => {
    const source = essay.paragraphs.find(item => item.index === paragraph.paragraphIndex)
    if (!source || !paragraph.revisedParagraph || paragraph.revisedParagraph === source.text) return []
    return [{
      paragraphIndex: paragraph.paragraphIndex,
      sentenceIndex: null,
      level: AiAnnotationLevel.PARAGRAPH,
      operation: AiRevisionOperation.REPLACE,
      anchorText: source.text,
      occurrence: 1,
      originalText: source.text,
      rewrittenText: paragraph.revisedParagraph,
      reason: '根据段落功能、展开和衔接分析进行整体改写。',
    }]
  })
  return {
    overallBand: null,
    summary: global.summary,
    priorityAdvice: global.priorityAdvice,
    scores: [],
    globalFindings: [...global.priorityProblems.map(problem => ({
      category: problem.category,
      severity: problem.severity,
      title: categoryTitle(problem.category),
      explanation: problem.explanation,
      suggestion: problem.suggestion,
    })), ...paragraphFindings],
    sentenceAnnotations: batches.flatMap(batch => batch.annotations),
    rewrites: [...paragraphRewrites, ...batches.flatMap(batch => batch.rewrites)],
  }
}

function applyVerification(draft: ReviewOutput, verification: VerificationOutput): ReviewOutput {
  const rejected = new Set(verification.rejectedAnnotationIndexes)
  const duplicateRemovals = new Set(verification.duplicateAnnotationGroups.flatMap(group => group.slice(1)))
  return {
    ...draft,
    sentenceAnnotations: [
      ...draft.sentenceAnnotations.filter((_, index) => !rejected.has(index) && !duplicateRemovals.has(index)),
      ...verification.missedIssues,
    ],
  }
}

function fallbackGlobal(essay: PreprocessedEssay): GlobalAnalysisOutput {
  return {
    summary: '本地多阶段流程已执行。当前结果只验证全局、段落、句子、验证与合并链路。',
    priorityAdvice: '接入模型后再评估真实批改质量。',
    taskFulfilment: '未调用真实模型。',
    positionAndThesis: '未调用真实模型。',
    organization: `检测到${essay.paragraphs.length}个段落。`,
    argumentDevelopment: '未调用真实模型。',
    strengths: [],
    priorityProblems: [{
      category: AiFindingCategory.TASK_RESPONSE,
      severity: AiIssueSeverity.MEDIUM,
      explanation: 'Fallback不执行真实任务回应判断。',
      suggestion: '配置模型API后重新测试。',
    }],
    paragraphRoles: essay.paragraphs.map(paragraph => ({
      paragraphIndex: paragraph.index,
      intendedRole: '等待模型判断',
      effectiveness: '未分析',
    })),
  }
}

function fallbackParagraphBatch(essay: PreprocessedEssay, indexes: number[]): ParagraphBatchAnalysisOutput {
  return { paragraphs: essay.paragraphs.filter(paragraph => indexes.includes(paragraph.index)).map(paragraph => ({
    paragraphIndex: paragraph.index,
    function: '等待模型判断',
    topicSentence: '未分析',
    development: '未分析',
    cohesion: '未分析',
    relationToQuestion: '未分析',
    findings: [],
    revisedParagraph: null,
  })) }
}

function fallbackSentenceBatch(essay: PreprocessedEssay, indexes: number[]): SentenceBatchAnalysisOutput {
  const sentence = essay.sentences.find(candidate => indexes.includes(candidate.index))
  if (!sentence) return { sentenceIndexes: indexes, annotations: [], rewrites: [] }
  const anchorText = sentence.text.split(/\s+/).slice(0, 2).join(' ')
  return {
    sentenceIndexes: indexes,
    annotations: [{
      paragraphIndex: sentence.paragraphIndex,
      sentenceIndex: sentence.index,
      level: AiAnnotationLevel.PHRASE,
      originalText: sentence.text,
      anchorText,
      occurrence: 1,
      locationStatus: AiAnnotationLocationStatus.PENDING,
      issueType: AiIssueType.STYLE,
      severity: AiIssueSeverity.LOW,
      explanation: 'Fallback占位批注，用于验证批次合并和文本定位。',
      suggestion: '真实模型接入后替换。',
      replacementText: null,
      rubricDimension: AiReviewScoreDimension.LEXICAL_RESOURCE,
    }],
    rewrites: [{
      paragraphIndex: sentence.paragraphIndex,
      sentenceIndex: sentence.index,
      level: AiAnnotationLevel.SENTENCE,
      operation: AiRevisionOperation.REPLACE,
      anchorText: sentence.text,
      occurrence: 1,
      originalText: sentence.text,
      rewrittenText: sentence.text,
      reason: 'Fallback占位改写。',
    }],
  }
}

function fallbackVerification(): VerificationOutput {
  return {
    accepted: true,
    missedIssues: [],
    rejectedAnnotationIndexes: [],
    duplicateAnnotationGroups: [],
    contradictoryFindings: [],
    revisionProblems: [],
    repairInstructions: [],
  }
}

function validateGlobal(value: unknown): GlobalAnalysisOutput {
  const data = objectValue(value, 'global analysis')
  return {
    summary: stringValue(data.summary, 'summary'),
    priorityAdvice: stringValue(data.priorityAdvice, 'priorityAdvice'),
    taskFulfilment: stringValue(data.taskFulfilment, 'taskFulfilment'),
    positionAndThesis: stringValue(data.positionAndThesis, 'positionAndThesis'),
    organization: stringValue(data.organization, 'organization'),
    argumentDevelopment: stringValue(data.argumentDevelopment, 'argumentDevelopment'),
    strengths: stringArray(data.strengths),
    priorityProblems: arrayValue(data.priorityProblems).map(item => ({
      category: findingCategoryValue(item.category, 'category'),
      severity: enumValue(item.severity, Object.values(AiIssueSeverity), 'severity') as AiIssueSeverity,
      explanation: stringValue(item.explanation, 'explanation'),
      suggestion: optionalString(item.suggestion),
    })),
    paragraphRoles: arrayValue(data.paragraphRoles).map(item => ({
      paragraphIndex: positiveInteger(item.paragraphIndex, 'paragraphIndex'),
      intendedRole: stringValue(item.intendedRole, 'intendedRole'),
      effectiveness: stringValue(item.effectiveness, 'effectiveness'),
    })),
  }
}

function validateParagraphBatch(value: unknown, expectedIndexes: number[]): ParagraphBatchAnalysisOutput {
  const data = objectValue(value, 'paragraph analysis')
  return { paragraphs: arrayValue(data.paragraphs).map(item => {
    const paragraphIndex = positiveInteger(item.paragraphIndex, 'paragraphIndex')
    if (!expectedIndexes.includes(paragraphIndex)) throw new Error(`Unexpected paragraphIndex ${paragraphIndex}`)
    return {
      paragraphIndex,
      function: stringValue(item.function, 'function'),
      topicSentence: stringValue(item.topicSentence, 'topicSentence'),
      development: stringValue(item.development, 'development'),
      cohesion: stringValue(item.cohesion, 'cohesion'),
      relationToQuestion: stringValue(item.relationToQuestion, 'relationToQuestion'),
      findings: arrayValue(item.findings).map(finding => ({
        category: findingCategoryValue(finding.category, 'category'),
        severity: enumValue(finding.severity, Object.values(AiIssueSeverity), 'severity') as AiIssueSeverity,
        explanation: stringValue(finding.explanation, 'explanation'),
        suggestion: optionalString(finding.suggestion),
      })),
      revisedParagraph: optionalString(item.revisedParagraph),
    }
  }) }
}

function validateSentenceBatch(
  value: unknown,
  expectedIndexes: number[],
  essay: PreprocessedEssay,
): SentenceBatchAnalysisOutput {
  const data = objectValue(value, 'sentence analysis')
  const output = data as unknown as SentenceBatchAnalysisOutput
  if (!Array.isArray(output.annotations) || !Array.isArray(output.rewrites)) throw new Error('Sentence stage arrays are required')
  for (const annotation of output.annotations) {
    if (annotation.sentenceIndex == null || !expectedIndexes.includes(Number(annotation.sentenceIndex))) {
      throw new Error(`Unexpected sentenceIndex ${annotation.sentenceIndex}`)
    }
    annotation.level = enumValue(annotation.level || 'SENTENCE', Object.values(AiAnnotationLevel), 'level') as AiAnnotationLevel
    annotation.locationStatus = AiAnnotationLocationStatus.PENDING
  }
  for (const rewrite of output.rewrites) {
    if (rewrite.sentenceIndex != null && !expectedIndexes.includes(Number(rewrite.sentenceIndex))) {
      throw new Error(`Unexpected rewrite sentenceIndex ${rewrite.sentenceIndex}`)
    }
    rewrite.level = enumValue(rewrite.level || 'SENTENCE', Object.values(AiAnnotationLevel), 'level') as AiAnnotationLevel
    rewrite.operation = enumValue(rewrite.operation || 'REPLACE', Object.values(AiRevisionOperation), 'operation') as AiRevisionOperation
  }
  const validated = validateReviewOutput({
    overallBand: null,
    summary: 'Sentence-stage validation',
    scores: [],
    globalFindings: [],
    sentenceAnnotations: output.annotations,
    rewrites: output.rewrites,
  }, essay)
  return {
    sentenceIndexes: expectedIndexes,
    annotations: validated.sentenceAnnotations,
    rewrites: validated.rewrites,
  }
}

export function validateVerification(
  value: unknown,
  annotationCount: number,
  essay?: PreprocessedEssay,
): VerificationOutput {
  const data = objectValue(value, 'verification')
  if (typeof data.accepted !== 'boolean') throw new Error('accepted must be a boolean')
  const rejectedAnnotationIndexes = boundedIndexArray(data.rejectedAnnotationIndexes, annotationCount, 'rejectedAnnotationIndexes')
  const duplicateAnnotationGroups = arrayValue(data.duplicateAnnotationGroups)
    .map((group, index) => boundedIndexArray(group, annotationCount, `duplicateAnnotationGroups[${index}]`))
  const missedIssues = Array.isArray(data.missedIssues) ? data.missedIssues : []
  const validatedMissedIssues = essay
    ? validateReviewOutput({
        overallBand: null,
        summary: 'Verifier-stage validation',
        scores: [],
        globalFindings: [],
        sentenceAnnotations: missedIssues,
        rewrites: [],
      }, essay).sentenceAnnotations
    : missedIssues
  return {
    accepted: data.accepted,
    missedIssues: validatedMissedIssues,
    rejectedAnnotationIndexes,
    duplicateAnnotationGroups,
    contradictoryFindings: stringArray(data.contradictoryFindings),
    revisionProblems: stringArray(data.revisionProblems),
    repairInstructions: stringArray(data.repairInstructions),
  }
}

export function validateRepairOutput(
  value: unknown,
  essay: PreprocessedEssay,
  verifiedDraft: ReviewOutput,
): ReviewOutput {
  const candidate = validateReviewOutput(value, essay)
  const unresolvedAnnotationCount = candidate.sentenceAnnotations.filter(
    annotation => annotation.locationStatus !== AiAnnotationLocationStatus.RESOLVED,
  ).length
  if (unresolvedAnnotationCount > 0) {
    throw new Error(`Repair output contains ${unresolvedAnnotationCount} unresolved annotations`)
  }

  const unresolvedRewriteCount = candidate.rewrites.filter(
    rewrite => rewrite.startOffset == null || rewrite.endOffset == null,
  ).length
  if (unresolvedRewriteCount > 0) {
    throw new Error(`Repair output contains ${unresolvedRewriteCount} unresolved rewrites`)
  }

  const baselineCount = verifiedDraft.sentenceAnnotations.filter(
    annotation => annotation.locationStatus === AiAnnotationLocationStatus.RESOLVED,
  ).length
  const minimumRetained = baselineCount === 0 ? 0 : Math.max(1, Math.ceil(baselineCount * 0.6))
  if (candidate.sentenceAnnotations.length < minimumRetained) {
    throw new Error(
      `Repair output retained only ${candidate.sentenceAnnotations.length}/${baselineCount} verified annotations; minimum is ${minimumRetained}`,
    )
  }

  return candidate
}

function categoryTitle(category: AiFindingCategory) {
  const labels: Record<AiFindingCategory, string> = {
    TASK_RESPONSE: '任务回应', STRUCTURE: '文章结构', LOGIC: '论证逻辑', LANGUAGE: '语言表达',
    VOCABULARY: '词汇使用', GRAMMAR: '语法准确性',
  }
  return labels[category]
}

function objectValue(value: unknown, path: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value as Record<string, any>
}
function arrayValue(value: unknown): any[] { return Array.isArray(value) ? value : [] }
function stringArray(value: unknown) { return arrayValue(value).filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean) }
function integerArray(value: unknown) { return arrayValue(value).map(Number).filter(Number.isInteger) }
function boundedIndexArray(value: unknown, upperBound: number, path: string) {
  const indexes = integerArray(value)
  if (indexes.some(index => index < 0 || index >= upperBound)) throw new Error(`${path} contains an out-of-range index`)
  return indexes
}
function stringValue(value: unknown, path: string) { if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} is required`); return value.trim() }
function optionalString(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : null }
function positiveInteger(value: unknown, path: string) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${path} is invalid`); return parsed }
function enumValue(value: unknown, allowed: readonly string[], path: string) { if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${path} is invalid`); return value }
function findingCategoryValue(value: unknown, path: string): AiFindingCategory {
  if (typeof value !== 'string') throw new Error(`${path} is invalid`)
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_')
  const aliases: Record<string, AiFindingCategory> = {
    TASK_ACHIEVEMENT: AiFindingCategory.TASK_RESPONSE,
    COHERENCE_COHESION: AiFindingCategory.STRUCTURE,
    COHERENCE_AND_COHESION: AiFindingCategory.STRUCTURE,
    LEXICAL_RESOURCE: AiFindingCategory.VOCABULARY,
    GRAMMATICAL_RANGE_ACCURACY: AiFindingCategory.GRAMMAR,
    GRAMMAR_RANGE_ACCURACY: AiFindingCategory.GRAMMAR,
  }
  const candidate = aliases[normalized] || normalized
  if (!Object.values(AiFindingCategory).includes(candidate as AiFindingCategory)) {
    throw new Error(`${path} is invalid: ${value}`)
  }
  return candidate as AiFindingCategory
}
