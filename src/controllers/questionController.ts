import { Request, Response } from 'express'
import prisma from '../prisma'

export const getQuestions = async (req: Request, res: Response) => {
  const task = req.query.task as string | undefined
  const subtype = req.query.subtype as string | undefined
  const keyword = req.query.keyword as string | undefined
  const topic = req.query.topic as string | undefined
  const page = (req.query.page as string) || '1'
  const limit = (req.query.limit as string) || '20'
  const year = req.query.year as string | undefined

  const where: any = {}
  if (year) where.year = parseInt(year)
  if (task) where.task = task
  if (subtype) where.subtype = subtype
  if (topic) where.topic = topic
  if (keyword) where.content = { contains: keyword }

  const total = await prisma.question.count({ where })
  const questions = await prisma.question.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (parseInt(page) - 1) * parseInt(limit),
    take: parseInt(limit),
  })

  res.json({ questions, total, page: parseInt(page), limit: parseInt(limit) })
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
  const { task, subtype, topic, content, outline, source, year, month } = req.body
  if (!task || !content) {
    res.status(400).json({ error: '题型和题目内容不能为空' })
    return
  }

  const file = req.file
  const imageUrl = file
    ? `${process.env.BASE_URL || 'http://localhost:4000'}/uploads/questions/${file.filename}`
    : undefined

  const question = await prisma.question.create({
    data: {
      task, subtype, topic, content, outline, source,
      year: year ? parseInt(year) : undefined,
      month: month ? parseInt(month) : undefined,
      ...(imageUrl && { imageUrl }),
    },
  })
  res.json(question)
}

export const updateQuestion = async (req: Request, res: Response) => {
  const { id } = req.params
  const { task, subtype, topic, content, outline, source, year, month } = req.body

  const file = req.file
  const imageUrl = file
    ? `${process.env.BASE_URL || 'http://localhost:4000'}/uploads/questions/${file.filename}`
    : undefined

  const data: any = {}
  if (task !== undefined) data.task = task
  if (subtype !== undefined) data.subtype = subtype
  if (topic !== undefined) data.topic = topic
  if (content !== undefined) data.content = content
  if (outline !== undefined) data.outline = outline
  if (source !== undefined) data.source = source
  if (year !== undefined) data.year = year ? parseInt(year) : null
  if (month !== undefined) data.month = month ? parseInt(month) : null
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