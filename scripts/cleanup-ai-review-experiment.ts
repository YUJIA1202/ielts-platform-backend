import 'dotenv/config'
import prisma from '../src/prisma'
import { cleanupExperimentData } from './ai-review-experiment-common'

cleanupExperimentData()
  .then(result => console.log('Experiment data removed:', result))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
