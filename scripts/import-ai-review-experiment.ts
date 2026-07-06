import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  KnowledgeChunkType,
  KnowledgeSourceType,
  KnowledgeVisibility,
  TaskType,
} from '@prisma/client'
import prisma from '../src/prisma'
import { cleanupExperimentData, EXPERIMENT_SOURCE_TITLES } from './ai-review-experiment-common'

interface ExtractedComment {
  commentId: string
  paragraphIndex: number
  anchorText: string
  feedback: string
}

interface ExtractedDocument {
  collection: keyof typeof EXPERIMENT_SOURCE_TITLES
  fileName: string
  sourcePath: string
  modifiedAt: string
  fileHash: string
  textHash: string
  task: TaskType | null
  subtype: string | null
  questionText: string | null
  rawText: string
  paragraphs: string[]
  comments: ExtractedComment[]
  stats: { characters: number; paragraphs: number; comments: number }
}

interface ExperimentManifest {
  summary: Record<string, number>
  documents: ExtractedDocument[]
  errors: Array<{ sourcePath: string; error: string }>
}

const DEFAULT_MANIFEST = path.resolve('data/ai-review-experiment/manifest.json')

function getManifestPath() {
  const index = process.argv.indexOf('--manifest')
  return index >= 0 && process.argv[index + 1]
    ? path.resolve(process.argv[index + 1])
    : DEFAULT_MANIFEST
}

function estimateTokens(text: string) {
  const englishWords = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)?.length || 0
  const cjkCharacters = text.match(/[\u3400-\u9fff]/g)?.length || 0
  return Math.max(1, Math.ceil(englishWords * 1.35 + cjkCharacters * 1.1))
}

function packParagraphs(paragraphs: string[], maxCharacters = 1600) {
  const chunks: string[] = []
  let current = ''
  for (const original of paragraphs) {
    const paragraph = original.trim()
    if (!paragraph) continue
    if (paragraph.length > maxCharacters) {
      if (current) chunks.push(current)
      current = ''
      for (let start = 0; start < paragraph.length; start += maxCharacters) {
        chunks.push(paragraph.slice(start, start + maxCharacters))
      }
      continue
    }
    const next = current ? `${current}\n\n${paragraph}` : paragraph
    if (next.length > maxCharacters && current) {
      chunks.push(current)
      current = paragraph
    } else {
      current = next
    }
  }
  if (current) chunks.push(current)
  return chunks.filter(chunk => chunk.length >= 80)
}

function makeChunks(document: ExtractedDocument) {
  const base = packParagraphs(document.paragraphs).map(chunkText => ({
    chunkText,
    chunkType: KnowledgeChunkType.ESSAY_PARAGRAPH,
    task: document.task,
    subtype: document.subtype,
    tokenCount: estimateTokens(chunkText),
  }))

  if (document.collection === 'TEACHER_REVIEW') {
    for (const comment of document.comments) {
      const anchor = comment.anchorText.trim()
      const feedback = comment.feedback.trim()
      const chunkText = [
        anchor ? `[学生原文]\n${anchor}` : '',
        `[教师反馈]\n${feedback}`,
      ].filter(Boolean).join('\n\n')
      if (chunkText.length >= 20) {
        base.push({
          chunkText,
          chunkType: KnowledgeChunkType.REVIEW_EXAMPLE,
          task: document.task,
          subtype: document.subtype,
          tokenCount: estimateTokens(chunkText),
        })
      }
    }
  }
  return base
}

async function main() {
  const manifestPath = getManifestPath()
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as ExperimentManifest
  console.log('Cleaning previous experiment import...')
  console.log(await cleanupExperimentData())

  const teacherSource = await prisma.knowledgeSource.create({
    data: {
      sourceType: KnowledgeSourceType.TEACHER_REVIEW,
      title: EXPERIMENT_SOURCE_TITLES.TEACHER_REVIEW,
      owner: 'AI review experiment',
      visibility: KnowledgeVisibility.PRIVATE,
    },
  })
  const modelSource = await prisma.knowledgeSource.create({
    data: {
      sourceType: KnowledgeSourceType.MODEL_ESSAY,
      title: EXPERIMENT_SOURCE_TITLES.MODEL_ESSAY,
      owner: 'AI review experiment',
      visibility: KnowledgeVisibility.PRIVATE,
    },
  })

  let importedDocuments = 0
  let importedChunks = 0
  for (const [index, document] of manifest.documents.entries()) {
    const sourceId = document.collection === 'TEACHER_REVIEW' ? teacherSource.id : modelSource.id
    const chunks = makeChunks(document)
    await prisma.$transaction(async tx => {
      const created = await tx.knowledgeDocument.create({
        data: {
          sourceId,
          title: document.fileName,
          rawText: document.rawText,
          fileUrl: document.sourcePath,
          task: document.task,
          subtype: document.subtype,
          band: null,
        },
      })
      if (chunks.length) {
        await tx.knowledgeChunk.createMany({
          data: chunks.map(chunk => ({ ...chunk, documentId: created.id })),
        })
      }
    }, { timeout: 60_000 })
    importedDocuments += 1
    importedChunks += chunks.length
    if ((index + 1) % 25 === 0 || index === manifest.documents.length - 1) {
      console.log(`Imported ${index + 1}/${manifest.documents.length} documents`)
    }
  }

  console.log({
    manifest: manifest.summary,
    importedDocuments,
    importedChunks,
    extractionErrors: manifest.errors.length,
  })
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
