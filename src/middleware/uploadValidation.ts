import { NextFunction, Request, Response } from 'express'
import path from 'path'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const WORD_EXTENSIONS = new Set(['.doc', '.docx'])
const REVIEW_EXTENSIONS = new Set(['.pdf', '.doc', '.docx'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm'])

export function validateSubmissionFiles(req: Request, res: Response, next: NextFunction) {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined
  const image = files?.image?.[0]
  const word = files?.wordFile?.[0]
  if (image && (!IMAGE_EXTENSIONS.has(extension(image)) || !isImage(image.buffer))) {
    return res.status(400).json({ error: '作文图片格式无效，仅支持真实的 JPG、PNG、GIF 或 WebP 文件' })
  }
  if (word && (!WORD_EXTENSIONS.has(extension(word)) || !isWord(word.buffer, extension(word)))) {
    return res.status(400).json({ error: '作文文档格式无效，仅支持真实的 DOC 或 DOCX 文件' })
  }
  next()
}

export function validateReviewFile(req: Request, res: Response, next: NextFunction) {
  const file = req.file
  if (!file) return next()
  const ext = extension(file)
  const valid = REVIEW_EXTENSIONS.has(ext) && (ext === '.pdf' ? isPdf(file.buffer) : isWord(file.buffer, ext))
  if (!valid) return res.status(400).json({ error: '批改附件格式无效，仅支持真实的 PDF、DOC 或 DOCX 文件' })
  next()
}

export function validatePdfFile(req: Request, res: Response, next: NextFunction) {
  if (req.file && (extension(req.file) !== '.pdf' || !isPdf(req.file.buffer))) {
    return res.status(400).json({ error: 'PDF 文件内容无效' })
  }
  next()
}

export function validateImageFile(req: Request, res: Response, next: NextFunction) {
  if (req.file && (!IMAGE_EXTENSIONS.has(extension(req.file)) || !isImage(req.file.buffer))) {
    return res.status(400).json({ error: '图片文件内容无效' })
  }
  next()
}

export function validateVideoFiles(req: Request, res: Response, next: NextFunction) {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined
  const video = files?.video?.[0]
  const cover = files?.cover?.[0]
  if (video) {
    const ext = extension(video)
    if (!VIDEO_EXTENSIONS.has(ext) || !isVideo(video.buffer, ext)) {
      return res.status(400).json({ error: '视频文件内容无效，仅支持真实的 MP4、MOV 或 WebM 文件' })
    }
  }
  if (cover && (!IMAGE_EXTENSIONS.has(extension(cover)) || !isImage(cover.buffer))) {
    return res.status(400).json({ error: '视频封面内容无效' })
  }
  next()
}

function extension(file: Express.Multer.File) {
  return path.extname(file.originalname).toLowerCase()
}

function isPdf(buffer: Buffer) {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-'
}

function isWord(buffer: Buffer, ext: string) {
  if (ext === '.docx') return startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])
  return startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
}

function isImage(buffer: Buffer) {
  return startsWith(buffer, [0xff, 0xd8, 0xff])
    || startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    || buffer.subarray(0, 6).toString('ascii') === 'GIF87a'
    || buffer.subarray(0, 6).toString('ascii') === 'GIF89a'
    || (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP')
}

function isVideo(buffer: Buffer, ext: string) {
  if (ext === '.webm') return startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])
  return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp'
}

function startsWith(buffer: Buffer, signature: number[]) {
  return buffer.length >= signature.length && signature.every((value, index) => buffer[index] === value)
}
