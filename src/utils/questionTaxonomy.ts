export const TASK2_SUBTYPES = [
  '同意与否/程度同意',
  '双边/讨论双方',
  '报告/回答两个问题',
  '优缺点/积极消极',
  '其他/待定',
] as const

const TASK2_SUBTYPE_ALIASES: Record<string, string> = {
  OPINION: '同意与否/程度同意',
  '程度同意': '同意与否/程度同意',
  '同意与否': '同意与否/程度同意',
  DISCUSSION: '双边/讨论双方',
  '双边': '双边/讨论双方',
  '讨论双方': '双边/讨论双方',
  REPORT_TWO_QUESTIONS: '报告/回答两个问题',
  REPORT: '报告/回答两个问题',
  '报告': '报告/回答两个问题',
  '回答两个问题': '报告/回答两个问题',
  ADVANTAGES_DISADVANTAGES: '优缺点/积极消极',
  '优缺点': '优缺点/积极消极',
  '积极消极': '优缺点/积极消极',
  '其优缺点': '优缺点/积极消极',
  '其他优缺点': '优缺点/积极消极',
}

export function normalizeTask2Subtype(subtype?: string | null) {
  if (!subtype) return subtype ?? null
  return TASK2_SUBTYPE_ALIASES[subtype] ?? subtype
}

export function normalizeQuestionSubtype(task?: string | null, subtype?: string | null) {
  return task === 'TASK2' ? normalizeTask2Subtype(subtype) : subtype ?? null
}

export function expandQuestionSubtypeFilter(task: string | undefined, subtype: string) {
  const canonical = normalizeQuestionSubtype(task, subtype) || subtype
  if (task !== 'TASK2') return [canonical]

  const aliases = Object.entries(TASK2_SUBTYPE_ALIASES)
    .filter(([, value]) => value === canonical)
    .map(([key]) => key)

  return [...new Set([canonical, ...aliases])]
}
