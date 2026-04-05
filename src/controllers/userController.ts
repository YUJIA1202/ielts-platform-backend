import { Request, Response } from 'express'
import prisma from '../prisma'
import path from 'path'
import fs from 'fs'

export const getAllUsers = async (req: Request, res: Response) => {
  try {
    const page         = (req.query.page         as string) || '1'
    const limit        = (req.query.limit        as string) || '20'
    const phone        = req.query.phone        as string | undefined
    const subscription = req.query.subscription as string | undefined
    const order        = (req.query.order        as string) || 'desc'

    const where: Record<string, unknown> = {}
    if (phone) where.phone = { contains: phone }
    if (subscription && subscription !== 'ALL') where.subscription = subscription

    const total = await prisma.user.count({ where })
    const users = await prisma.user.findMany({
      where,
      orderBy: { createdAt: order === 'asc' ? 'asc' : 'desc' },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
      select: {
        id: true, phone: true, username: true, role: true,
        subscription: true, subExpiresAt: true, createdAt: true, banned: true,
      },
    })
    res.json({ users, total })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取用户列表失败' })
  }
}

export const getUserById = async (req: Request, res: Response) => {
  try {
    const id   = req.params.id as string
    const user = await prisma.user.findUnique({
      where: { id: parseInt(id) },
      select: {
        id: true, phone: true, username: true, role: true,
        subscription: true, subExpiresAt: true, createdAt: true, banned: true,
      },
    })
    if (!user) return res.status(404).json({ error: '用户不存在' })
    res.json(user)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取用户失败' })
  }
}

export const updateUserSubscription = async (req: Request, res: Response) => {
  try {
    const id                             = req.params.id as string
    const { subscription, subExpiresAt } = req.body
    if (!subscription) {
      res.status(400).json({ error: '请提供订阅等级' })
      return
    }
    const user = await prisma.user.update({
      where: { id: parseInt(id) },
      data: {
        subscription,
        subExpiresAt: subExpiresAt ? new Date(subExpiresAt) : null,
      },
    })
    res.json(user)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '更新订阅失败' })
  }
}

export const toggleBanUser = async (req: Request, res: Response) => {
  try {
    const id   = req.params.id as string
    const user = await prisma.user.findUnique({ where: { id: parseInt(id) } })
    if (!user) return res.status(404).json({ error: '用户不存在' })
    const updated = await prisma.user.update({
      where: { id: parseInt(id) },
      data:  { banned: !user.banned },
    })
    res.json(updated)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '操作失败' })
  }
}

export const updateProfile = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const {
      username, targetScore, currentScore,
      examDate, studyFocus, weeklyHours,
    } = req.body
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(username     !== undefined && { username }),
        ...(targetScore  !== undefined && { targetScore:  parseFloat(targetScore) }),
        ...(currentScore !== undefined && { currentScore: parseFloat(currentScore) }),
        ...(examDate     !== undefined && { examDate: examDate ? new Date(examDate) : null }),
        ...(studyFocus   !== undefined && { studyFocus }),
        ...(weeklyHours  !== undefined && { weeklyHours: parseInt(weeklyHours) }),
      },
      select: {
        id: true, phone: true, username: true, avatar: true, role: true,
        subscription: true, subExpiresAt: true, targetScore: true,
        currentScore: true, examDate: true, studyFocus: true, weeklyHours: true,
      },
    })
    res.json(user)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '更新个人信息失败' })
  }
}

export const uploadAvatar = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const file   = req.file
    if (!file) return res.status(400).json({ error: '请上传头像图片' })

    const baseUrl   = process.env.BASE_URL || 'http://localhost:4000'
    const avatarUrl = `${baseUrl}/uploads/avatars/${file.filename}`

    const oldUser = await prisma.user.findUnique({
      where: { id: userId }, select: { avatar: true },
    })
    if (oldUser?.avatar && oldUser.avatar.includes('/uploads/avatars/')) {
      const oldFilename = oldUser.avatar.split('/uploads/avatars/')[1]
      const oldPath     = path.join(process.cwd(), 'uploads', 'avatars', oldFilename)
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
    }

    const user = await prisma.user.update({
      where: { id: userId }, data: { avatar: avatarUrl },
      select: { id: true, avatar: true },
    })
    res.json({ avatar: user.avatar })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '上传头像失败' })
  }
}

export const getUserLoginSessions = async (req: Request, res: Response) => {
  try {
    const id       = req.params.id as string
    const sessions = await prisma.loginSession.findMany({
      where:   { userId: parseInt(id) },
      orderBy: { createdAt: 'desc' },
      take:    20,
    })
    res.json(sessions)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取登录记录失败' })
  }
}

export const getUserTrialLogs = async (req: Request, res: Response) => {
  try {
    const id   = req.params.id as string
    const logs = await prisma.videoTrialLog.findMany({
      where:   { userId: parseInt(id) },
      orderBy: { createdAt: 'desc' },
      include: {
        video: {
          select: {
            id: true, title: true,
            series: true, category: true, duration: true,
          },
        },
      },
    })
    res.json(logs)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取视频浏览记录失败' })
  }
}

export const getUserSubmissions = async (req: Request, res: Response) => {
  try {
    const id          = req.params.id as string
    const submissions = await prisma.submission.findMany({
      where:   { userId: parseInt(id) },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, status: true, createdAt: true,
        overallScore: true, adminComment: true, customPrompt: true,
        question: {
          select: { task: true, subtype: true, content: true },
        },
      },
    })
    res.json(submissions)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取批改记录失败' })
  }
}

export const getUserEssayViews = async (req: Request, res: Response) => {
  try {
    const id   = req.params.id as string
    const logs = await prisma.essayViewLog.findMany({
      where:   { userId: parseInt(id) },
      orderBy: { createdAt: 'desc' },
      include: {
        essay: {
          select: {
            id: true, score: true,
            question: {
              select: { task: true, subtype: true, content: true },
            },
          },
        },
      },
    })
    res.json(logs)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取范文浏览记录失败' })
  }
}

export const getUserQuestionViews = async (req: Request, res: Response) => {
  try {
    const id   = req.params.id as string
    const logs = await prisma.questionViewLog.findMany({
      where:   { userId: parseInt(id) },
      orderBy: { createdAt: 'desc' },
      include: {
        question: {
          select: {
            id: true, task: true, subtype: true,
            topic: true, content: true, year: true,
          },
        },
      },
    })
    res.json(logs)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取真题浏览记录失败' })
  }
}