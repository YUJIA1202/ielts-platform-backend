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
router.post('/',               requireAdmin, createNotice)
router.put('/:id',             requireAdmin, updateNotice)
router.delete('/:id',          requireAdmin, deleteNotice)
router.patch('/:id/visibility',requireAdmin, toggleNoticeVisibility)
export default router