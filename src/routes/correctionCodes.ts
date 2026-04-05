import { Router } from 'express'
import { verifyCode, getMyCodes, generateCodes, getAllCodes } from '../controllers/correctionCodeController'
import { requireAuth, requireAdmin } from '../middleware/auth'

const router = Router()

router.post('/verify', requireAuth, verifyCode)          // 验证码
router.get('/mine', requireAuth, getMyCodes)             // 我的批改码

router.post('/generate', requireAuth, requireAdmin, generateCodes)  // 管理员生成
router.get('/', requireAuth, requireAdmin, getAllCodes)              // 管理员查看全部

export default router