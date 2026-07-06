import fs from 'node:fs/promises'
import path from 'node:path'

interface ExtractedComment {
  commentId: string
  anchorText: string
  feedback: string
}

function argument(name: string) {
  const prefix = `${name}=`
  return process.argv.slice(2).find(value => value.startsWith(prefix))?.slice(prefix.length) || null
}

function findOccurrence(text: string, anchor: string, occurrence: number) {
  const haystack = text.toLocaleLowerCase()
  const needle = anchor.toLocaleLowerCase()
  let offset = 0
  let found = -1
  for (let index = 0; index < occurrence; index += 1) {
    found = haystack.indexOf(needle, offset)
    if (found < 0) return -1
    offset = found + needle.length
  }
  return found
}

async function main() {
  const manifestArgument = argument('--manifest')
  const outputArgument = argument('--output')
  const paragraphArgument = argument('--paragraph-indexes')
  if (!manifestArgument || !outputArgument || !paragraphArgument) {
    throw new Error('Usage: --manifest=file --output=file --paragraph-indexes=1,5,10')
  }

  const manifestPath = path.resolve(process.cwd(), manifestArgument)
  const outputPath = path.resolve(process.cwd(), outputArgument)
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const document = manifest.documents?.[0]
  if (!document) throw new Error('Manifest contains no document')
  const paragraphIndexes = paragraphArgument.split(',').map(Number)
  if (paragraphIndexes.some(index => !Number.isInteger(index) || !document.paragraphs[index])) {
    throw new Error('One or more paragraph indexes are invalid')
  }
  const essayText = paragraphIndexes.map(index => document.paragraphs[index]).join('\n\n')
  const occurrenceCounts = new Map<string, number>()
  const referenceAnnotations = []
  const unmatchedComments = []

  for (const comment of document.comments as ExtractedComment[]) {
    const anchorText = comment.anchorText?.trim()
    if (!anchorText || !comment.feedback?.trim()) continue
    const key = anchorText.toLocaleLowerCase()
    const occurrence = (occurrenceCounts.get(key) || 0) + 1
    const startOffset = findOccurrence(essayText, anchorText, occurrence)
    if (startOffset < 0) {
      unmatchedComments.push({ commentId: comment.commentId, anchorText, feedback: comment.feedback })
      continue
    }
    occurrenceCounts.set(key, occurrence)
    referenceAnnotations.push({
      commentId: comment.commentId,
      anchorText,
      startOffset,
      endOffset: startOffset + anchorText.length,
      teacherFeedback: comment.feedback,
    })
  }

  const fixture = {
    sourceFile: document.sourcePath,
    sourceTextHash: document.textHash,
    task: document.task,
    subtype: document.subtype,
    questionText: document.questionText,
    essayText,
    selectedParagraphIndexes: paragraphIndexes,
    referenceAnnotations,
    unmatchedComments,
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, JSON.stringify(fixture, null, 2), 'utf8')
  console.log(JSON.stringify({
    output: outputPath,
    task: fixture.task,
    subtype: fixture.subtype,
    essayCharacters: essayText.length,
    essayWords: essayText.match(/[A-Za-z]+(?:[-'][A-Za-z]+)?/g)?.length || 0,
    matchedReferenceAnnotations: referenceAnnotations.length,
    unmatchedComments: unmatchedComments.length,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
