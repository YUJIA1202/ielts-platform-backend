/**
 * Import the normalized DOCX corpus. Dry-run by default; --write is required.
 * Filename band claims are kept in audit notes and never written as verified
 * KnowledgeDocument.band values.
 */

import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  KnowledgeChunkType,
  KnowledgeSourceType,
  KnowledgeVisibility,
  TaskType,
} from '@prisma/client'
import prisma from '../src/prisma'

const WRITE_MODE = process.argv.includes('--write')
const DEFAULT_MANIFEST = path.resolve('data/rag-docx-task2-v1/manifest.json')
let activeBatchId: number | null = null
const SOURCE_TITLES = {
  REFERENCE_MODEL: 'EXPERIMENT_MODEL_DOCX_TASK2_V1',
  ESSAY_COLLECTION: 'EXPERIMENT_ESSAY_DOCX_QUARANTINE_V1',
} as const

interface ManifestDocument {
  documentKey: string
  collection: keyof typeof SOURCE_TITLES
  fileName: string
  sourcePath: string
  fileHash: string
  task: 'TASK1' | 'TASK2' | null
  subtype: string | null
  questionText: string | null
  essayText: string
  wordCount: number
  paragraphs: Array<{ index: number; text: string; startOffset: number; endOffset: number }>
  quality: {
    status: string
    contentRole: string
    warnings: string[]
    allowedForRag: boolean
    excludeFromEval: boolean
    bandClaim: number | null
    bandVerified: boolean
  }
}

interface Manifest {
  schemaVersion: string
  parserVersion: string
  documents: ManifestDocument[]
  errors: Array<{ sourcePath: string; error: string }>
}

function argValue(name: string, fallback: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function argLimit() {
  const raw = argValue('--limit', '')
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid --limit: ${raw}`)
  return parsed
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function estimateTokens(text: string) {
  const english = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)?.length || 0
  const cjk = text.match(/[\u3400-\u9fff]/g)?.length || 0
  return Math.max(1, Math.ceil(english * 1.35 + cjk * 1.1))
}

function auditNotes(document: ManifestDocument, parserVersion: string, manifestHash: string) {
  return [
    `manifest_document_key=${document.documentKey}`,
    `source_sha256=${document.fileHash}`,
    `parser_version=${parserVersion}`,
    `manifest_sha256=${manifestHash}`,
    `band_claim=${document.quality.bandClaim ?? 'none'}`,
    'band_verified=false',
    ...document.quality.warnings.map(warning => `warning=${warning}`),
  ].join(' | ')
}

async function getOrCreateSource(collection: keyof typeof SOURCE_TITLES) {
  const title = SOURCE_TITLES[collection]
  const sourceType = collection === 'REFERENCE_MODEL'
    ? KnowledgeSourceType.MODEL_ESSAY
    : KnowledgeSourceType.OTHER
  return await prisma.knowledgeSource.findFirst({ where: { title, sourceType } })
    || await prisma.knowledgeSource.create({
      data: {
        sourceType,
        title,
        owner: 'IELTS Task 2 DOCX experiment',
        visibility: KnowledgeVisibility.PRIVATE,
      },
    })
}

async function importDocument(
  sourceId: number,
  document: ManifestDocument,
  parserVersion: string,
  manifestHash: string,
) {
  return prisma.$transaction(async tx => {
    const existing = await tx.knowledgeDocument.findFirst({
      where: {
        sourceId,
        fileUrl: document.sourcePath,
        qualityNotes: { contains: `source_sha256=${document.fileHash}` },
      },
      select: { id: true },
    })
    if (existing) return { status: 'skipped' as const, chunks: 0 }

    const created = await tx.knowledgeDocument.create({
      data: {
        sourceId,
        title: document.fileName,
        rawText: document.essayText,
        fileUrl: document.sourcePath,
        task: document.task === 'TASK2' ? TaskType.TASK2 : null,
        probableTask: document.task === 'TASK2' ? TaskType.TASK2 : null,
        subtype: document.subtype,
        // topic is a short VARCHAR label. Full prompts remain in the manifest
        // and are copied into every retrievable chunk.
        topic: null,
        band: null,
        contentRole: document.quality.contentRole,
        completenessStatus: document.quality.status,
        allowedForRag: document.quality.allowedForRag,
        excludeFromEval: document.quality.excludeFromEval,
        qualityNotes: auditNotes(document, parserVersion, manifestHash),
      },
    })

    let chunks = 0
    for (const paragraph of document.paragraphs) {
      const chunkText = [
        document.questionText ? `[题目]\n${document.questionText}` : '',
        document.collection === 'REFERENCE_MODEL'
          ? `[未经官方分数验证的范文段 ${paragraph.index + 1}]\n${paragraph.text}`
          : `[隔离区作文段 ${paragraph.index + 1}]\n${paragraph.text}`,
      ].filter(Boolean).join('\n\n')
      await tx.knowledgeChunk.create({
        data: {
          documentId: created.id,
          chunkText,
          chunkType: document.collection === 'REFERENCE_MODEL'
            ? KnowledgeChunkType.TEMPLATE
            : KnowledgeChunkType.ESSAY_PARAGRAPH,
          task: document.task === 'TASK2' ? TaskType.TASK2 : null,
          subtype: document.subtype,
          band: null,
          tokenCount: estimateTokens(chunkText),
        },
      })
      chunks += 1
    }
    return { status: 'created' as const, chunks }
  }, { timeout: 120_000 })
}

async function main() {
  const manifestPath = path.resolve(argValue('--manifest', DEFAULT_MANIFEST))
  const limit = argLimit()
  const rawManifest = await fs.readFile(manifestPath)
  const manifest = JSON.parse(rawManifest.toString('utf8')) as Manifest
  const inScope = manifest.documents.filter(document => document.quality.status !== 'OUT_OF_SCOPE_TASK1')
  const documents = limit ? inScope.slice(0, limit) : inScope
  const projections = {
    documents: documents.length,
    chunks: documents.reduce((sum, document) => sum + document.paragraphs.length, 0),
    referenceModels: documents.filter(document => document.collection === 'REFERENCE_MODEL').length,
    quarantined: documents.filter(document => !document.quality.allowedForRag).length,
    allowedForRag: documents.filter(document => document.quality.allowedForRag).length,
    skippedTask1: manifest.documents.length - inScope.length,
  }
  console.log(JSON.stringify({
    mode: WRITE_MODE ? 'WRITE' : 'DRY_RUN',
    manifestPath,
    manifestSchema: manifest.schemaVersion,
    parserVersion: manifest.parserVersion,
    sourceErrors: manifest.errors.length,
    projections,
    policy: {
      destructiveCleanup: false,
      incompleteAndUnknownDocumentsQuarantined: true,
      filenameBandClaimsNotTrusted: true,
      task1Excluded: true,
    },
  }, null, 2))
  if (!WRITE_MODE) return
  if (manifest.errors.length) throw new Error(`Manifest has ${manifest.errors.length} extraction errors`)

  const manifestHash = sha256(rawManifest)
  const sources = {
    REFERENCE_MODEL: await getOrCreateSource('REFERENCE_MODEL'),
    ESSAY_COLLECTION: await getOrCreateSource('ESSAY_COLLECTION'),
  }
  const batch = await prisma.importBatch.create({
    data: {
      label: `rag-docx-task2-${new Date().toISOString().slice(0, 10)}`,
      sourceFileHash: manifestHash,
      parserVersion: manifest.parserVersion,
      cleaningVersion: manifest.schemaVersion,
      notes: JSON.stringify({ manifestPath, projections, sources: SOURCE_TITLES }),
    },
  })
  activeBatchId = batch.id

  let created = 0
  let skipped = 0
  let chunks = 0
  for (const [index, document] of documents.entries()) {
    const result = await importDocument(sources[document.collection].id, document, manifest.parserVersion, manifestHash)
    if (result.status === 'created') created += 1
    else skipped += 1
    chunks += result.chunks
    if ((index + 1) % 10 === 0 || index === documents.length - 1) console.log(`Processed ${index + 1}/${documents.length}`)
  }
  await prisma.importBatch.update({ where: { id: batch.id }, data: { importedCount: created } })
  activeBatchId = null
  console.log(JSON.stringify({ batchId: batch.id, created, skipped, chunks }, null, 2))
}

main()
  .catch(async error => {
    if (WRITE_MODE && activeBatchId != null) {
      await prisma.importBatch.update({ where: { id: activeBatchId }, data: { isActive: false } }).catch(() => undefined)
    }
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (WRITE_MODE) await prisma.$disconnect()
  })
