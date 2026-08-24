import { Router } from 'express'
import {
  appealAttempt,
  createAttempt,
  createSession,
  getHistory,
  getItem,
  getProfile,
} from '../controllers/practiceController'
import { requireAuth } from '../middleware/auth'

const router = Router()

router.post('/sessions', requireAuth, createSession)
router.get('/history', requireAuth, getHistory)
router.get('/items/:itemId', requireAuth, getItem)
router.post('/attempts', requireAuth, createAttempt)
router.post('/attempts/:attemptId/appeal', requireAuth, appealAttempt)
router.get('/profile/:studentId', requireAuth, getProfile)

export default router
