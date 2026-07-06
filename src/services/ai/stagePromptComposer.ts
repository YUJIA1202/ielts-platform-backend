import { PreprocessedEssay, RagChunk } from './types'

export function composeGlobalStagePrompt(input: {
  questionText: string | null
  essay: PreprocessedEssay
  evidence: RagChunk[]
}) {
  return `Analyze the IELTS essay globally. Do not assign a band score. Return JSON only.
The category field must be exactly one of: TASK_RESPONSE, STRUCTURE, LOGIC, LANGUAGE, VOCABULARY, GRAMMAR.

Question:\n${input.questionText || '(not provided)'}

Essay:\n${input.essay.normalizedEssay}

Evidence:\n${formatEvidence(input.evidence)}

Return: {"summary":"Chinese summary","priorityAdvice":"Chinese advice","taskFulfilment":"...","positionAndThesis":"...","organization":"...","argumentDevelopment":"...","strengths":[],"priorityProblems":[{"category":"TASK_RESPONSE","severity":"MEDIUM","explanation":"...","suggestion":"..."}],"paragraphRoles":[{"paragraphIndex":1,"intendedRole":"...","effectiveness":"..."}]}`
}

export function composeParagraphStagePrompt(input: {
  questionText: string | null
  essay: PreprocessedEssay
  paragraphIndexes: number[]
  globalAnalysis: unknown
  evidence: RagChunk[]
}) {
  const exampleParagraphIndex = input.paragraphIndexes[0]
  const paragraphs = input.essay.paragraphs
    .filter(paragraph => input.paragraphIndexes.includes(paragraph.index))
    .map(paragraph => `[P${paragraph.index}] ${paragraph.text}`).join('\n\n')
  return `Analyze the selected IELTS essay paragraphs. Return JSON only. Keep paragraphIndex exact.
Write all user-facing analysis and findings in Chinese; preserve quoted English source text when necessary.
Each finding category must be exactly one of: TASK_RESPONSE, STRUCTURE, LOGIC, LANGUAGE, VOCABULARY, GRAMMAR.

Question:\n${input.questionText || '(not provided)'}
Global analysis:\n${JSON.stringify(input.globalAnalysis)}
Paragraphs:\n${paragraphs}
Evidence:\n${formatEvidence(input.evidence)}

Only use these paragraph indexes: ${input.paragraphIndexes.join(', ')}.
Return: {"paragraphs":[{"paragraphIndex":${exampleParagraphIndex},"function":"中文说明","topicSentence":"中文说明","development":"中文说明","cohesion":"中文说明","relationToQuestion":"中文说明","findings":[{"category":"LOGIC","severity":"MEDIUM","explanation":"中文说明","suggestion":"中文建议"}],"revisedParagraph":null}]}`
}

export function composeSentenceStagePrompt(input: {
  essay: PreprocessedEssay
  sentenceIndexes: number[]
  globalAnalysis: unknown
  paragraphAnalyses: unknown
  evidence: RagChunk[]
}) {
  const exampleSentence = input.essay.sentences.find(sentence => sentence.index === input.sentenceIndexes[0])
  const exampleSentenceIndex = exampleSentence?.index || input.sentenceIndexes[0]
  const exampleParagraphIndex = exampleSentence?.paragraphIndex || 1
  const sentences = input.essay.sentences
    .filter(sentence => input.sentenceIndexes.includes(sentence.index))
    .map(sentence => `[S${sentence.index}/P${sentence.paragraphIndex}] ${sentence.text}`).join('\n')
  return `Identify every genuine problematic word, phrase, sentence, or local logic issue in the selected sentences. Return JSON only.
For WORD and PHRASE issues, anchorText must be an exact substring. Never invent offsets.
Only use these sentence indexes: ${input.sentenceIndexes.join(', ')}. Do not copy indexes from earlier batches.
issueType must be exactly one of: GRAMMAR, VOCABULARY, LOGIC, COHESION, TASK_RESPONSE, STRUCTURE, STYLE.

Global analysis:\n${JSON.stringify(input.globalAnalysis)}
Paragraph analyses:\n${JSON.stringify(input.paragraphAnalyses)}
Sentences:\n${sentences}
Evidence:\n${formatEvidence(input.evidence)}

Return: {"sentenceIndexes":[${input.sentenceIndexes.join(',')}],"annotations":[{"paragraphIndex":${exampleParagraphIndex},"sentenceIndex":${exampleSentenceIndex},"level":"PHRASE","originalText":"full sentence","anchorText":"exact phrase","occurrence":1,"issueType":"GRAMMAR","severity":"MEDIUM","explanation":"Chinese explanation","suggestion":"...","replacementText":"...","rubricDimension":"GRAMMAR_RANGE_ACCURACY"}],"rewrites":[{"paragraphIndex":${exampleParagraphIndex},"sentenceIndex":${exampleSentenceIndex},"level":"SENTENCE","operation":"REPLACE","anchorText":"full original sentence","occurrence":1,"originalText":"...","rewrittenText":"...","reason":"..."}]}`
}

export function composeVerifierStagePrompt(input: { essay: PreprocessedEssay; draft: unknown }) {
  return `Verify this IELTS feedback draft against the original essay. Reject false, duplicate, misplaced, or meaning-changing feedback. Return JSON only.
All annotation indexes are zero-based indexes in the draft sentenceAnnotations array. accepted must be a JSON boolean, never a string.

Essay:\n${input.essay.normalizedEssay}
Draft:\n${JSON.stringify(input.draft)}

Return: {"accepted":true,"missedIssues":[],"rejectedAnnotationIndexes":[],"duplicateAnnotationGroups":[],"contradictoryFindings":[],"revisionProblems":[],"repairInstructions":[]}`
}

export function composeRepairStagePrompt(input: { essay: PreprocessedEssay; draft: unknown; verification: unknown }) {
  return `Repair the IELTS feedback draft using only the verifier decisions. Return the complete corrected review JSON. Do not add a band score or hidden reasoning.

Essay:\n${input.essay.normalizedEssay}
Draft:\n${JSON.stringify(input.draft)}
Verification:\n${JSON.stringify(input.verification)}

Return the complete object with overallBand, summary, priorityAdvice, scores, globalFindings, sentenceAnnotations, and rewrites.`
}

function formatEvidence(chunks: RagChunk[]) {
  if (!chunks.length) return '(none)'
  return chunks.map((chunk, index) => `[E${index + 1}] ${chunk.sourceType}/${chunk.chunkType}\n${chunk.chunkText.slice(0, 1400)}`).join('\n\n')
}
