export interface KnowledgeChunk {
  id: string
  fileName: string
  title: string
  text: string
}

const FACTUAL = /多少钱|价格|价目|报价|什么价|怎么卖|贵不贵|地址|在哪|位置|营业|几点|开门|退款|怎么买|如何买|包含|课程|发货|运费/
const PURE_ACK = /^(收到|好的|嗯嗯|嗯|ok)$/iu

export function needsKnowledge(text: string): boolean {
  return FACTUAL.test(text.normalize('NFKC'))
}

/** 整句只是应一声。「好的，多少钱」不算。 */
export function isPureAck(text: string): boolean {
  const normalized = text.normalize('NFKC').trim().replace(/[。.!！~～\s]+$/u, '')
  return PURE_ACK.test(normalized)
}

export function chunkText(fileName: string, text: string): KnowledgeChunk[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim()
  if (!cleaned) return []

  const blocks = cleaned.split(/\n{2,}/u)
  const chunks: KnowledgeChunk[] = []
  let section = fileName
  blocks.forEach((block, index) => {
    const heading = /^(#{1,3})\s+(.+)$/u.exec(block.trim())
    if (heading && block.trim().split('\n').length === 1) {
      section = heading[2].trim()
      return
    }
    const body = block.trim()
    if (!body) return
    const pieces = splitLong(body, 400)
    pieces.forEach((piece, pieceIndex) => {
      chunks.push({
        id: `${fileName}:${index}:${pieceIndex}`,
        fileName,
        title: section || fileName,
        text: piece
      })
    })
  })
  return chunks
}

function splitLong(text: string, size: number): string[] {
  if (text.length <= size) return [text]
  const pieces: string[] = []
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size))
  return pieces
}

export function searchChunks(
  query: string,
  chunks: KnowledgeChunk[],
  limit = 3
): Array<KnowledgeChunk & { score: number }> {
  const queryGrams = bigrams(query)
  if (queryGrams.size === 0) return []
  const ranked = chunks
    .map((chunk) => ({ ...chunk, score: overlap(queryGrams, bigrams(chunk.title + chunk.text)) }))
    .filter((chunk) => chunk.score >= 0.12)
    .sort((a, b) => b.score - a.score)
  return ranked.slice(0, limit)
}

export function formatKnowledge(hits: Array<Pick<KnowledgeChunk, 'title' | 'fileName' | 'text'>>): string {
  if (hits.length === 0) return ''
  const body = hits
    .map((hit, index) => `### ${index + 1}. ${hit.title}（${hit.fileName}）\n${hit.text}`)
    .join('\n\n')
  return `以下是本机资料中命中的段落。事实只能来自这些段落和会话记录，资料里没有的价格、地址、承诺不要编。\n\n${body}`
}

function bigrams(text: string): Set<string> {
  const compact = text.normalize('NFKC').replace(/\s+/g, '')
  const grams = new Set<string>()
  for (let i = 0; i < compact.length - 1; i += 1) grams.add(compact.slice(i, i + 2))
  return grams
}

function overlap(query: Set<string>, doc: Set<string>): number {
  if (query.size === 0) return 0
  let hit = 0
  for (const gram of query) if (doc.has(gram)) hit += 1
  return hit / query.size
}
