import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_production'

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  // 优先从 Cookie 读，兼容旧的 Authorization header
  let token = req.cookies?.token

  if (!token) {
    const authHeader = req.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1]
    }
  }

  if (!token) {
    res.status(401).json({ error: '未登录' })
    return
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as any
    ;(req as any).userId = payload.userId
    ;(req as any).role = payload.role
    next()
  } catch {
    res.status(401).json({ error: 'token 无效或已过期' })
  }
}

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if ((req as any).role !== 'ADMIN') {
    res.status(403).json({ error: '无权限' })
    return
  }
  next()
}

export const requireSubscription = (tier: 'BASIC' | 'PRO') => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { PrismaClient } = await import('@prisma/client')
    const prisma = new PrismaClient()
    const user = await prisma.user.findUnique({ where: { id: (req as any).userId } })
    if (!user) {
      res.status(401).json({ error: '用户不存在' })
      return
    }
    const now = new Date()
    const expired = user.subExpiresAt && user.subExpiresAt < now
    if (expired || user.subscription === 'FREE') {
      res.status(403).json({ error: '请升级订阅' })
      return
    }
    if (tier === 'PRO' && user.subscription !== 'PRO') {
      res.status(403).json({ error: '需要高级订阅' })
      return
    }
    next()
  }
}