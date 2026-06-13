import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  createExamSession,
  getExamSession,
  getMyExamSessions,
  updateExamSession,
} from '../controllers/examSessionController'

const router = Router()

router.post('/', requireAuth, createExamSession)
router.get('/my', requireAuth, getMyExamSessions)
router.get('/:id', requireAuth, getExamSession)
router.patch('/:id', requireAuth, updateExamSession)

export default router
