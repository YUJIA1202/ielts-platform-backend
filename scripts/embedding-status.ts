import 'dotenv/config'
import prisma from '../src/prisma'
import { getEmbeddingStatus } from '../src/services/ai/embeddingService'

getEmbeddingStatus()
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
