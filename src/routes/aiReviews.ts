import { Router } from 'express'
import {
  createAiReviewRequest,
  getAiReview,
  getAiReviewJob,
  getMyAiReviews,
} from '../controllers/aiReviewController'
import { requireAuth } from '../middleware/auth'

const router = Router()

router.post('/requests', requireAuth, createAiReviewRequest)
router.get('/my', requireAuth, getMyAiReviews)
router.get('/jobs/:id', requireAuth, getAiReviewJob)
router.get('/:id', requireAuth, getAiReview)

export default router
