import { Router } from 'express'
import multer from 'multer'
import { getEssays, getEssaysByQuestion, getEssayById, getAnnotatedPdf, createEssay, updateEssay, deleteEssay } from '../controllers/essayController'
import { requireAuth, requireAdmin } from '../middleware/auth'

const router = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true)
    } else {
      cb(new Error('只允许上传 PDF 文件'))
    }
  },
})

router.get('/', getEssays)
router.get('/question/:questionId', getEssaysByQuestion)
router.get('/:id/annotated-pdf', requireAuth, getAnnotatedPdf)
router.get('/:id', requireAuth, getEssayById)
router.post('/', requireAuth, requireAdmin, upload.single('annotatedPdf'), createEssay)
router.put('/:id', requireAuth, requireAdmin, upload.single('annotatedPdf'), updateEssay)
router.delete('/:id', requireAuth, requireAdmin, deleteEssay)

export default router