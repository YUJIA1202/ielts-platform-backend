import fs from 'node:fs'
import path from 'node:path'
import { preprocessEssay } from '../src/services/ai/preprocessor'
import { evaluateReviewOutput, ReferenceAnnotation } from '../src/services/ai/reviewEvaluator'
import { validateReviewOutput } from '../src/services/ai/reviewValidator'

interface EvaluationFile {
  questionText?: string | null
  essayText: string
  task?: 'TASK1' | 'TASK2' | null
  subtype?: string | null
  topic?: string | null
  review: unknown
  referenceAnnotations?: ReferenceAnnotation[]
}

const inputPath = readArgument('--input')
if (!inputPath) {
  throw new Error('Usage: npm run ai-review:evaluate -- --input=path/to/evaluation.json')
}

const absolutePath = path.resolve(process.cwd(), inputPath)
const fixture = JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as EvaluationFile
const essay = preprocessEssay({
  questionText: fixture.questionText,
  essayText: fixture.essayText,
  task: fixture.task,
  subtype: fixture.subtype,
  topic: fixture.topic,
})
const review = validateReviewOutput(fixture.review, essay)
const report = evaluateReviewOutput({
  essay,
  review,
  referenceAnnotations: fixture.referenceAnnotations,
})

console.log(JSON.stringify({
  input: absolutePath,
  essay: {
    wordCount: essay.wordCount,
    paragraphCount: essay.paragraphs.length,
    sentenceCount: essay.sentences.length,
  },
  report,
}, null, 2))

function readArgument(name: string) {
  const prefix = `${name}=`
  return process.argv.slice(2).find(argument => argument.startsWith(prefix))?.slice(prefix.length) || null
}
