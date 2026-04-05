import { Request, Response } from 'express'
import prisma from '../prisma'

export const createSubmission = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { questionId, customPrompt, content, correctionCode } = req.body

    if (!content && !req.file) {
      return res.status(400).json({ error: '请输入文章内容或上传文件' })
    }

    if (!correctionCode) {
      return res.status(400).json({ error: '请输入批改码' })
    }

    // 验证批改码
    const codeRecord = await prisma.correctionCode.findUnique({
      where: { code: correctionCode.trim().toUpperCase() },
    })

    if (!codeRecord) return res.status(400).json({ error: '批改码不存在' })
    if (codeRecord.isUsed) return res.status(400).json({ error: '该批改码已被使用' })

    // 创建提交记录
    const submission = await prisma.submission.create({
      data: {
        userId,
        questionId: questionId ? parseInt(questionId) : null,
        customPrompt,
        content,
      },
    })

    // 标记批改码为已使用
    await prisma.correctionCode.update({
      where: { code: codeRecord.code },
      data: {
        isUsed: true,
        usedBy: userId,
        usedAt: new Date(),
        usedInSubmissionId: submission.id,
      },
    })

    res.json(submission)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '提交失败' })
  }
}

export const getMySubmissions = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const submissions = await prisma.submission.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        question: true,
        correctionCode: { select: { code: true, type: true } },
      },
    })
    res.json(submissions)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取提交列表失败' })
  }
}

export const getSubmissionById = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const role = (req as any).role
    const { id } = req.params

    const submission = await prisma.submission.findUnique({
      where: { id: parseInt(id as string) },
      include: {
        question: true,
        user: true,
        correctionCode: { select: { code: true, type: true } },
      },
    })

    if (!submission) return res.status(404).json({ error: '提交记录不存在' })
    if (role !== 'ADMIN' && submission.userId !== userId) {
      return res.status(403).json({ error: '无权限查看此记录' })
    }

    res.json(submission)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取提交详情失败' })
  }
}

export const getAllSubmissions = async (req: Request, res: Response) => {
  try {
    const { status, page = '1', limit = '20' } = req.query
    const where: any = {}
    if (status) where.status = status

    const total = await prisma.submission.count({ where })
    const submissions = await prisma.submission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page as string) - 1) * parseInt(limit as string),
      take: parseInt(limit as string),
      include: {
        user: true,
        question: true,
        correctionCode: { select: { code: true, type: true } },
      },
    })
    res.json({ submissions, total })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取提交列表失败' })
  }
}

export const reviewSubmission = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const {
      taScore, ccScore, lrScore, graScore, overallScore,
      adminComment, reviewTask, reviewSubtype,
    } = req.body

    const file = req.file
    const reviewFileUrl = file
      ? `${process.env.BASE_URL || 'http://localhost:4000'}/uploads/submissions/reviews/${file.filename}`
      : undefined

    const submission = await prisma.submission.update({
      where: { id: parseInt(id as string) },
      data: {
        status: 'REVIEWED',
        taScore:      taScore      ? parseFloat(taScore)      : undefined,
        ccScore:      ccScore      ? parseFloat(ccScore)      : undefined,
        lrScore:      lrScore      ? parseFloat(lrScore)      : undefined,
        graScore:     graScore     ? parseFloat(graScore)     : undefined,
        overallScore: overallScore ? parseFloat(overallScore) : undefined,
        adminComment: adminComment || undefined,
        ...(reviewFileUrl && { reviewFileUrl }),
        ...(reviewTask    && { reviewTask }),
        ...(reviewSubtype && { reviewSubtype }),
      },
    })

    res.json(submission)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '批改失败' })
  }
}