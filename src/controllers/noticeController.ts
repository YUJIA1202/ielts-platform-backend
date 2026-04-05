import { Request, Response } from 'express'
import prisma from '../prisma'

// 公开：前端读取所有可见公告（按 sortOrder 排序）
export const getNotices = async (req: Request, res: Response) => {
  try {
    const notices = await prisma.notice.findMany({
      where:   { visible: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    })
    res.json(notices)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取失败' })
  }
}

// 管理员：获取全部公告（包括隐藏的）
export const getAllNotices = async (req: Request, res: Response) => {
  try {
    const notices = await prisma.notice.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    })
    res.json(notices)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取失败' })
  }
}

// 管理员：新增公告
export const createNotice = async (req: Request, res: Response) => {
  try {
    const { type, title, content, date, sortOrder, visible } = req.body
    if (!type || !title || !content || !date) {
      return res.status(400).json({ error: 'type、title、content、date 不能为空' })
    }
    const notice = await prisma.notice.create({
      data: {
        type,
        title,
        content,
        date,
        sortOrder: sortOrder ?? 0,
        visible:   visible   ?? true,
      },
    })
    res.json(notice)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '创建失败' })
  }
}

// 管理员：编辑公告
export const updateNotice = async (req: Request, res: Response) => {
  try {
  const id = parseInt(req.params.id as string)
    const { type, title, content, date, sortOrder, visible } = req.body

    const existing = await prisma.notice.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ error: '公告不存在' })

    const updated = await prisma.notice.update({
      where: { id },
      data: {
        type:      type      ?? existing.type,
        title:     title     ?? existing.title,
        content:   content   ?? existing.content,
        date:      date      ?? existing.date,
        sortOrder: sortOrder ?? existing.sortOrder,
        visible:   visible   ?? existing.visible,
      },
    })
    res.json(updated)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '更新失败' })
  }
}

// 管理员：删除公告
export const deleteNotice = async (req: Request, res: Response) => {
  try {
  const id = parseInt(req.params.id as string)
    const existing = await prisma.notice.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ error: '公告不存在' })

    await prisma.notice.delete({ where: { id } })
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '删除失败' })
  }
}

// 管理员：切换显示/隐藏
export const toggleNoticeVisibility = async (req: Request, res: Response) => {
  try {
const id = parseInt(req.params.id as string)
    const existing = await prisma.notice.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ error: '公告不存在' })

    const updated = await prisma.notice.update({
      where: { id },
      data:  { visible: !existing.visible },
    })
    res.json(updated)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '操作失败' })
  }
}