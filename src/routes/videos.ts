import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import {
  getVideos,
  getVideoById,
  checkTrialPermission,
  recordTrial,
  createVideo,
  updateVideo,
  deleteVideo,
} from '../controllers/videoController'
import { requireAuth, requireAdmin } from '../middleware/auth'

const router = Router()

// ── multer 配置 ──────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = file.fieldname === 'video' ? 'uploads/videos' : 'uploads/covers'
    cb(null, path.join(process.cwd(), folder))
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `${Date.now()}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 最大 500MB
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'video' && !file.mimetype.startsWith('video/')) {
      return cb(new Error('只支持视频文件'))
    }
    if (file.fieldname === 'cover' && !file.mimetype.startsWith('image/')) {
      return cb(new Error('封面只支持图片文件'))
    }
    cb(null, true)
  },
})

// ── 路由 ─────────────────────────────────────────────────────────────
router.get('/', getVideos)
router.get('/:id', requireAuth, getVideoById)
router.get('/:id/trial-check', requireAuth, checkTrialPermission)
router.post('/:id/trial-record', requireAuth, recordTrial)

router.post('/', requireAuth, requireAdmin,
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
  ]),
  createVideo
)
router.put('/:id', requireAuth, requireAdmin, updateVideo)
router.delete('/:id', requireAuth, requireAdmin, deleteVideo)

export default router