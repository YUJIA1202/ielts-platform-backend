import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { getEssays, getEssaysByQuestion, getEssayById, getAnnotatedPdf, createEssay, updateEssay, deleteEssay } from '../controllers/essayController'
import { requireAuth, requireAdmin } from '../middleware/auth'

const router = Router()

// 确保目录存在
const pdfDir = path.join(process.cwd(), 'uploads/essays')
if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true })

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, pdfDir)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `essay_${Date.now()}${ext}`)
  },
})

const upload = multer({
  storage,
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