import prisma from '../src/prisma'

async function main() {
  const rows = await prisma.knowledgeChunk.findMany({
    select: { id: true, chunkText: true, tokenCount: true, chunkType: true },
    orderBy: { id: 'asc' },
  })
  const sortedByCharacters = [...rows].sort((a, b) => b.chunkText.length - a.chunkText.length)
  const overStoredTokenLimit = rows.filter(row => (row.tokenCount || 0) > 3072)
  console.log(JSON.stringify({
    totalChunks: rows.length,
    maxCharacters: sortedByCharacters[0]?.chunkText.length || 0,
    averageCharacters: rows.length
      ? Math.round(rows.reduce((sum, row) => sum + row.chunkText.length, 0) / rows.length)
      : 0,
    maxEstimatedTokens: Math.max(0, ...rows.map(row => row.tokenCount || 0)),
    over3072EstimatedTokens: overStoredTokenLimit.length,
    longestChunks: sortedByCharacters.slice(0, 10).map(row => ({
      id: row.id,
      chunkType: row.chunkType,
      characters: row.chunkText.length,
      estimatedTokens: row.tokenCount,
    })),
  }, null, 2))
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
