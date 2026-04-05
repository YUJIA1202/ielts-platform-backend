import { Request, Response } from 'express'
import prisma from '../prisma'

export const getMyReflections = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const keyword = req.query.keyword as string | undefined
    const tag     = req.query.tag     as string | undefined

    const where: any = { userId }
    if (keyword) {
      where.OR = [
        { title:   { contains: keyword } },
        { content: { contains: keyword } },
      ]
    }
    if (tag) where.tags = { contains: tag }

    const reflections = await prisma.reflection.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        submission: {
          select: {
            id:           true,
            overallScore: true,
            question:     { select: { content: true } },
            customPrompt: true,
          }
        }
      }
    })
    res.json(reflections)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取失败' })
  }
}

export const createReflection = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { title, content, tags, submissionId } = req.body
    if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' })

    const reflection = await prisma.reflection.create({
      data: {
        userId,
        title,
        content,
        tags:         tags         || null,
        submissionId: submissionId ? parseInt(submissionId as string) : null,
      }
    })
    res.json(reflection)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '创建失败' })
  }
}

export const updateReflection = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const id     = req.params.id as string
    const { title, content, tags } = req.body

    const existing = await prisma.reflection.findUnique({ where: { id: parseInt(id) } })
    if (!existing)                  return res.status(404).json({ error: '不存在' })
    if (existing.userId !== userId) return res.status(403).json({ error: '无权限' })

    const updated = await prisma.reflection.update({
      where: { id: parseInt(id) },
      data:  { title, content, tags: tags || null }
    })
    res.json(updated)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '更新失败' })
  }
}

export const deleteReflection = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const id     = req.params.id as string

    const existing = await prisma.reflection.findUnique({ where: { id: parseInt(id) } })
    if (!existing)                  return res.status(404).json({ error: '不存在' })
    if (existing.userId !== userId) return res.status(403).json({ error: '无权限' })

    await prisma.reflection.delete({ where: { id: parseInt(id) } })
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '删除失败' })
  }
}
export const getReflectionById = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const id = req.params.id as string
    const reflection = await prisma.reflection.findUnique({ where: { id: parseInt(id) } })
    if (!reflection) return res.status(404).json({ error: '不存在' })
    if (reflection.userId !== userId) return res.status(403).json({ error: '无权限' })
    res.json(reflection)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取失败' })
  }
}