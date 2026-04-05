import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import {
  createSubmission,
  getMySubmissions,
  getSubmissionById,
  getAllSubmissions,
  reviewSubmission,
} from '../controllers/submissionController'
import { requireAuth, requireAdmin } from '../middleware/auth'

const router = Router()

// 用户提交：题目图片 + Word 原文
const submissionStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder =
      file.fieldname === 'image'
        ? 'uploads/submissions/images'
        : 'uploads/submissions/words'
    cb(null, path.join(process.cwd(), folder))
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `${Date.now()}${ext}`)
  },
})

const uploadSubmission = multer({
  storage: submissionStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
})

// 管理员批改：批改结果文件
const reviewStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(process.cwd(), 'uploads/submissions/reviews'))
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `review_${Date.now()}${ext}`)
  },
})

const uploadReview = multer({
  storage: reviewStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
})

router.post(
  '/',
  requireAuth,
  uploadSubmission.fields([
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