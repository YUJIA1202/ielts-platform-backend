import { Request, Response } from 'express'
import prisma from '../prisma'
import path from 'path'
import fs from 'fs'

// ── 获取视频列表（支持按分类筛选，按系列分组）──────────────────────
export async function getVideos(req: Request, res: Response) {
  try {
    const { category } = req.query as { category?: string }

    const where: any = {}
    if (category) where.category = category

    const videos = await prisma.video.findMany({
      where,
      orderBy: [{ series: 'asc' }, { seriesOrder: 'asc' }],
    })

    const grouped: Record<string, typeof videos> = {}
    for (const v of videos) {
      if (!grouped[v.series]) grouped[v.series] = []
      grouped[v.series].push(v)
    }

    res.json({ videos, grouped })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取视频列表失败' })
  }
}

// ── 获取单个视频详情（含同系列目录）────────────────────────────────
export async function getVideoById(req: Request, res: Response) {
  try {
    const id = parseInt(req.params.id as string)
    const userId = (req as any).userId as number | undefined

    const video = await prisma.video.findUnique({ where: { id } })
    if (!video) return res.status(404).json({ error: '视频不存在' })

    const seriesVideos = await prisma.video.findMany({
      where: { series: video.series },
      orderBy: { seriesOrder: 'asc' },
      select: { id: true, title: true, duration: true, seriesOrder: true },
    })

    let trialInfo = null
    if (userId) {
      const log = await prisma.videoTrialLog.findUnique({
        where: { userId_videoId: { userId, videoId: id } },
      })
      trialInfo = { hasWatched: !!log }
    }

    res.json({ video, seriesVideos, trialInfo })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取视频详情失败' })
  }
}

// ── 检查试看权限（打开视频页时调用）────────────────────────────────
export async function checkTrialPermission(req: Request, res: Response) {
  try {
    const userId = (req as any).userId as number
    const videoId = parseInt(req.params.id as string)

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return res.status(404).json({ error: '用户不存在' })

    const video = await prisma.video.findUnique({ where: { id: videoId } })
    if (!video) return res.status(404).json({ error: '视频不存在' })

    if (user.subscription === 'PRO') {
      return res.json({ allowed: true, isTrial: false })
    }

    if (video.isFree) {
      return res.json({ allowed: true, isTrial: false })
    }

    const today = new Date().toISOString().slice(0, 10)

    const existingLog = await prisma.videoTrialLog.findUnique({
      where: { userId_videoId: { userId, videoId } },
    })
    if (existingLog) {
      return res.json({ allowed: true, isTrial: true, alreadyCounted: true })
    }

    if (user.subscription === 'FREE') {
      const totalWatched = await prisma.videoTrialLog.count({ where: { userId } })
      if (totalWatched >= 2) {
        return res.json({ allowed: false, reason: 'FREE用户试看额度已用完' })
      }
    }

    if (user.subscription === 'BASIC') {
      const todayWatched = await prisma.videoTrialLog.count({
        where: { userId, date: today },
      })
      if (todayWatched >= 2) {
        return res.json({ allowed: false, reason: '今日试看额度已用完，明天再来' })
      }
    }

    res.json({ allowed: true, isTrial: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '权限检查失败' })
  }
}

// ── 记录试看（用户真正开始播放时调用一次）──────────────────────────
export async function recordTrial(req: Request, res: Response) {
  try {
    const userId = (req as any).userId as number
    const videoId = parseInt(req.params.id as string)
    const today = new Date().toISOString().slice(0, 10)

    await prisma.videoTrialLog.upsert({
      where: { userId_videoId: { userId, videoId } },
      update: {},
      create: { userId, videoId, date: today },
    })

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '记录试看失败' })
  }
}

// ── 管理员：上传视频文件 + 创建视频记录 ────────────────────────────
export async function createVideo(req: Request, res: Response) {
  try {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] }
    const videoFile = files?.video?.[0]
    const coverFile = files?.cover?.[0]

    if (!videoFile) {
      return res.status(400).json({ error: '请上传视频文件' })
    }

    const { title, description, category, series, seriesOrder, duration, isFree } = req.body

    if (!title || !category || !series || !duration) {
      fs.unlinkSync(videoFile.path)
      if (coverFile) fs.unlinkSync(coverFile.path)
      return res.status(400).json({ error: '缺少必填字段：title, category, series, duration' })
    }

    const baseUrl = process.env.BASE_URL || 'http://localhost:4000'
    const videoUrl = `${baseUrl}/uploads/videos/${videoFile.filename}`
    const coverUrl = coverFile
      ? `${baseUrl}/uploads/covers/${coverFile.filename}`
      : null

    const video = await prisma.video.create({
      data: {
        title,
        description: description || null,
        category,
        series,
        seriesOrder: parseInt(seriesOrder) || 0,
        duration: parseInt(duration),
        url: videoUrl,
        coverUrl,
        isFree: isFree === 'true' || isFree === true,
      },
    })

    res.status(201).json(video)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '上传视频失败' })
  }
}

// ── 管理员：编辑视频信息 ────────────────────────────────────────────
export async function updateVideo(req: Request, res: Response) {
  try {
    const id = parseInt(req.params.id as string)
    const { title, description, category, series, seriesOrder, duration, isFree } = req.body

    const video = await prisma.video.update({
      where: { id },
      data: {
        ...(title && { title }),
        ...(description !== undefined && { description }),
        ...(category && { category }),
        ...(series && { series }),
        ...(seriesOrder !== undefined && { seriesOrder: parseInt(seriesOrder) }),
        ...(duration && { duration: parseInt(duration) }),
        ...(isFree !== undefined && { isFree: isFree === 'true' || isFree === true }),
      },
    })

    res.json(video)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '更新视频失败' })
  }
}

// ── 管理员：删除视频（同时删除本地文件）────────────────────────────
export async function deleteVideo(req: Request, res: Response) {
  try {
    const id = parseInt(req.params.id as string)

    const video = await prisma.video.findUnique({ where: { id } })
    if (!video) return res.status(404).json({ error: '视频不存在' })

    await prisma.video.delete({ where: { id } })

    const tryDelete = (url: string | null) => {
      if (!url) return
      const filename = url.split('/uploads/')[1]
      if (!filename) return
      const filepath = path.join(process.cwd(), 'uploads', filename)
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath)
    }

    tryDelete(video.url)
    tryDelete(video.coverUrl)

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '删除视频失败' })
  }
}