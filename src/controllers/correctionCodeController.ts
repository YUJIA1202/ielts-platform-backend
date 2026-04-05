import { Request, Response } from 'express'
import prisma from '../prisma'
import crypto from 'crypto'

// ── 验证批改码（提交前调用）─────────────────────────────────────────
export async function verifyCode(req: Request, res: Response) {
  try {
    const { code } = req.body
    if (!code) return res.status(400).json({ error: '请输入批改码' })

    const record = await prisma.correctionCode.findUnique({
      where: { code: code.trim().toUpperCase() },
    })

    if (!record) return res.json({ valid: false, reason: '批改码不存在' })
    if (record.isUsed) return res.json({ valid: false, reason: '该批改码已被使用' })

    res.json({ valid: true, type: record.type })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '验证失败' })
  }
}

// ── 查询我的批改码列表 ───────────────────────────────────────────────
export async function getMyCodes(req: Request, res: Response) {
  try {
    const userId = (req as any).userId

    const codes = await prisma.correctionCode.findMany({
      where: { usedBy: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        submission: {
          select: { id: true, status: true, createdAt: true },
        },
      },
    })

    res.json(codes)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取批改码失败' })
  }
}

// ── 管理员：批量生成批改码 ───────────────────────────────────────────
export async function generateCodes(req: Request, res: Response) {
  try {
    const { type, count } = req.body

    if (!type || !['TASK1', 'TASK2', 'ANY'].includes(type)) {
      return res.status(400).json({ error: 'type 必须是 TASK1 / TASK2 / ANY' })
    }
    if (!count || count < 1 || count > 100) {
      return res.status(400).json({ error: 'count 必须在 1-100 之间' })
    }

    const codes = []
    for (let i = 0; i < count; i++) {
      // 格式：TASK2-A1B2C3D4
      const random = crypto.randomBytes(4).toString('hex').toUpperCase()
      codes.push({ code: `${type}-${random}`, type })
    }

    const created = await prisma.correctionCode.createMany({ data: codes })
    const newCodes = await prisma.correctionCode.findMany({
      where: { code: { in: codes.map(c => c.code) } },
      orderBy: { createdAt: 'desc' },
    })

    res.status(201).json({ count: created.count, codes: newCodes })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '生成批改码失败' })
  }
}

// ── 管理员：查看所有批改码 ───────────────────────────────────────────
export async function getAllCodes(req: Request, res: Response) {
  try {
    const { type, isUsed, page = '1', limit = '20' } = req.query

    const where: any = {}
    if (type) where.type = type
    if (isUsed !== undefined) where.isUsed = isUsed === 'true'

    const total = await prisma.correctionCode.count({ where })
    const codes = await prisma.correctionCode.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page as string) - 1) * parseInt(limit as string),
      take: parseInt(limit as string),
      include: {
        user: { select: { id: true, phone: true, username: true } },
      },
    })

    res.json({ codes, total })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取批改码列表失败' })
  }
}