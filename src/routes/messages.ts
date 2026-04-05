import { Router } from 'express'
import { createMessage, getAllMessages, markMessageRead } from '../controllers/messageController'
import { requireAuth, requireAdmin } from '../middleware/auth'

const router = Router()

router.post('/', requireAuth, createMessage)
router.get('/', requireAuth, requireAdmin, getAllMessages)
router.patch('/:id/read', requireAuth, requireAdmin, markMessageRead)

export default router