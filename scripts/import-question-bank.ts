import fs from 'fs'
import path from 'path'
import prisma from '../src/prisma'
import { normalizeQuestionSubtype } from '../src/utils/questionTaxonomy'

type QuestionBankRecord = {
  sourceKey: string
  sourceRow: number
  task: 'TASK1' | 'TASK2'
  subtype: string
  topic: string
  topicCategory: string
  topicSubcategory: string
  content: string
  source: string
  examDate: string | null
  year: number | null
  month: number | null
  testMode: string
  region: string
  similarGroup: string
}

function asDate(value: string | null) {
  if (!value) return null
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

async function main() {
  const dataPath = path.resolve(__dirname, '../data/question-bank-final-revised.json')
  const records = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as QuestionBankRecord[]
  let created = 0
  let updated = 0

  for (const record of records) {
    const subtype = normalizeQuestionSubtype(record.task, record.subtype)
    const existing = await prisma.question.findUnique({
      where: { sourceKey: record.sourceKey },
      select: { id: true },
    })
    await prisma.question.upsert({
      where: { sourceKey: record.sourceKey },
      create: {
        task: record.task,
        subtype,
        topic: record.topic,
        topicCategory: record.topicCategory,
        topicSubcategory: record.topicSubcategory,
        content: record.content,
        source: record.source,
        sourceKey: record.sourceKey,
        sourceRow: record.sourceRow,
        examDate: asDate(record.examDate),
        year: record.year,
        month: record.month,
        testMode: record.testMode,
        region: record.region,
        similarGroup: record.similarGroup,
      },
      update: {
        task: record.task,
        subtype,
        topic: record.topic,
        topicCategory: record.topicCategory,
        topicSubcategory: record.topicSubcategory,
        content: record.content,
        source: record.source,
        sourceRow: record.sourceRow,
        examDate: asDate(record.examDate),
        year: record.year,
        month: record.month,
        testMode: record.testMode,
        region: record.region,
        similarGroup: record.similarGroup,
      },
    })
    if (existing) updated += 1
    else created += 1
  }

  console.log(`Question bank import complete: created=${created}, updated=${updated}, total=${records.length}`)
}

main()
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
