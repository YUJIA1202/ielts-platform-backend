import { ComposePromptInput } from './types'

export const AI_REVIEW_PROMPT_VERSION = 'ai-review-mvp-v1'

export function composeReviewPrompt(input: ComposePromptInput): string {
  const sentences = input.preprocessed.sentences
    .map(sentence => `${sentence.index}. ${sentence.text}`)
    .join('\n')

  const rag = input.ragChunks.length
    ? input.ragChunks
        .map((chunk, index) => `[RAG ${index + 1}] ${chunk.chunkType} ${chunk.task || ''} ${chunk.subtype || ''}\n${chunk.chunkText}`)
        .join('\n\n')
    : 'No retrieval chunks were found. Use IELTS writing assessment principles.'

  return `
You are an IELTS Writing examiner and writing coach.
Assess the essay according to IELTS Writing criteria, but produce coaching feedback that helps the learner revise.

Rules:
- Return JSON only. Do not wrap it in markdown.
- Use the exact enum values shown in the schema.
- Every sentence annotation must reference a sentenceIndex from the numbered sentences.
- Do not invent content not present in the essay.
- Use concise Chinese explanations for feedback, with English rewrites.
- Scores must be between 0 and 9 and can use .5.

Question:
${input.questionText || '(No question text provided)'}

Detected metadata:
- task: ${input.preprocessed.detectedTask || 'unknown'}
- subtype: ${input.preprocessed.detectedSubtype || 'unknown'}
- wordCount: ${input.preprocessed.wordCount}

Numbered essay sentences:
${sentences || input.essayText}

Relevant retrieved material:
${rag}

Required JSON shape:
{
  "overallBand": 6.5,
  "summary": "中文总体评价",
  "priorityAdvice": "最优先的改进建议",
  "scores": [
    {"dimension":"OVERALL","score":6.5,"rationale":"...","evidence":"..."},
    {"dimension":"TASK_RESPONSE","score":6.0,"rationale":"...","evidence":"..."},
    {"dimension":"COHERENCE_COHESION","score":6.0,"rationale":"...","evidence":"..."},
    {"dimension":"LEXICAL_RESOURCE","score":6.0,"rationale":"...","evidence":"..."},
    {"dimension":"GRAMMAR_RANGE_ACCURACY","score":6.0,"rationale":"...","evidence":"..."}
  ],
  "globalFindings": [
    {"category":"TASK_RESPONSE","severity":"MEDIUM","title":"...","explanation":"...","suggestion":"..."}
  ],
  "sentenceAnnotations": [
    {"sentenceIndex":1,"originalText":"...","issueType":"LOGIC","subtype":"development","severity":"MEDIUM","explanation":"...","suggestion":"...","rubricDimension":"TASK_RESPONSE"}
  ],
  "rewrites": [
    {"sentenceIndex":1,"originalText":"...","rewrittenText":"...","reason":"..."}
  ]
}
`.trim()
}
