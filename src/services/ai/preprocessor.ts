import { TaskType } from '@prisma/client'
import { PreprocessedEssay, PreprocessedParagraph, PreprocessedSentence } from './types'

const TASK2_PATTERNS = [
  /discuss both/i,
  /to what extent/i,
  /advantages?.*disadvantages?/i,
  /problems?.*solutions?/i,
  /agree or disagree/i,
  /give your own opinion/i,
]

const TASK1_PATTERNS = [
  /the chart/i,
  /the graph/i,
  /the table/i,
  /the diagram/i,
  /the map/i,
  /the process/i,
  /summarise/i,
  /summarize/i,
]

export function preprocessEssay(input: {
  questionText?: string | null
  essayText: string
  task?: TaskType | null
  subtype?: string | null
  topic?: string | null
}): PreprocessedEssay {
  const normalizedQuestion = normalizeText(input.questionText || '')
  const normalizedEssay = normalizeText(input.essayText)
  const paragraphTexts = splitParagraphs(normalizedEssay)
  const sentences: PreprocessedSentence[] = []
  let paragraphSearchOffset = 0
  const paragraphRecords: PreprocessedParagraph[] = paragraphTexts.map((paragraph, paragraphIndex) => {
    const paragraphStart = normalizedEssay.indexOf(paragraph, paragraphSearchOffset)
    const safeParagraphStart = paragraphStart >= 0 ? paragraphStart : paragraphSearchOffset
    const paragraphEnd = safeParagraphStart + paragraph.length
    paragraphSearchOffset = paragraphEnd
    const localSentences = splitSentences(paragraph)
    const sentenceIndexes: number[] = []
    let sentenceSearchOffset = 0
    for (const sentence of localSentences) {
      const index = sentences.length + 1
      const localStart = paragraph.indexOf(sentence, sentenceSearchOffset)
      const safeLocalStart = localStart >= 0 ? localStart : sentenceSearchOffset
      const startOffset = safeParagraphStart + safeLocalStart
      const endOffset = startOffset + sentence.length
      sentences.push({
        index,
        text: sentence,
        paragraphIndex: paragraphIndex + 1,
        startOffset,
        endOffset,
      })
      sentenceSearchOffset = safeLocalStart + sentence.length
      sentenceIndexes.push(index)
    }
    return {
      index: paragraphIndex + 1,
      text: paragraph,
      sentenceIndexes,
      startOffset: safeParagraphStart,
      endOffset: paragraphEnd,
    }
  })

  return {
    normalizedQuestion: normalizedQuestion || null,
    normalizedEssay,
    sentences,
    paragraphs: paragraphRecords,
    wordCount: countWords(normalizedEssay),
    detectedTask: input.task || detectTask(normalizedQuestion, normalizedEssay),
    detectedSubtype: input.subtype || detectSubtype(normalizedQuestion),
    detectedTopic: input.topic || null,
  }
}

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ \u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function splitParagraphs(text: string): string[] {
  if (!text) return []
  const byBlankLines = text.split(/\n\s*\n/g).map(part => part.trim()).filter(Boolean)
  if (byBlankLines.length > 1) return byBlankLines
  return text.split('\n').map(part => part.trim()).filter(Boolean)
}

function splitSentences(paragraph: string): string[] {
  const matches = paragraph.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g)
  return (matches || [paragraph]).map(sentence => sentence.trim()).filter(Boolean)
}

function countWords(text: string): number {
  const matches = text.match(/[A-Za-z]+(?:[-'][A-Za-z]+)?|\d+(?:\.\d+)?/g)
  return matches ? matches.length : 0
}

function detectTask(questionText: string, essayText: string): TaskType | null {
  const joined = `${questionText}\n${essayText}`
  if (TASK1_PATTERNS.some(pattern => pattern.test(joined))) return 'TASK1'
  if (TASK2_PATTERNS.some(pattern => pattern.test(joined))) return 'TASK2'
  return null
}

function detectSubtype(questionText: string): string | null {
  if (!questionText) return null
  if (/discuss both/i.test(questionText)) return 'discussion'
  if (/to what extent|agree or disagree/i.test(questionText)) return 'opinion'
  if (/advantages?.*disadvantages?/i.test(questionText)) return 'advantages_disadvantages'
  if (/problems?.*solutions?/i.test(questionText)) return 'problem_solution'
  if (/map/i.test(questionText)) return 'map'
  if (/process|diagram/i.test(questionText)) return 'process'
  if (/chart|graph|table/i.test(questionText)) return 'chart'
  return null
}
