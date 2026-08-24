import assert from 'node:assert/strict'
import { AiAnnotationLevel, AiIssueSeverity, AiIssueType } from '@prisma/client'
import { preprocessEssay } from '../src/services/ai/preprocessor'
import { validateReviewOutput } from '../src/services/ai/reviewValidator'
import { buildReviewStagePlan } from '../src/services/ai/stagePlanner'
import { validateRepairOutput, validateVerification } from '../src/services/ai/multiStageReviewPipeline'

const essay = preprocessEssay({
  task: 'TASK2',
  questionText: 'Discuss both views and give your own opinion.',
  essayText: [
    'People believe competition is useful, but some people believes cooperation is better.',
    'This idea needs development. It also needs evidence.',
    'In conclusion, cooperation is generally more useful.',
  ].join('\n\n'),
})

const output = validateReviewOutput({
  overallBand: null,
  summary: 'test',
  priorityAdvice: 'test',
  scores: [{
    dimension: 'CC',
    score: null,
    rationale: 'alias normalization test',
  }],
  globalFindings: [],
  sentenceAnnotations: [
    {
      paragraphIndex: 1,
      sentenceIndex: 1,
      level: AiAnnotationLevel.PHRASE,
      originalText: essay.sentences[0].text,
      anchorText: 'people believes',
      occurrence: 1,
      issueType: AiIssueType.GRAMMAR,
      severity: AiIssueSeverity.MEDIUM,
      explanation: 'subject-verb agreement',
      replacementText: 'people believe',
      rubricDimension: 'GRAMMATICAL_RANGE_AND_ACCURACY',
    },
    {
      paragraphIndex: 2,
      sentenceIndex: 3,
      level: AiAnnotationLevel.WORD,
      originalText: essay.sentences[2].text,
      anchorText: 'needs',
      occurrence: 1,
      issueType: AiIssueType.STYLE,
      severity: AiIssueSeverity.LOW,
      explanation: 'test repeated-word positioning',
    },
  ],
  rewrites: [],
}, essay)

assert.equal(output.scores[0].dimension, 'COHERENCE_COHESION')
assert.equal(output.sentenceAnnotations[0].rubricDimension, 'GRAMMAR_RANGE_ACCURACY')

for (const annotation of output.sentenceAnnotations) {
  assert.equal(annotation.locationStatus, 'RESOLVED')
  assert.notEqual(annotation.startOffset, null)
  assert.notEqual(annotation.endOffset, null)
  assert.equal(
    essay.normalizedEssay.slice(annotation.startOffset!, annotation.endOffset!),
    annotation.anchorText,
  )
}

const plan = buildReviewStagePlan(essay, { paragraphBatchSize: 2, sentenceBatchSize: 3 })
assert.deepEqual(plan.paragraphBatches.map(batch => batch.targetIndexes), [[1, 2], [3]])
assert.deepEqual(plan.sentenceBatches.map(batch => batch.targetIndexes), [[1, 2, 3], [4]])

assert.throws(() => validateVerification({
  accepted: 'false',
  missedIssues: [],
  rejectedAnnotationIndexes: [],
  duplicateAnnotationGroups: [],
  contradictoryFindings: [],
  revisionProblems: [],
  repairInstructions: [],
}, 2), /accepted must be a boolean/)

assert.throws(() => validateVerification({
  accepted: false,
  missedIssues: [],
  rejectedAnnotationIndexes: [2],
  duplicateAnnotationGroups: [],
  contradictoryFindings: [],
  revisionProblems: [],
  repairInstructions: [],
}, 2), /out-of-range index/)

const repeatedEssay = preprocessEssay({ essayText: 'Practice helps, and practice builds confidence.' })
const repeatedReview = validateReviewOutput({
  overallBand: null,
  summary: 'test',
  scores: [],
  globalFindings: [],
  sentenceAnnotations: [],
  rewrites: [{
    sentenceIndex: 1,
    level: 'WORD',
    operation: 'REPLACE',
    anchorText: 'practice',
    occurrence: 2,
    originalText: 'practice',
    rewrittenText: 'repetition',
  }, {
    sentenceIndex: 1,
    level: 'PHRASE',
    operation: 'INSERT',
    anchorText: 'confidence',
    occurrence: 1,
    originalText: 'confidence',
    rewrittenText: ' over time',
  }],
}, repeatedEssay)
assert.equal(
  repeatedEssay.normalizedEssay.slice(
    repeatedReview.rewrites[0].startOffset!,
    repeatedReview.rewrites[0].endOffset!,
  ).toLowerCase(),
  'practice',
)
assert.equal(repeatedReview.rewrites[1].startOffset, repeatedReview.rewrites[1].endOffset)

const coverageRewrites = essay.sentences.flatMap(sentence =>
  ['LANGUAGE', 'COHERENCE', 'TASK'].map(rewriteLayer => ({
    paragraphIndex: sentence.paragraphIndex,
    sentenceIndex: sentence.index,
    level: 'SENTENCE',
    rewriteLayer,
    operation: 'REPLACE',
    anchorText: sentence.text,
    occurrence: 1,
    originalText: sentence.text,
    rewrittenText: sentence.text,
    reason: 'Pipeline coverage fixture.',
  })),
)

assert.throws(() => validateRepairOutput({
  ...output,
  sentenceAnnotations: output.sentenceAnnotations.slice(0, 1),
  rewrites: coverageRewrites,
}, essay, output), /retained only 1\/2 verified annotations/)

console.log(JSON.stringify({
  paragraphCount: essay.paragraphs.length,
  sentenceCount: essay.sentences.length,
  resolvedAnnotations: output.sentenceAnnotations.length,
  paragraphBatches: plan.paragraphBatches.map(batch => batch.targetIndexes),
  sentenceBatches: plan.sentenceBatches.map(batch => batch.targetIndexes),
}, null, 2))
