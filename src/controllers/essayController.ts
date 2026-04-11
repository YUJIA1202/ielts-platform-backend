import { Request, Response } from 'express'
import prisma from '../prisma'
import { uploadToCOS } from '../lib/cos'
import chromium from '@sparticuz/chromium'
import puppeteer from 'puppeteer-core'

export const getEssays = async (req: Request, res: Response) => {
  try {
    const task = req.query.task as string | undefined
    const subtype = req.query.subtype as string | undefined
    const topic = req.query.topic as string | undefined
    const score = req.query.score as string | undefined
    const year = req.query.year as string | undefined
    const keyword = req.query.keyword as string | undefined
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 15

    const where: any = {}
    if (score) where.score = parseFloat(score)
    if (keyword) where.content = { contains: keyword }

    if (task || subtype || topic || year) {
      where.question = {}
      if (task) where.question.task = task
      if (subtype) where.question.subtype = subtype
      if (topic) where.question.topic = topic
      if (year) where.question.year = parseInt(year)
    }

    const total = await prisma.modelEssay.count({ where })
    const essays = await prisma.modelEssay.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        question: {
          select: { task: true, subtype: true, topic: true, content: true, year: true, month: true, source: true }
        }
      }
    })

    const result = essays.map(e => ({
      ...e,
      task: e.question.task,
      subtype: e.question.subtype,
      topic: e.question.topic,
      questionContent: e.question.content,
      year: e.question.year,
      month: e.question.month,
      source: e.question.source,
    }))

    res.json({ essays: result, total })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取范文列表失败' })
  }
}

export const getEssaysByQuestion = async (req: Request, res: Response) => {
  try {
    const { questionId } = req.params
    const essays = await prisma.modelEssay.findMany({
      where: { questionId: parseInt(questionId as string) },
      select: { id: true, questionId: true, score: true, createdAt: true },
    })
    res.json(essays)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取范文列表失败' })
  }
}

export const getEssayById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const userId = (req as any).userId
    const role = (req as any).role

    if (role !== 'ADMIN') {
      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user || user.subscription === 'FREE') {
        res.status(403).json({ error: '请升级订阅后查看范文' })
        return
      }
      const now = new Date()
      if (user.subExpiresAt && user.subExpiresAt < now) {
        res.status(403).json({ error: '订阅已过期，请续订' })
        return
      }
    }

    const essay = await prisma.modelEssay.findUnique({
      where: { id: parseInt(id as string) },
      include: {
        question: {
          select: { task: true, subtype: true, topic: true, content: true, year: true, month: true, source: true, imageUrl: true }
        }
      }
    })

    if (!essay) {
      res.status(404).json({ error: '范文不存在' })
      return
    }

    res.json({
      ...essay,
      task: essay.question.task,
      subtype: essay.question.subtype,
      topic: essay.question.topic,
      questionContent: essay.question.content,
      questionImageUrl: essay.question.imageUrl,
      year: essay.question.year,
      month: essay.question.month,
      source: essay.question.source,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取范文详情失败' })
  }
}

export const getAnnotatedPdf = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const userId = (req as any).userId

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user || user.subscription === 'FREE') {
      return res.status(403).json({ error: '请升级订阅后下载批注版 PDF' })
    }

    const essay = await prisma.modelEssay.findUnique({
      where: { id: parseInt(id as string) }
    })

    if (!essay) return res.status(404).json({ error: '范文不存在' })
    if (!essay.annotatedPdfUrl) return res.status(404).json({ error: '该范文暂无批注版 PDF' })

    res.redirect(essay.annotatedPdfUrl)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '下载失败' })
  }
}

export const createEssay = async (req: Request, res: Response) => {
  try {
    const { questionId, content, score } = req.body
    if (!questionId || !content) {
      return res.status(400).json({ error: '题目和范文内容不能为空' })
    }

    let annotatedPdfUrl: string | undefined
    if (req.file) {
      annotatedPdfUrl = await uploadToCOS(req.file.buffer, req.file.originalname, 'essays')
    }

    const essay = await prisma.modelEssay.create({
      data: {
        questionId: parseInt(questionId),
        content,
        score: score ? parseFloat(score) : undefined,
        ...(annotatedPdfUrl && { annotatedPdfUrl }),
      },
    })
    res.json(essay)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '创建范文失败' })
  }
}

export const updateEssay = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { questionId, content, score } = req.body

    let annotatedPdfUrl: string | undefined
    if (req.file) {
      annotatedPdfUrl = await uploadToCOS(req.file.buffer, req.file.originalname, 'essays')
    }

    const data: any = {}
    if (questionId !== undefined) data.questionId = parseInt(questionId)
    if (content !== undefined) data.content = content
    if (score !== undefined) data.score = score ? parseFloat(score) : null
    if (annotatedPdfUrl) data.annotatedPdfUrl = annotatedPdfUrl

    const essay = await prisma.modelEssay.update({
      where: { id: parseInt(id as string) },
      data,
    })
    res.json(essay)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '更新范文失败' })
  }
}

export const deleteEssay = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    await prisma.modelEssay.delete({ where: { id: parseInt(id as string) } })
    res.json({ message: '删除成功' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '删除失败' })
  }
}

export const generatePdf = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const userId = (req as any).userId

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return res.status(401).json({ error: '用户不存在' })

    const essay = await prisma.modelEssay.findUnique({
      where: { id: parseInt(Array.isArray(id) ? id[0] : id) },
      include: {
        question: {
          select: { task: true, subtype: true, topic: true, content: true, imageUrl: true, year: true, month: true, source: true }
        }
      }
    })
    if (!essay) return res.status(404).json({ error: '范文不存在' })

    const watermark = user.phone || user.username || 'IELTS PRO'
    const taskLabel = essay.question.task === 'TASK2' ? 'Task 2 大作文' : 'Task 1 小作文'
    const scoreLabel = essay.score ? ` · ${essay.score}分` : ''
    const imageUrl = Array.isArray(essay.question.imageUrl)
      ? essay.question.imageUrl[0]
      : (essay.question.imageUrl || '')

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif;
    font-size: 13px;
    color: #1e293b;
    padding: 28px 36px;
    position: relative;
  }
  .watermark {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    pointer-events: none;
    z-index: 999;
    overflow: hidden;
  }
  .wm-item {
    color: rgba(0,0,0,0.06);
    font-size: 16px;
    font-weight: 400;
    transform: rotate(-25deg);
    white-space: nowrap;
    margin: 40px 30px;
  }
  .title { font-size: 18px; font-weight: 700; color: #1d4ed8; margin-bottom: 6px; }
  .subtitle { font-size: 12px; color: #64748b; margin-bottom: 4px; }
  .divider { border: none; border-top: 1px solid #e2e8f0; margin: 12px 0; }
  .section-label { font-size: 11px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
  .question-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 18px; margin-bottom: 14px; }
  .question-text { font-size: 13px; color: #374151; line-height: 1.85; font-family: Georgia, serif; }
  .question-img { display: block; max-width: 480px; width: 100%; margin: 12px auto 0; border-radius: 6px; }
  .essay-box { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px 22px; }
  .para { font-size: 13px; color: #1e293b; line-height: 1.95; font-family: Georgia, serif; margin-bottom: 12px; }
  .footer { margin-top: 16px; font-size: 10px; color: #94a3b8; text-align: center; }
</style>
</head>
<body>

<div class="watermark">
  ${Array.from({ length: 30 }).map(() => `<div class="wm-item">${watermark}</div>`).join('')}
</div>

<div class="title">IELTS Writing - Model Essay</div>
<div class="subtitle">${taskLabel}${scoreLabel}</div>
${essay.question.subtype || essay.question.topic ? `<div class="subtitle" style="color:#94a3b8">${essay.question.subtype || ''}${essay.question.subtype && essay.question.topic ? ' · ' : ''}${essay.question.topic || ''}</div>` : ''}

<hr class="divider">

${essay.question.content ? `
<div class="question-box">
  <div class="section-label">题目</div>
  <div class="question-text">${essay.question.content.replace(/\n/g, '<br>')}</div>
  ${imageUrl ? `<img class="question-img" src="${imageUrl}">` : ''}
</div>
` : ''}

<div class="essay-box">
  <div class="section-label">范文</div>
  ${essay.content.split('\n').filter(p => p.trim()).map(p => `<div class="para">${p.trim()}</div>`).join('')}
</div>

<div class="footer">© IELTS Writing Pro · ${watermark} · 仅供个人学习使用</div>

</body>
</html>`

   const browser = await puppeteer.launch({
  args: chromium.args,
   executablePath: process.env.CHROMIUM_PATH || await chromium.executablePath(),
  headless: true,
})
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' },
      printBackground: true,
    })
    await browser.close()

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="essay_${id}.pdf"`)
    res.send(pdfBuffer)
  } catch (err) {
    console.error('PDF生成失败', err)
    res.status(500).json({ error: 'PDF生成失败' })
  }
}