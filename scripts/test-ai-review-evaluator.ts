import assert from 'node:assert/strict'
import {
  AiAnnotationLevel,
  AiIssueSeverity,
  AiIssueType,
  AiRevisionOperation,
  AiReviewScoreDimension,
} from '@prisma/client'
import { preprocessEssay } from '../src/services/ai/preprocessor'
import { evaluateReviewOutput } from '../src/services/ai/reviewEvaluator'
import { validateReviewOutput } from '../src/services/ai/reviewValidator'

const essay = preprocessEssay({
  task: 'TASK2',
  essayText: 'Many people believes money brings happiness. However, this claim needs evidence.',
})

const review = validateReviewOutput({
  overallBand: 6,
  summary: 'The position is visible but language accuracy and support need improvement.',
  priorityAdvice: 'Correct agreement errors and support each claim.',
  scores: Object.values(AiReviewScoreDimension)
    .filter(dimension => dimension !== AiReviewScoreDimension.OVERALL)
    .map(dimension => ({ dimension, score: 6, rationale: 'Test rationale.' })),
  globalFindings: [],
  sentenceAnnotations: [{
    sentenceIndex: 1,
    paragraphIndex: 1,
    level: AiAnnotationLevel.PHRASE,
    originalText: essay.sentences[0].text,
    anchorText: 'people believes',
    issueType: AiIssueType.GRAMMAR,
    severity: AiIssueSeverity.HIGH,
    explanation: 'The plural subject requires the base verb.',
    replacementText: 'people believe',
  }],
  rewrites: [{
    sentenceIndex: 1,
    paragraphIndex: 1,
    level: AiAnnotationLevel.PHRASE,
    operation: AiRevisionOperation.REPLACE,
    originalText: 'people believes',
    anchorText: 'people believes',
    rewrittenText: 'people believe',
  }],
}, essay)

const annotation = review.sentenceAnnotations[0]
const report = evaluateReviewOutput({
  essay,
  review,
  referenceAnnotations: [{
    startOffset: annotation.startOffset!,
    endOffset: annotation.endOffset!,
    issueType: AiIssueType.GRAMMAR,
  }],
})

assert.equal(report.structure.scoreDimensionCompleteness, 1)
assert.equal(report.annotations.locationResolutionRate, 1)
assert.equal(report.annotations.exactLocationIntegrityRate, 1)
assert.equal(report.annotations.duplicateCount, 0)
assert.equal(report.rewrites.locationRate, 1)
assert.equal(report.reference?.precision, 1)
assert.equal(report.reference?.recall, 1)
assert.equal(report.reference?.f1, 1)
assert.deepEqual(report.warnings, [])

console.log(JSON.stringify(report, null, 2))
