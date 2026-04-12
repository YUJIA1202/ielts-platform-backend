import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import prisma from '../prisma'

const router = Router()

// 获取今日查看次数
router.get('/today', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId
    const today = new Date().toISOString().split('T')[0]

    const log = await prisma.outlineViewLog.findUnique({
      where: { userId_date: { userId, date: today } }
    })

    res.json({ count: log?.count || 0, date: today })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取失败' })
  }
})

// 记录一次查看
router.post('/record', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId
    const today = new Date().toISOString().split('T')[0]

    const log = await prisma.outlineViewLog.upsert({
      where: { userId_date: { userId, date: today } },
      update: { count: { increment: 1 } },
      create: { userId, date: today, count: 1 }
    })

    res.json({ count: log.count, date: today })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '记录失败' })
  }
})

export default router