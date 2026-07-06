import 'dotenv/config'
import prisma from '../src/prisma'
import { embedKnowledgeChunks } from '../src/services/ai/embeddingService'

function numberArgument(name: string, fallback: number) {
  const prefix = `--${name}=`
  const value = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

embedKnowledgeChunks({
  limit: numberArgument('limit', 100),
  batchSize: numberArgument('batch-size', 50),
  dryRun: process.argv.includes('--dry-run'),
  retryFailed: process.argv.includes('--retry-failed'),
})
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
