import { Request, Response } from 'express'
import prisma from '../prisma'
import { uploadToCOS } from '../lib/cos'

export const getEssays = async (req: Request, res: Response) => {
  try {
    const task = req.query.task as string | undefined
    const subtype = req.query.subtype as string | undefined
    const topic = req.query.topic as string | undefined
    const score = req.query.score as string | undefined
    const year = req.query.year as string | undefined
    const keyword = req.query.keyword as string | undefined
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 15

    const where: any = {}
    if (score) where.score = parseFloat(score)
    if (keyword) where.content = { contains: keyword }

    if (task || subtype || topic || year) {
      where.question = {}
      if (task) where.question.task = task
      if (subtype) where.question.subtype = subtype
      if (topic) where.question.topic = topic
      if (year) where.question.year = parseInt(year)
    }

    const total = await prisma.modelEssay.count({ where })
    const essays = await prisma.modelEssay.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        question: {
          select: { task: true, subtype: true, topic: true, content: true, year: true, month: true, source: true }
        }
      }
    })

    const result = essays.map(e => ({
      ...e,
      task: e.question.task,
      subtype: e.question.subtype,
      topic: e.question.topic,
      questionContent: e.question.content,
      year: e.question.year,
      month: e.question.month,
      source: e.question.source,
    }))

    res.json({ essays: result, total })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取范文列表失败' })
  }
}

export const getEssaysByQuestion = async (req: Request, res: Response) => {
  try {
    const { questionId } = req.params
    const essays = await prisma.modelEssay.findMany({
      where: { questionId: parseInt(questionId as string) },
      select: { id: true, questionId: true, score: true, createdAt: true },
    })
    res.json(essays)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取范文列表失败' })
  }
}

export const getEssayById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const userId = (req as any).userId
    const role = (req as any).role

    if (role !== 'ADMIN') {
      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user || user.subscription === 'FREE') {
        res.status(403).json({ error: '请升级订阅后查看范文' })
        return
      }
      const now = new Date()
      if (user.subExpiresAt && user.subExpiresAt < now) {
        res.status(403).json({ error: '订阅已过期，请续订' })
        return
      }
    }

    const essay = await prisma.modelEssay.findUnique({
      where: { id: parseInt(id as string) },
      include: {
        question: {
          select: { task: true, subtype: true, topic: true, content: true, year: true, month: true, source: true, imageUrl: true }
        }
      }
    })

    if (!essay) {
      res.status(404).json({ error: '范文不存在' })
      return
    }

    res.json({
      ...essay,
      task: essay.question.task,
      subtype: essay.question.subtype,
      topic: essay.question.topic,
      questionContent: essay.question.content,
      questionImageUrl: essay.question.imageUrl,
      year: essay.question.year,
      month: essay.question.month,
      source: essay.question.source,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取范文详情失败' })
  }
}

export const getAnnotatedPdf = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const userId = (req as any).userId

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user || user.subscription === 'FREE') {
      return res.status(403).json({ error: '请升级订阅后下载批注版 PDF' })
    }

    const essay = await prisma.modelEssay.findUnique({
      where: { id: parseInt(id as string) }
    })

    if (!essay) return res.status(404).json({ error: '范文不存在' })
    if (!essay.annotatedPdfUrl) return res.status(404).json({ error: '该范文暂无批注版 PDF' })

    // COS 上的文件直接重定向，不需要本地读取
    res.redirect(essay.annotatedPdfUrl)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '下载失败' })
  }
}

export const createEssay = async (req: Request, res: Response) => {
  try {
    const { questionId, content, score } = req.body
    if (!questionId || !content) {
      return res.status(400).json({ error: '题目和范文内容不能为空' })
    }

    let annotatedPdfUrl: string | undefined
    if (req.file) {
      annotatedPdfUrl = await uploadToCOS(req.file.buffer, req.file.originalname, 'essays')
    }

    const essay = await prisma.modelEssay.create({
      data: {
        questionId: parseInt(questionId),
        content,
        score: score ? parseFloat(score) : undefined,
        ...(annotatedPdfUrl && { annotatedPdfUrl }),
      },
    })
    res.json(essay)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '创建范文失败' })
  }
}

export const updateEssay = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { questionId, content, score } = req.body

    let annotatedPdfUrl: string | undefined
    if (req.file) {
      annotatedPdfUrl = await uploadToCOS(req.file.buffer, req.file.originalname, 'essays')
    }

    const data: any = {}
    if (questionId !== undefined) data.questionId = parseInt(questionId)
    if (content !== undefined) data.content = content
    if (score !== undefined) data.score = score ? parseFloat(score) : null
    if (annotatedPdfUrl) data.annotatedPdfUrl = annotatedPdfUrl

    const essay = await prisma.modelEssay.update({
      where: { id: parseInt(id as string) },
      data,
    })
    res.json(essay)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '更新范文失败' })
  }
}

export const deleteEssay = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    await prisma.modelEssay.delete({ where: { id: parseInt(id as string) } })
    res.json({ message: '删除成功' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '删除失败' })
  }
}