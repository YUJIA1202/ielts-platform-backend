import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth'
import {
  getAllSiteConfigs,
  upsertSiteConfig,
} from '../controllers/siteConfigController'

import { uploadQRCode, uploadSiteImage } from '../controllers/siteConfigController'


const router = Router()

router.get('/',        getAllSiteConfigs)               // 公开
router.put('/:key', requireAuth, requireAdmin, upsertSiteConfig)
router.post(
  '/upload/:key',
  requireAuth,
  requireAdmin,
  uploadSiteImage.single('image'),
  uploadQRCode,
)

export default router