import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'

import authRoutes           from './routes/auth'
import questionRoutes       from './routes/questions'
import essayRoutes          from './routes/essays'
import submissionRoutes     from './routes/submissions'
import videoRoutes          from './routes/videos'
import userRoutes           from './routes/users'
import correctionCodeRoutes from './routes/correctionCodes'
import messageRoutes        from './routes/messages'
import reflectionRoutes     from './routes/reflections'
import siteConfigRoutes from './routes/siteConfig'
import noticeRoutes     from './routes/notices'

dotenv.config()

const app  = express()
const PORT = process.env.PORT || 4000

app.use(cors())
app.use(express.json())
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')))

app.use('/api/auth',             authRoutes)
app.use('/api/questions',        questionRoutes)
app.use('/api/essays',           essayRoutes)
app.use('/api/submissions',      submissionRoutes)
app.use('/api/videos',           videoRoutes)
app.use('/api/users',            userRoutes)
app.use('/api/correction-codes', correctionCodeRoutes)
app.use('/api/messages',         messageRoutes)
app.use('/api/reflections', reflectionRoutes)
app.use('/api/site-config', siteConfigRoutes)
app.use('/api/notices',     noticeRoutes)

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', message: '服务器运行正常' })
})

app.listen(PORT, () => {
  console.log(`服务器启动成功，端口：${PORT}`)
})