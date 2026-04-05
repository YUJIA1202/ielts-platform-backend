import { Request, Response } from 'express'
import prisma from '../prisma'
import multer from 'multer'
import path from 'path'
import fs from 'fs'

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(process.cwd(), 'uploads/site')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `${file.fieldname}_${Date.now()}${ext}`)
  },
})
export const uploadSiteImage = multer({ storage })

export const uploadQRCode = async (req: Request, res: Response) => {
  try {
    const { key } = req.params as { key: string }  // 如 "qr_wechat" 或 "qr_public"
    const file = (req as any).file
    if (!file) return res.status(400).json({ error: '没有上传文件' })

    const url = `/uploads/site/${file.filename}`

    await prisma.siteConfig.upsert({
      where:  { key },
      update: { value: JSON.stringify(url) },
      create: { key,  value: JSON.stringify(url) },
    })
    res.json({ url })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '上传失败' })
  }
}

// 公开：前端读取全部配置
export const getAllSiteConfigs = async (req: Request, res: Response) => {
  try {
    const configs = await prisma.siteConfig.findMany()
    const result: Record<string, any> = {}
    for (const c of configs) {
      try { result[c.key] = JSON.parse(c.value) }
      catch { result[c.key] = c.value }
    }
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取失败' })
  }
}

// 管理员：更新某个 key 的配置（不存在则创建）
export const upsertSiteConfig = async (req: Request, res: Response) => {
  try {const { key } = req.params as { key: string }
      const { value } = req.body
    if (value === undefined) return res.status(400).json({ error: 'value 不能为空' })

    const config = await prisma.siteConfig.upsert({
      where:  { key },
      update: { value: JSON.stringify(value) },
      create: { key,  value: JSON.stringify(value) },
    })
    res.json(config)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '更新失败' })
  }
}