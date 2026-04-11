import { Request, Response } from 'express'
import prisma from '../prisma'
import multer from 'multer'
import { uploadToCOS } from '../lib/cos'

// 改用内存存储
export const uploadSiteImage = multer({ storage: multer.memoryStorage() })

export const uploadQRCode = async (req: Request, res: Response) => {
  try {
    const { key } = req.params as { key: string }
    const file = (req as any).file as Express.Multer.File | undefined
    if (!file) return res.status(400).json({ error: '没有上传文件' })

    const url = await uploadToCOS(file.buffer, file.originalname, 'site')

    await prisma.siteConfig.upsert({
      where:  { key },
      update: { value: JSON.stringify(url) },
      create: { key,   value: JSON.stringify(url) },
    })
    res.json({ url })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '上传失败' })
  }
}

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

export const upsertSiteConfig = async (req: Request, res: Response) => {
  try {
    const { key } = req.params as { key: string }
    const { value } = req.body
    if (value === undefined) return res.status(400).json({ error: 'value 不能为空' })

    const config = await prisma.siteConfig.upsert({
      where:  { key },
      update: { value: JSON.stringify(value) },
      create: { key,   value: JSON.stringify(value) },
    })
    res.json(config)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '更新失败' })
  }
}