import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { requireAuth, requireAdmin } from '../middleware/auth'
import {
  getAllUsers,
  getUserById,
  getUserSubmissions,
  getUserEssayViews,
  getUserQuestionViews,
  updateUserSubscription,
  toggleBanUser,
  updateProfile,
  uploadAvatar,
  getUserLoginSessions,
  getUserTrialLogs,
} from '../controllers/userController'

const router = Router()

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, path.join(process.cwd(), 'uploads/avatars'))
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `avatar_${Date.now()}${ext}`)
  },
})

const uploadMiddleware = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('只支持图片文件'))
    }
    cb(null, true)
  },
})

// 固定路径在前
router.get('/all',     requireAuth, requireAdmin, getAllUsers)
router.put('/profile', requireAuth, updateProfile)
router.post('/avatar', requireAuth, uploadMiddleware.single('avatar'), uploadAvatar)

// 动态子路径在 /:id 之前
router.get('/:id/login-sessions',  requireAuth, requireAdmin, getUserLoginSessions)
router.get('/:id/trial-logs',      requireAuth, requireAdmin, getUserTrialLogs)
router.get('/:id/submissions',     requireAuth, requireAdmin, getUserSubmissions)
router.get('/:id/essay-views',     requireAuth, requireAdmin, getUserEssayViews)
router.get('/:id/question-views',  requireAuth, requireAdmin, getUserQuestionViews)
router.get('/:id',                 requireAuth, requireAdmin, getUserById)
router.put('/:id/subscription',    requireAuth, requireAdmin, updateUserSubscription)
router.patch('/:id/ban',           requireAuth, requireAdmin, toggleBanUser)

export default router