import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { chunkText, type KnowledgeChunk } from './search'

const MAX_BYTES = 10 * 1024 * 1024

export async function readKnowledgeFile(filePath: string): Promise<{ fileName: string; chunks: KnowledgeChunk[] }> {
  const info = await stat(filePath)
  if (info.size > MAX_BYTES) {
    throw new Error('文件超过 10MB')
  }
  const fileName = path.basename(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const text = await readText(filePath, ext)
  return { fileName, chunks: chunkText(fileName, text) }
}

async function readText(filePath: string, ext: string): Promise<string> {
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    return readFile(filePath, 'utf8')
  }
  if (ext === '.pdf') {
    const { extractText } = await import('unpdf')
    const data = new Uint8Array(await readFile(filePath))
    const result = await extractText(data, { mergePages: true })
    return result.text
  }
  throw new Error('只支持 Markdown、TXT 和 PDF')
}
