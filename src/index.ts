import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'

import authRoutes           from './routes/auth'
import questionRoutes       from './routes/questions'
import essayRoutes          from './routes/essays'
import submissionRoutes     from './routes/submissions'
import videoRoutes          from './routes/videos'
import userRoutes           from './routes/users'
import correctionCodeRoutes from './routes/correctionCodes'
import messageRoutes        from './routes/messages'
import reflectionRoutes     from './routes/reflections'
import siteConfigRoutes     from './routes/siteConfig'
import noticeRoutes         from './routes/notices'
import outlineViewLogRoutes from './routes/outlineViewLog'
dotenv.config({ override: false })

const app  = express()
const PORT = process.env.PORT || 4000


app.set('trust proxy', 1)
app.use(helmet())

// CORS：明确允许前端域名，并允许携带 Cookie
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://ielts-platform-frontend.vercel.app', 
  ],
  credentials: true,  // 允许携带 Cookie
}))

app.use(express.json())
app.use(cookieParser())  // 解析 Cookie
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')))

// 发验证码限速：每个 IP 每 60 秒最多 3 次
const smsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { error: '发送太频繁，请稍后再试' },
})

// 登录限速：每个 IP 每 15 分钟最多 20 次
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: '请求太频繁，请稍后再试' },
})

app.use('/api/auth/send-code', smsLimiter)
app.use('/api/auth/login', loginLimiter)
app.use('/api/auth/login-password', loginLimiter)

app.use('/api/auth',             authRoutes)
app.use('/api/questions',        questionRoutes)
app.use('/api/essays',           essayRoutes)
app.use('/api/submissions',      submissionRoutes)
app.use('/api/videos',           videoRoutes)
app.use('/api/users',            userRoutes)
app.use('/api/correction-codes', correctionCodeRoutes)
app.use('/api/messages',         messageRoutes)
app.use('/api/reflections',      reflectionRoutes)
app.use('/api/site-config',      siteConfigRoutes)
app.use('/api/notices',          noticeRoutes)
app.use('/api/outline-view-log', outlineViewLogRoutes)

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', message: '服务器运行正常' })
})

app.listen(PORT, () => {
  console.log(`服务器启动成功，端口：${PORT}`)
})