import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { getQuestions, getQuestionById, createQuestion, updateQuestion, deleteQuestion } from '../controllers/questionController'
import { requireAuth, requireAdmin } from '../middleware/auth'

const router = Router()

const imgDir = path.join(process.cwd(), 'uploads/questions')
if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true })

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, imgDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `question_${Date.now()}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new Error('只允许上传图片'))
    }
  },
})

router.get('/', getQuestions)
router.get('/:id', getQuestionById)
router.post('/', requireAuth, requireAdmin, upload.single('image'), createQuestion)
router.put('/:id', requireAuth, requireAdmin, upload.single('image'), updateQuestion)
router.delete('/:id', requireAuth, requireAdmin, deleteQuestion)

export default router