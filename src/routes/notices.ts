import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth'
import {
  getNotices,
  getAllNotices,
  createNotice,
  updateNotice,
  deleteNotice,
  toggleNoticeVisibility,
} from '../controllers/noticeController'

const router = Router()
router.get('/',                getNotices)
router.get('/admin/all', requireAuth, requireAdmin, getAllNotices)
router.post('/',               requireAuth, requireAdmin, createNotice)
router.put('/:id',             requireAuth, requireAdmin, updateNotice)
router.delete('/:id',          requireAuth, requireAdmin, deleteNotice)
router.patch('/:id/visibility',requireAuth, requireAdmin, toggleNoticeVisibility)
export default router
