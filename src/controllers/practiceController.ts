import { Request, Response } from 'express'
import {
  appealPracticeAttempt,
  createPracticeSession,
  getPracticeHistory,
  getPracticeItemForUser,
  getPracticeProfile,
  PracticeServiceError,
  submitPracticeAttempt,
} from '../services/practice/practiceService'

function handleError(res: Response, error: unknown, fallback: string) {
  if (error instanceof PracticeServiceError) return res.status(error.status).json({ error: error.message })
  console.error(error)
  return res.status(500).json({ error: error instanceof Error ? error.message : fallback })
}

export async function createSession(req: Request, res: Response) {
  try {
    const studentId = (req as any).userId as number
    const { mode, tab, topic, questionSubtype, aiReviewId, essaySubmissionId } = req.body || {}
    if (mode !== 'topic' && mode !== 'essay') return res.status(400).json({ error: 'mode 必须是 topic 或 essay' })
    if (tab !== 'language' && tab !== 'thinking') return res.status(400).json({ error: 'tab 必须是 language 或 thinking' })
    const result = await createPracticeSession({
      studentId,
      mode,
      tab,
      topic: typeof topic === 'string' ? topic : null,
      questionSubtype: typeof questionSubtype === 'string' ? questionSubtype : null,
      aiReviewId: aiReviewId ? Number(aiReviewId) : null,
      essaySubmissionId: essaySubmissionId ? Number(essaySubmissionId) : null,
    })
    return res.status(201).json(result)
  } catch (error) {
    return handleError(res, error, '创建练习失败')
  }
}

export async function getItem(req: Request, res: Response) {
  try {
    const studentId = (req as any).userId as number
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null
    return res.json(await getPracticeItemForUser(String(req.params.itemId), studentId, sessionId))
  } catch (error) {
    return handleError(res, error, '获取练习题失败')
  }
}

export async function createAttempt(req: Request, res: Response) {
  try {
    const studentId = (req as any).userId as number
    const { sessionId, itemId, answerPayload } = req.body || {}
    if (!sessionId || !itemId) return res.status(400).json({ error: '缺少 sessionId 或 itemId' })
    return res.status(201).json(await submitPracticeAttempt({
      studentId,
      sessionId: String(sessionId),
      itemId: String(itemId),
      answerPayload,
    }))
  } catch (error) {
    return handleError(res, error, '提交答案失败')
  }
}

export async function appealAttempt(req: Request, res: Response) {
  try {
    const studentId = (req as any).userId as number
    return res.status(201).json(await appealPracticeAttempt({
      studentId,
      attemptId: String(req.params.attemptId),
      reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
    }))
  } catch (error) {
    return handleError(res, error, '提交申诉失败')
  }
}

export async function getProfile(req: Request, res: Response) {
  try {
    const studentId = (req as any).userId as number
    const role = (req as any).role as string | undefined
    const requestedId = Number(req.params.studentId)
    if (!Number.isInteger(requestedId)) return res.status(400).json({ error: 'studentId 无效' })
    if (role !== 'ADMIN' && requestedId !== studentId) return res.status(403).json({ error: '无权查看该练习画像' })
    return res.json(await getPracticeProfile(requestedId))
  } catch (error) {
    return handleError(res, error, '获取练习画像失败')
  }
}

export async function getHistory(req: Request, res: Response) {
  try {
    const studentId = (req as any).userId as number
    const tab = req.query.tab === 'language' || req.query.tab === 'thinking' ? req.query.tab : null
    const requestedLimit = Number(req.query.limit)
    return res.json(await getPracticeHistory({
      studentId,
      tab,
      limit: Number.isInteger(requestedLimit) ? requestedLimit : null,
    }))
  } catch (error) {
    return handleError(res, error, '获取练习历史失败')
  }
}
