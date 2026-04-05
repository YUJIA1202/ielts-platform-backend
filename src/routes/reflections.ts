import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  getMyReflections,
  getReflectionById,
  createReflection,
  updateReflection,
  deleteReflection,
} from '../controllers/reflectionController'

const router = Router()

router.get('/',       requireAuth, getMyReflections)
router.get('/:id',    requireAuth, getReflectionById)
router.post('/',      requireAuth, createReflection)
router.put('/:id',    requireAuth, updateReflection)
router.delete('/:id', requireAuth, deleteReflection)

export default router