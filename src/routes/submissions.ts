import { Router } from 'express'
import multer from 'multer'
import {
  createSubmission,
  getMySubmissions,
  getSubmissionById,
  getAllSubmissions,
  reviewSubmission,
} from '../controllers/submissionController'
import { requireAuth, requireAdmin } from '../middleware/auth'

const router = Router()

// 用内存存储，不写本地磁盘
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
})

const uploadReview = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
})

router.post(
  '/',
  requireAuth,
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'wordFile', maxCount: 1 },
  ]),
  createSubmission
)

router.get('/my', requireAuth, getMySubmissions)
router.get('/all', requireAuth, requireAdmin, getAllSubmissions)
router.get('/:id', requireAuth, getSubmissionById)

router.put(
  '/:id/review',
  requireAuth,
  requireAdmin,
  uploadReview.single('reviewFile'),
  reviewSubmission
)

export default router