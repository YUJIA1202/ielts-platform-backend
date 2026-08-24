import 'dotenv/config'
import {
  PracticeDifficulty,
  PracticeItemStatus,
  PracticeItemType,
  PracticeTab,
  Prisma,
} from '@prisma/client'
import prisma from '../src/prisma'
import { generateStructuredWithProvider } from '../src/services/ai/providers'

type ChainAssembly = {
  valid: boolean
  steps: string[]
  missingIndex: number
  judgeFunction: string
  title: string
}

type BreakAssembly = {
  valid: boolean
  problemIndex: number
  issueType: string
  independentExplanation: string
  judgeCriterion: string
}

type ExpansionSelection = {
  valid: boolean
  candidateIndex: number
  reason: string
}

function argument(name: string) {
  const prefix = `${name}=`
  return process.argv.slice(2).find(value => value.startsWith(prefix))?.slice(prefix.length) || null
}

function hasFlag(name: string) {
  return process.argv.slice(2).includes(name)
}

function contentSection(raw: string) {
  const match = raw.match(/\[内容[^\]]*\]\s*\n([\s\S]*?)(?=\n\[[^\]]+\]|$)/)
  return (match?.[1] || raw).trim()
}

function normalize(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function cleanEnglishExpansion(value: string) {
  return value
    .replace(/\r/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(part => part.trim())
    .filter(part => part && !/[\u3400-\u9fff]/.test(part) && (part.match(/[A-Za-z]+/g)?.length || 0) >= 5)
    .join(' ')
    .trim()
}

function isArgumentExpansion(rawFeedback: string) {
  const type = rawFeedback.match(/\[类型\]\s*\n([^\n]+)/)?.[1] || ''
  return /段级Expansion|论证Expansion|全文Expansion/i.test(type)
}

async function selectExpansion(teachingNote: string, candidates: Array<{ content: string; type: string }>) {
  const fallback: ExpansionSelection = { valid: false, candidateIndex: -1, reason: 'model selection unavailable' }
  if (!candidates.length) return fallback
  try {
    const result = await generateStructuredWithProvider({
      systemPrompt: '你是IELTS论证资料配对校验器。必须按语义对应关系配对Teaching note与英文段级/论证Expansion，不能按表格行号猜测，不能选择仅讲语法或词汇的材料。返回严格JSON。',
      userPrompt: `Teaching note：${teachingNote}\n候选英文展开：${JSON.stringify(candidates.map((candidate, index) => ({ candidateIndex: index, type: candidate.type, content: candidate.content })))}\n\n只有当英文展开完整体现同一论点、机制或论证链时才valid=true。返回 {"valid":true,"candidateIndex":0,"reason":"语义对应依据"}；没有可靠对应项则valid=false。`,
      fallbackOutput: fallback,
      temperature: 0,
      maxOutputTokens: 1200,
      thinkingMode: 'enabled',
      reasoningEffort: 'high',
    })
    const output = result.output as ExpansionSelection
    if (!output.valid || !Number.isInteger(output.candidateIndex) || output.candidateIndex < 0 || output.candidateIndex >= candidates.length) return fallback
    return output
  } catch {
    return fallback
  }
}

function statusArgument() {
  const value = (argument('--status') || 'draft').toLowerCase()
  if (value === 'live') return PracticeItemStatus.LIVE
  if (value === 'validated') return PracticeItemStatus.VALIDATED
  if (value === 'draft') return PracticeItemStatus.DRAFT
  throw new Error('--status must be draft, validated, or live')
}

async function assembleChain(teachingNote: string, englishExpansion: string): Promise<ChainAssembly | null> {
  const fallback: ChainAssembly = { valid: false, steps: [], missingIndex: -1, judgeFunction: '', title: '' }
  try {
    const result = await generateStructuredWithProvider({
      systemPrompt: '你是IELTS论证链练习校验器。只能重组给定Teaching note与Expansion中的信息，不能增加新事实或新论点。返回严格JSON。',
      userPrompt: `Teaching note：${teachingNote}\n配对的英文 Expansion：${englishExpansion}\n\n先确认二者讲的是同一论点和同一论证机制；不一致时valid=false。然后将中文思路整理成3到5个前后相连的逻辑环节。missingIndex必须是中间环节，不能是首环或末环。若素材不是完整逻辑链，valid=false。返回 {"valid":true,"title":"短标题","steps":["环节1","环节2","环节3"],"missingIndex":1,"judgeFunction":"缺失环节在链中必须完成的连接功能"}`,
      fallbackOutput: fallback,
      temperature: 0,
      maxOutputTokens: 2200,
      thinkingMode: 'disabled',
      reasoningEffort: 'medium',
    })
    const output = result.output as ChainAssembly
    if (!output.valid || !Array.isArray(output.steps) || output.steps.length < 3 || output.steps.length > 5) return null
    if (!Number.isInteger(output.missingIndex) || output.missingIndex <= 0 || output.missingIndex >= output.steps.length - 1) return null
    if (output.steps.some(step => !normalize(String(step)))) return null
    return { ...output, steps: output.steps.map(step => normalize(String(step))) }
  } catch {
    return null
  }
}

async function assembleBreak(sentences: string[], teacherFeedback: string): Promise<BreakAssembly | null> {
  const fallback: BreakAssembly = { valid: false, problemIndex: -1, issueType: '', independentExplanation: '', judgeCriterion: '' }
  try {
    const result = await generateStructuredWithProvider({
      systemPrompt: '你是IELTS段落逻辑练习校验器。只能依据给定真实段落与教师TR/CC评价定位问题，不得发明问题。返回严格JSON。',
      userPrompt: `段内句子（局部编号从1开始）：${JSON.stringify(sentences.map((text, index) => ({ index: index + 1, text })))}\n教师评价：${teacherFeedback}\n\n找出最核心的一处断链、相撞、偏离或裁决缺失。评价若没有可唯一定位的核心问题则valid=false。independentExplanation必须改写成可独立阅读的解析，不出现“见表”“Expansion”“上文批注”等内部引用。返回 {"valid":true,"problemIndex":2,"issueType":"断链/相撞/偏题/裁决缺失之一","independentExplanation":"...","judgeCriterion":"学生说明中必须指出的逻辑核心"}`,
      fallbackOutput: fallback,
      temperature: 0,
      maxOutputTokens: 2400,
      thinkingMode: 'disabled',
      reasoningEffort: 'medium',
    })
    const output = result.output as BreakAssembly
    if (!output.valid || !Number.isInteger(output.problemIndex) || output.problemIndex < 1 || output.problemIndex > sentences.length) return null
    if (!normalize(output.independentExplanation || '') || !normalize(output.judgeCriterion || '')) return null
    if (/Expansion|见表|批注表|工作簿/i.test(output.independentExplanation)) return null
    return output
  } catch {
    return null
  }
}

function commonData(input: {
  topic: string | null
  subtype: string | null
  issueTypes: string[]
  materials: Prisma.InputJsonValue
  answerKey: Prisma.InputJsonValue
  judgePoints: Prisma.InputJsonValue
  explanation: string
  sourceRefs: Prisma.InputJsonValue
  status: PracticeItemStatus
}) {
  return {
    tab: PracticeTab.THINKING,
    topic: input.topic,
    questionSubtype: input.subtype,
    issueTypes: input.issueTypes as Prisma.InputJsonValue,
    difficulty: PracticeDifficulty.CORE,
    materials: input.materials,
    answerKey: input.answerKey,
    judgePoints: input.judgePoints,
    explanation: input.explanation,
    sourceRefs: input.sourceRefs,
    status: input.status,
    stats: { attempts: 0, correct: 0, partial: 0, wrong: 0, correctRate: 0, optionDistribution: {}, appealCount: 0 } as Prisma.InputJsonValue,
    changelog: [{ at: new Date().toISOString(), action: 'generated', source: 'teaching_and_teacher_context', modelValidated: true }] as Prisma.InputJsonValue,
  }
}

async function main() {
  const limit = Math.max(2, Number(argument('--limit') || 20))
  const finalStatus = statusArgument()
  const topicFilter = argument('--topic')
  const perType = Math.ceil(limit / 2)
  let chains = 0
  let breaks = 0
  let discarded = 0

  if (hasFlag('--replace')) {
    await prisma.practiceItem.updateMany({
      where: { id: { startsWith: 'practice-chain-' }, tab: PracticeTab.THINKING },
      data: { status: PracticeItemStatus.RETIRED },
    })
  }

  const notes = await prisma.knowledgeAssessment.findMany({
    where: {
      kind: 'TEACHING_NOTE',
      document: {
        allowedForRag: true,
        ...(topicFilter ? { OR: [{ topic: { contains: topicFilter } }, { question: { topicCategory: { contains: topicFilter } } }] } : {}),
      },
    },
    include: {
      document: { include: { question: { select: { topicCategory: true, subtype: true } } } },
    },
    orderBy: [{ documentId: 'asc' }, { sourceRow: 'asc' }],
    take: perType * 12,
  })
  const documentIds = Array.from(new Set(notes.map(note => note.documentId)))
  const expansions = await prisma.knowledgeAssessment.findMany({
    where: { kind: 'EXPANSION', documentId: { in: documentIds } },
    orderBy: [{ documentId: 'asc' }, { sourceRow: 'asc' }],
  })

  for (const note of notes) {
    if (chains >= perType) break
    const teaching = contentSection(note.rawFeedback)
    if (teaching.length < 35 || /语法知识点|表达Expansion|开头精简/.test(note.rawFeedback)) continue
    const candidates = expansions
      .filter(expansion => expansion.documentId === note.documentId && isArgumentExpansion(expansion.rawFeedback))
      .map(expansion => ({
        expansion,
        type: expansion.rawFeedback.match(/\[类型\]\s*\n([^\n]+)/)?.[1] || 'argument expansion',
        content: cleanEnglishExpansion(contentSection(expansion.rawFeedback)),
      }))
      .filter(candidate => candidate.content.length > 0)
    const selection = await selectExpansion(teaching, candidates.map(candidate => ({ content: candidate.content, type: candidate.type })))
    const pairedCandidate = selection.valid ? candidates[selection.candidateIndex] : null
    const paired = pairedCandidate?.expansion
    if (!paired) continue
    const english = pairedCandidate.content
    if (!/[A-Za-z]{12}/.test(english)) continue
    const assembly = await assembleChain(teaching, english)
    if (!assembly) {
      discarded += 1
      continue
    }
    const displaySteps = assembly.steps.map((step, index) => index === assembly.missingIndex ? '____' : step)
    const topic = note.document.question?.topicCategory || note.document.topic
    const subtype = note.document.question?.subtype || note.document.subtype
    const data = commonData({
      topic,
      subtype,
      issueTypes: ['LOGIC', 'CHAIN_COMPLETION'],
      materials: { displayChain: displaySteps, sourceLabel: '教师论证思路' },
      answerKey: { referenceAnswer: assembly.steps[assembly.missingIndex], fullChain: assembly.steps, englishExpansion: english },
      judgePoints: { issueType: 'CHAIN_COMPLETION', criterion: assembly.judgeFunction },
      explanation: `完整逻辑链：${assembly.steps.join(' → ')}\n\n英文展开：${english}`,
      sourceRefs: [
        { documentId: note.documentId, assessmentId: note.id, sourceRow: note.sourceRow, role: 'TEACHING_NOTE' },
        { documentId: paired.documentId, assessmentId: paired.id, sourceRow: paired.sourceRow, role: 'EXPANSION' },
      ],
      status: finalStatus,
    })
    const id = `practice-chain-${note.id}-${paired.id}`
    await prisma.practiceItem.upsert({
      where: { id },
      create: { id, itemType: PracticeItemType.CHAIN_CLOZE, stem: '补全论证链中缺失的中间环节。', ...data },
      update: { stem: '补全论证链中缺失的中间环节。', ...data },
    })
    chains += 1
  }

  const paragraphAssessments = await prisma.knowledgeAssessment.findMany({
    where: {
      kind: 'ASSESSMENT',
      scope: 'PARAGRAPH',
      dimension: { in: ['TR', 'CC'] },
      primaryUnitId: { not: null },
      rawFeedback: { not: '' },
      document: {
        allowedForRag: true,
        ...(topicFilter ? { OR: [{ topic: { contains: topicFilter } }, { question: { topicCategory: { contains: topicFilter } } }] } : {}),
      },
    },
    include: {
      document: { include: { question: { select: { topicCategory: true, subtype: true } } } },
      primaryUnit: { include: { children: { orderBy: { ordinal: 'asc' } } } },
    },
    orderBy: { id: 'asc' },
    take: perType * 10,
  })
  const usedParagraphs = new Set<number>()
  for (const assessment of paragraphAssessments) {
    if (breaks >= perType) break
    if (!assessment.primaryUnit || usedParagraphs.has(assessment.primaryUnit.id)) continue
    if (!/(不足|问题|断|相撞|偏离|缺少|不能|不成立|没有|冲突|裁决)/.test(assessment.rawFeedback)) continue
    const sentences = assessment.primaryUnit.children.map(child => normalize(child.text)).filter(Boolean)
    if (sentences.length < 2 || sentences.length > 10) continue
    const assembly = await assembleBreak(sentences, assessment.rawFeedback)
    if (!assembly) {
      discarded += 1
      continue
    }
    const topic = assessment.document.question?.topicCategory || assessment.document.topic
    const subtype = assessment.document.question?.subtype || assessment.document.subtype
    const data = commonData({
      topic,
      subtype,
      issueTypes: [assessment.dimension === 'TR' ? 'TASK_RESPONSE' : 'COHESION', assembly.issueType || 'LOGIC'],
      materials: { sentences: sentences.map((text, index) => ({ index: index + 1, text })), sourceLabel: '匿名真实问题段落' },
      answerKey: { sentenceIndex: assembly.problemIndex, referenceAnswer: assembly.independentExplanation },
      judgePoints: { issueType: assembly.issueType || 'LOGIC', criterion: assembly.judgeCriterion },
      explanation: assembly.independentExplanation,
      sourceRefs: [{
        documentId: assessment.documentId,
        assessmentId: assessment.id,
        paragraphRef: `P${(assessment.primaryUnit.paragraphIndex || 0) + 1}`,
        sourceRow: assessment.sourceRow,
        role: 'TEACHER_CONTEXT',
      }],
      status: finalStatus,
    })
    const id = `practice-break-${assessment.id}`
    await prisma.practiceItem.upsert({
      where: { id },
      create: { id, itemType: PracticeItemType.BREAK_LOCATE, stem: '本段论证在某处出现断裂、相撞或偏离。请选择问题句，并用一两句话说明原因。', ...data },
      update: { stem: '本段论证在某处出现断裂、相撞或偏离。请选择问题句，并用一两句话说明原因。', ...data },
    })
    usedParagraphs.add(assessment.primaryUnit.id)
    breaks += 1
  }

  console.log(JSON.stringify({ requested: limit, status: finalStatus, chains, breaks, discarded, total: chains + breaks }, null, 2))
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
