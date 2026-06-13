import { Request, Response } from 'express'
import prisma from '../prisma'

const includeQuestions = {
  primaryQuestion: { include: { essays: true } },
  secondaryQuestion: { include: { essays: true } },
}

export async function createExamSession(req: Request, res: Response) {
  try {
    const userId = (req as any).userId as number
    const primaryQuestionId = Number(req.body.primaryQuestionId)
    const secondaryQuestionId = req.body.secondaryQuestionId
      ? Number(req.body.secondaryQuestionId)
      : null

    if (!primaryQuestionId) {
      res.status(400).json({ error: '请选择考试题目' })
      return
    }

    const questionIds = [primaryQuestionId, secondaryQuestionId].filter(Boolean) as number[]
    const questions = await prisma.question.findMany({ where: { id: { in: questionIds } } })
    if (questions.length !== questionIds.length) {
      res.status(404).json({ error: '考试题目不存在' })
      return
    }

    const primary = questions.find(question => question.id === primaryQuestionId)!
    const mode = secondaryQuestionId ? 'MIXED' : 'SINGLE'
    const durationSeconds = mode === 'MIXED'
      ? 60 * 60
      : primary.task === 'TASK2' ? 40 * 60 : 20 * 60

    const session = await prisma.examSession.create({
      data: {
        userId,
        primaryQuestionId,
        secondaryQuestionId,
        mode,
        durationSeconds,
      },
      include: includeQuestions,
    })

    res.json(session)
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: '创建考试失败' })
  }
}

export async function updateExamSession(req: Request, res: Response) {
  try {
    const userId = (req as any).userId as number
    const id = Number(req.params.id)
    const existing = await prisma.examSession.findUnique({ where: { id } })

    if (!existing) {
      res.status(404).json({ error: '考试记录不存在' })
      return
    }
    if (existing.userId !== userId) {
      res.status(403).json({ error: '无权修改该考试记录' })
      return
    }

    const { primaryAnswer, secondaryAnswer, elapsedSeconds, currentPart, status } = req.body
    const nextStatus = ['IN_PROGRESS', 'COMPLETED', 'ABANDONED'].includes(status)
      ? status
      : undefined

    const session = await prisma.examSession.update({
      where: { id },
      data: {
        ...(primaryAnswer !== undefined && { primaryAnswer: String(primaryAnswer) }),
        ...(secondaryAnswer !== undefined && { secondaryAnswer: String(secondaryAnswer) }),
        ...(elapsedSeconds !== undefined && { elapsedSeconds: Math.max(0, Number(elapsedSeconds) || 0) }),
        ...(currentPart !== undefined && { currentPart: Number(currentPart) === 2 ? 2 : 1 }),
        ...(nextStatus && { status: nextStatus }),
        ...(nextStatus === 'COMPLETED' && { completedAt: new Date() }),
      },
      include: includeQuestions,
    })

    res.json(session)
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: '保存考试失败' })
  }
}

export async function getMyExamSessions(req: Request, res: Response) {
  try {
    const userId = (req as any).userId as number
    const sessions = await prisma.examSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: includeQuestions,
    })
    res.json(sessions)
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: '获取考试记录失败' })
  }
}

export async function getExamSession(req: Request, res: Response) {
  try {
    const userId = (req as any).userId as number
    const role = (req as any).role as string
    const id = Number(req.params.id)
    const session = await prisma.examSession.findUnique({
      where: { id },
      include: includeQuestions,
    })

    if (!session) {
      res.status(404).json({ error: '考试记录不存在' })
      return
    }
    if (role !== 'ADMIN' && session.userId !== userId) {
      res.status(403).json({ error: '无权查看该考试记录' })
      return
    }

    res.json(session)
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: '获取考试详情失败' })
  }
}
