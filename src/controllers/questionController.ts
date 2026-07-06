import { Request, Response } from 'express'
import prisma from '../prisma'
import { uploadToCOS } from '../lib/cos'

function parseOptionalInt(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseOptionalDate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function appendKeywordSearch(where: any, keyword?: string) {
  if (!keyword) return
  const search = [
    { content: { contains: keyword } },
    { subtype: { contains: keyword } },
    { topic: { contains: keyword } },
    { topicCategory: { contains: keyword } },
    { topicSubcategory: { contains: keyword } },
    { source: { contains: keyword } },
  ]
  where.AND = [...(where.AND || []), { OR: search }]
}

export const getQuestions = async (req: Request, res: Response) => {
  const task = req.query.task as string | undefined
  const subtype = req.query.subtype as string | undefined
  const keyword = req.query.keyword as string | undefined
  const topic = req.query.topic as string | undefined
  const topicCategory = req.query.topicCategory as string | undefined
  const topicSubcategory = req.query.topicSubcategory as string | undefined
  const testMode = req.query.testMode as string | undefined
  const region = req.query.region as string | undefined
  const similarGroup = req.query.similarGroup as string | undefined
  const includeFacets = req.query.includeFacets === 'true'
  const page = (req.query.page as string) || '1'
  const limit = (req.query.limit as string) || '20'
  const year = req.query.year as string | undefined

  const where: any = {}
  if (year) where.year = parseInt(year)
  if (task) where.task = task
  if (subtype) where.subtype = subtype
  if (topic) where.OR = [{ topic }, { topicCategory: topic }]
  if (topicCategory) where.topicCategory = topicCategory
  if (topicSubcategory) where.topicSubcategory = { contains: topicSubcategory }
  if (testMode) where.testMode = testMode
  if (region) where.region = region
  if (similarGroup) where.similarGroup = similarGroup
  appendKeywordSearch(where, keyword)

  const total = await prisma.question.count({ where })
  const questions = await prisma.question.findMany({
    where,
    orderBy: [{ examDate: 'desc' }, { createdAt: 'desc' }],
    skip: (parseInt(page) - 1) * parseInt(limit),
    take: parseInt(limit),
  })

  let facets: any
  if (includeFacets) {
    const facetWhere: any = {}
    if (task) facetWhere.task = task
    const rows = await prisma.question.findMany({
      where: facetWhere,
      select: {
        subtype: true,
        topic: true,
        topicCategory: true,
        topicSubcategory: true,
        year: true,
        testMode: true,
        region: true,
      },
    })
    const unique = (values: Array<string | number | null>) =>
      [...new Set(values.filter((value): value is string | number => value !== null && value !== ''))]
        .sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'))
    const subTopics = rows.flatMap(row =>
      (row.topicSubcategory || '')
        .split(/[,，、]/)
        .map(item => item.trim())
        .filter(Boolean),
    )
    facets = {
      subtypes: unique(rows.map(row => row.subtype)),
      topics: unique(rows.map(row => row.topicCategory || row.topic)),
      topicSubcategories: unique(subTopics),
      years: unique(rows.map(row => row.year)).sort((a, b) => Number(b) - Number(a)),
      testModes: unique(rows.map(row => row.testMode)),
      regions: unique(rows.map(row => row.region)),
    }
  }

  res.json({ questions, total, page: parseInt(page), limit: parseInt(limit), ...(facets && { facets }) })
}

export const getQuestionById = async (req: Request, res: Response) => {
  const { id } = req.params
  const question = await prisma.question.findUnique({
    where: { id: parseInt(id as string) },
    include: { essays: true },
  })
  if (!question) {
    res.status(404).json({ error: '题目不存在' })
    return
  }
  res.json(question)
}

export const createQuestion = async (req: Request, res: Response) => {
  const {
    task, subtype, topic, topicCategory, topicSubcategory, content, outline, source,
    sourceKey, sourceRow, examDate, testMode, region, similarGroup, year, month,
  } = req.body
  if (!task || !content) {
    res.status(400).json({ error: '题型和题目内容不能为空' })
    return
  }

  let imageUrl: string | undefined
  if (req.file) {
    imageUrl = await uploadToCOS(req.file.buffer, req.file.originalname, 'questions')
  }

  const question = await prisma.question.create({
    data: {
      task,
      subtype,
      topic: topic || topicCategory,
      topicCategory: topicCategory || topic,
      topicSubcategory,
      content,
      outline,
      source,
      sourceKey,
      sourceRow: parseOptionalInt(sourceRow) ?? undefined,
      examDate: parseOptionalDate(examDate) ?? undefined,
      testMode,
      region,
      similarGroup,
      year: parseOptionalInt(year) ?? undefined,
      month: parseOptionalInt(month) ?? undefined,
      ...(imageUrl && { imageUrl }),
    },
  })
  res.json(question)
}

export const updateQuestion = async (req: Request, res: Response) => {
  const { id } = req.params
  const {
    task, subtype, topic, topicCategory, topicSubcategory, content, outline, source,
    sourceKey, sourceRow, examDate, testMode, region, similarGroup, year, month,
  } = req.body

  let imageUrl: string | undefined
  if (req.file) {
    imageUrl = await uploadToCOS(req.file.buffer, req.file.originalname, 'questions')
  }

  const data: any = {}
  if (task !== undefined) data.task = task
  if (subtype !== undefined) data.subtype = subtype
  if (topic !== undefined) data.topic = topic
  if (topicCategory !== undefined) data.topicCategory = topicCategory
  if (topicSubcategory !== undefined) data.topicSubcategory = topicSubcategory
  if (content !== undefined) data.content = content
  if (outline !== undefined) data.outline = outline
  if (source !== undefined) data.source = source
  if (sourceKey !== undefined) data.sourceKey = sourceKey || null
  if (sourceRow !== undefined) data.sourceRow = parseOptionalInt(sourceRow)
  if (examDate !== undefined) data.examDate = parseOptionalDate(examDate)
  if (testMode !== undefined) data.testMode = testMode || null
  if (region !== undefined) data.region = region || null
  if (similarGroup !== undefined) data.similarGroup = similarGroup || null
  if (year !== undefined) data.year = parseOptionalInt(year)
  if (month !== undefined) data.month = parseOptionalInt(month)
  if (imageUrl) data.imageUrl = imageUrl

  const question = await prisma.question.update({
    where: { id: parseInt(id as string) },
    data,
  })
  res.json(question)
}

export const deleteQuestion = async (req: Request, res: Response) => {
  const { id } = req.params
  await prisma.question.delete({ where: { id: parseInt(id as string) } })
  res.json({ message: '删除成功' })
}
