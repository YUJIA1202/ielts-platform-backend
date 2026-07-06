import { Request, Response } from 'express'
import {
  createAndRunAiReview,
  getAiReviewForUser,
  getAiReviewJobForUser,
  listAiReviewsForUser,
} from '../services/ai/aiReviewService'
import { normalizeQuestionSubtype } from '../utils/questionTaxonomy'

export const createAiReviewRequest = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as number
    const { questionId, submissionId, questionText, essayText, task, subtype, topic } = req.body
    if (!essayText || typeof essayText !== 'string' || !essayText.trim()) {
      return res.status(400).json({ error: '请输入作文内容' })
    }

    const result = await createAndRunAiReview({
      userId,
      questionId: questionId ? Number(questionId) : null,
      submissionId: submissionId ? Number(submissionId) : null,
      questionText: typeof questionText === 'string' ? questionText : null,
      essayText,
      task: task === 'TASK1' || task === 'TASK2' ? task : null,
      subtype: typeof subtype === 'string' ? normalizeQuestionSubtype(task, subtype) : null,
      topic: typeof topic === 'string' ? topic : null,
    })
    res.json(result)
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'AI批改失败' })
  }
}

export const getAiReviewJob = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as number
    const role = (req as any).role as string | undefined
    const job = await getAiReviewJobForUser(Number(req.params.id), userId, role)
    if (!job) return res.status(404).json({ error: 'AI批改任务不存在' })
    res.json(job)
  } catch (error) {
    if (error instanceof Error && error.message === 'Forbidden') return res.status(403).json({ error: '无权查看该任务' })
    console.error(error)
    res.status(500).json({ error: '获取AI批改任务失败' })
  }
}

export const getAiReview = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as number
    const role = (req as any).role as string | undefined
    const review = await getAiReviewForUser(Number(req.params.id), userId, role)
    if (!review) return res.status(404).json({ error: 'AI批改结果不存在' })
    res.json(review)
  } catch (error) {
    if (error instanceof Error && error.message === 'Forbidden') return res.status(403).json({ error: '无权查看该批改结果' })
    console.error(error)
    res.status(500).json({ error: '获取AI批改结果失败' })
  }
}

export const getMyAiReviews = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as number
    res.json(await listAiReviewsForUser(userId))
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: '获取AI批改列表失败' })
  }
}
