import { Request, Response } from 'express'
import prisma from '../prisma'
import { uploadToCOS } from '../lib/cos'
import tencentcloud from 'tencentcloud-sdk-nodejs-tms'

const TmsClient = tencentcloud.tms.v20201229.Client
const ImsClient = require('tencentcloud-sdk-nodejs-ims').ims.v20201229.Client

const clientConfig = {
  credential: {
    secretId: process.env.TENCENT_SECRET_ID!,
    secretKey: process.env.TENCENT_SECRET_KEY!,
  },
  region: process.env.TENCENT_REGION || 'ap-guangzhou',
  profile: {},
}

async function checkTextSafety(text: string): Promise<boolean> {
  try {
    const client = new TmsClient(clientConfig)
    const result = await client.TextModeration({
      Content: Buffer.from(text).toString('base64'),
      BizType: '',
    })
    return result.Suggestion === 'Pass'
  } catch (err) {
    console.error('文本审核失败，默认放行', err)
    return true  // 审核接口故障时不影响用户提交
  }
}

async function checkImageSafety(imageUrl: string): Promise<boolean> {
  try {
    const client = new ImsClient(clientConfig)
    const result = await client.ImageModeration({
      FileUrl: imageUrl,
      BizType: '',
    })
    return result.Suggestion === 'Pass'
  } catch (err) {
    console.error('图片审核失败，默认放行', err)
    return true
  }
}

export const createSubmission = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const { questionId, customPrompt, content, correctionCode } = req.body

    if (!content && !req.files) {
      return res.status(400).json({ error: '请输入文章内容或上传文件' })
    }

    if (!correctionCode) {
      return res.status(400).json({ error: '请输入批改码' })
    }

    // 文本内容审核
    if (content) {
      const textSafe = await checkTextSafety(content)
      if (!textSafe) {
        return res.status(400).json({ error: '提交内容含有违规信息，请修改后重新提交' })
      }
    }

    const codeRecord = await prisma.correctionCode.findUnique({
      where: { code: correctionCode.trim().toUpperCase() },
    })

    if (!codeRecord) return res.status(400).json({ error: '批改码不存在' })
    if (codeRecord.isUsed) return res.status(400).json({ error: '该批改码已被使用' })

    // 上传文件到 COS
    const files = req.files as Record<string, Express.Multer.File[]>
    const imageFile = files?.image?.[0]
    const wordFile = files?.wordFile?.[0]

    let imageUrl: string | undefined
    let wordFileUrl: string | undefined

    if (imageFile) {
      imageUrl = await uploadToCOS(imageFile.buffer, imageFile.originalname, 'submissions/images')
      // 图片内容审核（上传后用 URL 审核）
      const fullImageUrl = `https://${process.env.COS_BUCKET}.cos.${process.env.COS_REGION}.myqcloud.com/${imageUrl}`
      const imageSafe = await checkImageSafety(fullImageUrl)
      if (!imageSafe) {
        return res.status(400).json({ error: '上传图片含有违规内容，请重新上传' })
      }
    }

    if (wordFile) {
      wordFileUrl = await uploadToCOS(wordFile.buffer, wordFile.originalname, 'submissions/words')
    }

    const submission = await prisma.submission.create({
      data: {
        userId,
        questionId: questionId ? parseInt(questionId) : null,
        customPrompt,
        content,
        ...(imageUrl && { imageUrl }),
        ...(wordFileUrl && { wordFileUrl }),
      },
    })

    await prisma.correctionCode.update({
      where: { code: codeRecord.code },
      data: {
        isUsed: true,
        usedBy: userId,
        usedAt: new Date(),
        usedInSubmissionId: submission.id,
      },
    })

    res.json(submission)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '提交失败' })
  }
}

export const getMySubmissions = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const submissions = await prisma.submission.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        question: true,
        correctionCode: { select: { code: true, type: true } },
      },
    })
    res.json(submissions)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取提交列表失败' })
  }
}

export const getSubmissionById = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    const role = (req as any).role
    const { id } = req.params

    const submission = await prisma.submission.findUnique({
      where: { id: parseInt(id as string) },
      include: {
        question: true,
        user: true,
        correctionCode: { select: { code: true, type: true } },
      },
    })

    if (!submission) return res.status(404).json({ error: '提交记录不存在' })
    if (role !== 'ADMIN' && submission.userId !== userId) {
      return res.status(403).json({ error: '无权限查看此记录' })
    }

    res.json(submission)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取提交详情失败' })
  }
}

export const getAllSubmissions = async (req: Request, res: Response) => {
  try {
    const { status, page = '1', limit = '20' } = req.query
    const where: any = {}
    if (status) where.status = status

    const total = await prisma.submission.count({ where })
    const submissions = await prisma.submission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page as string) - 1) * parseInt(limit as string),
      take: parseInt(limit as string),
      include: {
        user: true,
        question: true,
        correctionCode: { select: { code: true, type: true } },
      },
    })
    res.json({ submissions, total })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '获取提交列表失败' })
  }
}

export const reviewSubmission = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const {
      taScore, ccScore, lrScore, graScore, overallScore,
      adminComment, reviewTask, reviewSubtype,
    } = req.body

    const file = req.file
    const reviewFileUrl = file
      ? await uploadToCOS(file.buffer, file.originalname, 'submissions/reviews')
      : undefined

    const submission = await prisma.submission.update({
      where: { id: parseInt(id as string) },
      data: {
        status: 'REVIEWED',
        taScore:      taScore      ? parseFloat(taScore)      : undefined,
        ccScore:      ccScore      ? parseFloat(ccScore)      : undefined,
        lrScore:      lrScore      ? parseFloat(lrScore)      : undefined,
        graScore:     graScore     ? parseFloat(graScore)     : undefined,
        overallScore: overallScore ? parseFloat(overallScore) : undefined,
        adminComment: adminComment || undefined,
        ...(reviewFileUrl && { reviewFileUrl }),
        ...(reviewTask    && { reviewTask }),
        ...(reviewSubtype && { reviewSubtype }),
      },
    })

    res.json(submission)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '批改失败' })
  }
}