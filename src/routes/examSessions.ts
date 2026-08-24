import { NextFunction, Request, Response, Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  createExamSession,
  getExamSession,
  getMyExamSessions,
  updateExamSession,
} from '../controllers/examSessionController'

const router = Router()

function useSafeQuestionPayload(_req: Request, res: Response, next: NextFunction) {
  res.locals.safeQuestionPayload = true
  next()
}

router.post('/', requireAuth, createExamSession)
router.get('/my', requireAuth, getMyExamSessions)
router.post('/v2', requireAuth, useSafeQuestionPayload, createExamSession)
router.get('/v2/my', requireAuth, useSafeQuestionPayload, getMyExamSessions)
router.get('/v2/:id', requireAuth, useSafeQuestionPayload, getExamSession)
router.patch('/v2/:id', requireAuth, useSafeQuestionPayload, updateExamSession)
router.get('/:id', requireAuth, getExamSession)
router.patch('/:id', requireAuth, updateExamSession)

export default router
