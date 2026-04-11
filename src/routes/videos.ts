import { Router } from 'express'
import multer from 'multer'
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

// 封面图用内存存储上传到 COS，视频文件暂时还是本地
const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'cover' && !file.mimetype.startsWith('image/')) {
      return cb(new Error('封面只支持图片文件'))
    }
    cb(null, true)
  },
})

router.get('/', getVideos)
router.get('/:id', requireAuth, getVideoById)
router.get('/:id/trial-check', requireAuth, checkTrialPermission)
router.post('/:id/trial-record', requireAuth, recordTrial)

router.post('/', requireAuth, requireAdmin,
  coverUpload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
  ]),
  createVideo
)
router.put('/:id', requireAuth, requireAdmin, updateVideo)
router.delete('/:id', requireAuth, requireAdmin, deleteVideo)

export default router