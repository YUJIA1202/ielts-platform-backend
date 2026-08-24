import { createHash } from 'crypto'

export function normalizeCanonicalQuestion(value: string | null | undefined) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\*\*/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function canonicalQuestionHash(value: string | null | undefined) {
  const normalized = normalizeCanonicalQuestion(value)
  return normalized
    ? createHash('sha256').update(normalized, 'utf8').digest('hex')
    : null
}
