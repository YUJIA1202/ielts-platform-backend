import 'dotenv/config'
import bcrypt from 'bcryptjs'
import prisma from '../src/prisma'
import { createAndRunAiReview } from '../src/services/ai/aiReviewService'

const QUESTION_SOURCE_KEY = 'ai-review-experiment:houses-style-discussion'
const TEST_PHONE = '18800000001'
const TEST_USERNAME = 'AI批改实验账户'

const questionText = `Some people think that new houses should be built in the same style as older houses in the local area. Others disagree and say that local authorities should allow people to build houses in the styles of their own choice.
Discuss both views and give your opinion.`

const essayText = `People show different opinions on constructing buildings in the communities.From my perspective, I reckon that the unity makes the city in more great order. So we should not build the construcions with just our own thoughts.

On the one hand, preserving the architectural uniformity of a local area can obviously contribute to a sense of cohesion and historical continuity. When new houses are built in harmony with older structures, it maintains the character and charm of the neighborhood, which can be highly praised by residents and visitors. This approach also prevents the disruption of the existing urban landscape, ensuring that the area retains its unique identity over time. Moreover, this strategy tends to boost property values and strengthens community bonds, as residents share a collective pride in their surroundings.

On the other hand, proponents of architectural diversity argue that embracing varied styles enhances cultural richness and community identity. By celebrating different architectural traditions and accommodating evolving societal tastes, neighborhoods can reflect a vibrant tapestry of cultural heritage. For instance, allowing homeowners to customize their residences fosters innovation and personal expression, fostering a deeper sense of attachment and pride within the community. This inclusivity encourages a dynamic urban environment where diversity thrives without compromising historical integrity.

In conclusion, while preserving architectural consistency is important for maintaining a community's historical integrity, allowing some diversity in housing styles encourages innovation and individuality. A balance between these two perspectives, achieved through careful planning and dialogue, can ensure that new developments enhance the overall quality of life in the area.`

async function main() {
  const password = process.env.AI_EXPERIMENT_PASSWORD
  if (!password) throw new Error('AI_EXPERIMENT_PASSWORD is required')
  const passwordHash = await bcrypt.hash(password, 10)
  const user = await prisma.user.upsert({
    where: { phone: TEST_PHONE },
    create: {
      phone: TEST_PHONE,
      username: TEST_USERNAME,
      password: passwordHash,
      role: 'USER',
    },
    update: {
      username: TEST_USERNAME,
      password: passwordHash,
      banned: false,
    },
    select: { id: true, phone: true, username: true },
  })
  const question = await prisma.question.upsert({
    where: { sourceKey: QUESTION_SOURCE_KEY },
    create: {
      task: 'TASK2',
      subtype: '双边/讨论双方',
      topic: '建筑与城市规划',
      topicCategory: '社会与政府',
      topicSubcategory: '建筑风格；地方规划；个人选择',
      content: questionText,
      source: 'AI_REVIEW_EXPERIMENT',
      sourceKey: QUESTION_SOURCE_KEY,
    },
    update: {
      subtype: '双边/讨论双方',
      topic: '建筑与城市规划',
      topicCategory: '社会与政府',
      topicSubcategory: '建筑风格；地方规划；个人选择',
      content: questionText,
    },
    select: { id: true, content: true },
  })

  const result = await createAndRunAiReview({
    userId: user.id,
    questionId: question.id,
    task: 'TASK2',
    subtype: '双边/讨论双方',
    topic: '建筑与城市规划',
    questionText,
    essayText,
  })
  const retrievalEvents = await prisma.retrievalEvent.findMany({
    where: { jobId: result.jobId },
    include: {
      chunks: {
        where: { usedInPrompt: true },
        include: { chunk: { include: { document: { include: { source: true } } } } },
      },
    },
  })
  const strategies = Array.from(new Set(retrievalEvents.map(event => event.strategy)))
  const evidenceSources = retrievalEvents.flatMap(event => event.chunks).reduce<Record<string, number>>((counts, hit) => {
    const key = hit.chunk.document.source.sourceType
    counts[key] = (counts[key] || 0) + 1
    return counts
  }, {})

  console.log(JSON.stringify({
    login: {
      phone: user.phone,
      password: '(configured locally; not printed)',
    },
    userId: user.id,
    questionId: question.id,
    requestId: result.requestId,
    jobId: result.jobId,
    reviewId: result.review.id,
    overallBand: result.review.overallBand,
    scores: result.review.scores.map(score => ({ dimension: score.dimension, score: score.score })),
    findings: result.review.findings.length,
    annotations: result.review.annotations.length,
    resolvedAnnotations: result.review.annotations.filter(annotation => annotation.locationStatus === 'RESOLVED').length,
    rewrites: result.review.rewrites.length,
    retrievalEvents: retrievalEvents.length,
    retrievalStrategies: strategies,
    evidenceSources,
    frontendPath: `/dashboard/ai-review-demo/${result.review.id}`,
  }, null, 2))
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
