import { Router } from 'express'
import { sendCode, register, login, loginPassword, resetPassword, getMe, logout } from '../controllers/authController'
import { requireAuth } from '../middleware/auth'

const router = Router()

router.post('/send-code', sendCode)
router.post('/register', register)
router.post('/login', login)
router.post('/login-password', loginPassword)
router.post('/reset-password', resetPassword)
router.get('/me', requireAuth, getMe)
router.post('/logout', logout)

export default router
