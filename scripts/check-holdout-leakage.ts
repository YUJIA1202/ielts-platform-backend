import 'dotenv/config'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import prisma from '../src/prisma'

function normalizedTextHash(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')
}

async function main() {
  const argument = process.argv.slice(2).find(value => value.startsWith('--manifest='))
  if (!argument) throw new Error('Usage: tsx scripts/check-holdout-leakage.ts --manifest=path/to/manifest.json')
  const manifestPath = path.resolve(process.cwd(), argument.slice('--manifest='.length))
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const holdout = manifest.documents?.[0]
  if (!holdout?.rawText) throw new Error('Manifest does not contain a document')

  const documents = await prisma.knowledgeDocument.findMany({
    select: { id: true, title: true, rawText: true, sourceId: true },
  })
  const exactMatches = documents.filter(document => normalizedTextHash(document.rawText) === holdout.textHash)
  const titleTerms = String(holdout.fileName || '')
    .replace(/\.docx$/i, '')
    .split(/\s+/)
    .filter((term: string) => term.length >= 2)
  const titleMatches = documents.filter(document => (
    titleTerms.some((term: string) => document.title.toLowerCase().includes(term.toLowerCase()))
  ))

  console.log(JSON.stringify({
    manifest: manifestPath,
    holdoutTextHash: holdout.textHash,
    knowledgeDocumentsChecked: documents.length,
    exactMatches: exactMatches.map(document => ({ id: document.id, title: document.title, sourceId: document.sourceId })),
    possibleTitleMatches: titleMatches.slice(0, 20).map(document => ({ id: document.id, title: document.title, sourceId: document.sourceId })),
    safeAsHoldout: exactMatches.length === 0,
  }, null, 2))
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
