import { Request, Response } from 'express'
import prisma from '../prisma'

export const createMessage = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { type, title, content } = req.body

    if (!title?.trim() || !content?.trim()) {
      return res.status(400).json({ error: '标题和内容不能为空' })
    }

    const message = await prisma.message.create({
      data: { userId, type: type || 'other', title, content },
    })

    res.json(message)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '提交失败' })
  }
}

export const getAllMessages = async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20', type } = req.query
    const where = type ? { type: type as string } : {}
    const total = await prisma.message.count({ where })
    const messages = await prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page as string) - 1) * parseInt(limit as string),
      take: parseInt(limit as string),
      include: {
        user: { select: { id: true, phone: true, username: true, subscription: true } },
      },
    })
    res.json({ messages, total })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取留言失败' })
  }
}
export const markMessageRead = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const message = await prisma.message.update({
      where: { id },
      data: { isRead: true },
    })
    res.json(message)
  } catch (err) {
    console.error(err)
    res.status(404).json({ error: '留言不存在' })
  }
}