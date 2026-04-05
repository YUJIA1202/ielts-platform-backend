import { Router } from 'express'
import { sendCode, register, login, loginPassword, getMe } from '../controllers/authController'
import { requireAuth } from '../middleware/auth'

const router = Router()

router.post('/send-code', sendCode)
router.post('/register', register)
router.post('/login', login)
router.post('/login-password', loginPassword)
router.get('/me', requireAuth, getMe)

export default router