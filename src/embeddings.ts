import { Pool } from 'pg';
import { createHash } from 'crypto';
import {
  storeEmbedding,
  hasEmbedding,
  getUnembeddedDocuments,
  getUnembeddedEvents,
  deleteEmbeddingsForRef,
  hasAnyEmbeddingForRef,
} from './db.js';

export interface EmbeddingConfig {
  ollama_host: string;
  ollama_embed_model: string;
  embedding_dim: number;
}

/**
 * Generate an embedding vector for a text string using Ollama.
 */
export async function embedText(text: string, config: EmbeddingConfig): Promise<number[]> {
  const resp = await fetch(`${config.ollama_host}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama_embed_model,
      input: text,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(
      `Ollama embedding request failed (${resp.status} ${resp.statusText}): ${body}`
    );
  }

  const data = (await resp.json()) as { embeddings: number[][] };

  if (!data.embeddings || !data.embeddings[0]) {
    throw new Error('Ollama returned empty embeddings response');
  }

  return data.embeddings[0];
}

/**
 * Compute a SHA-256 hash for content to detect changes.
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface TextChunk {
  text: string;
  chunkIndex: number;
}

/**
 * Split text into chunks of approximately `chunkSize` characters with `overlap` characters
 * of overlap between consecutive chunks. Splits prefer sentence and paragraph boundaries
 * so that chunks don't cut mid-word.
 */
export function chunkText(
  text: string,
  chunkSize: number = 500,
  overlap: number = 50
): TextChunk[] {
  if (!text || text.length === 0) {
    return [];
  }

  // If the text fits in a single chunk, return it as-is
  if (text.length <= chunkSize) {
    return [{ text, chunkIndex: 0 }];
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    // If we're not at the end of the text, try to find a good break point
    if (end < text.length) {
      // Look backward from 'end' for a sentence-ending boundary (.!? followed by whitespace)
      // Search within the last 20% of the chunk to avoid making chunks too small
      const searchStart = Math.max(start + Math.floor(chunkSize * 0.8), start);
      let bestBreak = -1;

      // First, try to break at a paragraph boundary (double newline)
      const paragraphBreak = text.lastIndexOf('\n\n', end);
      if (paragraphBreak > searchStart) {
        bestBreak = paragraphBreak + 2; // include the double newline in current chunk
      }

      // If no paragraph break, try a sentence-ending boundary
      if (bestBreak === -1) {
        for (let i = end - 1; i >= searchStart; i--) {
          const ch = text[i];
          if ((ch === '.' || ch === '!' || ch === '?') && i + 1 < text.length) {
            const next = text[i + 1];
            if (next === ' ' || next === '\n' || next === '\r' || next === '\t') {
              bestBreak = i + 1; // break after the punctuation
              break;
            }
          }
        }
      }

      // If no sentence break, try a newline
      if (bestBreak === -1) {
        const newlineBreak = text.lastIndexOf('\n', end);
        if (newlineBreak > searchStart) {
          bestBreak = newlineBreak + 1;
        }
      }

      // If no newline, try a space (to avoid cutting mid-word)
      if (bestBreak === -1) {
        const spaceBreak = text.lastIndexOf(' ', end);
        if (spaceBreak > searchStart) {
          bestBreak = spaceBreak + 1;
        }
      }

      // Use the best break point if found, otherwise just cut at chunkSize
      if (bestBreak !== -1) {
        end = bestBreak;
      }
    }

    const chunkContent = text.slice(start, end).trim();
    if (chunkContent.length > 0) {
      chunks.push({ text: chunkContent, chunkIndex });
      chunkIndex++;
    }

    // Move start forward, applying overlap
    // The next chunk starts (end - overlap) characters into the text
    const nextStart = end - overlap;
    // But don't go backward
    start = Math.max(nextStart, start + 1);
  }

  return chunks;
}

/**
 * Embed a piece of content and store it, linked to a reference (document or event).
 * Skips if the content hash hasn't changed since last embedding.
 */
export async function embedAndStore(
  pool: Pool,
  config: EmbeddingConfig,
  refType: string,
  refId: string,
  text: string
): Promise<{ embedded: boolean; content_hash: string }> {
  const hash = contentHash(text);

  // Check if we already have a current embedding
  const exists = await hasEmbedding(pool, refType, refId, hash);
  if (exists) {
    return { embedded: false, content_hash: hash };
  }

  const embedding = await embedText(text, config);

  await storeEmbedding(pool, {
    ref_type: refType,
    ref_id: refId,
    embedding,
    content_hash: hash,
  });

  return { embedded: true, content_hash: hash };
}

/**
 * Embed a piece of content using text chunking and store each chunk as a separate
 * embedding row. For short texts (under chunkSize), behaves the same as embedAndStore.
 * For long texts, splits into overlapping chunks and stores each one with a
 * ref_type of '{baseRefType}_chunk_{N}' (e.g., 'document_chunk_0', 'document_chunk_1').
 *
 * Uses a content hash to skip re-embedding when content hasn't changed.
 */
export async function embedAndStoreChunked(
  pool: Pool,
  config: EmbeddingConfig,
  refType: string,
  refId: string,
  text: string,
  chunkSize: number = 500,
  overlap: number = 50
): Promise<{ embedded: boolean; content_hash: string; chunks_stored: number }> {
  const hash = contentHash(text);

  // Check if we already have an embedding for this content hash (any chunk)
  const exists = await hasAnyEmbeddingForRef(pool, refType, refId, hash);
  if (exists) {
    return { embedded: false, content_hash: hash, chunks_stored: 0 };
  }

  // If text is short enough, just use the simple single-embedding path
  if (text.length <= chunkSize) {
    const result = await embedAndStore(pool, config, refType, refId, text);
    return { ...result, chunks_stored: result.embedded ? 1 : 0 };
  }

  // Delete any existing embeddings for this ref (base + old chunks)
  await deleteEmbeddingsForRef(pool, refType, refId);

  // Chunk the text
  const chunks = chunkText(text, chunkSize, overlap);

  // Embed and store each chunk
  let chunksStored = 0;
  for (const chunk of chunks) {
    const chunkRefType = `${refType}_chunk_${chunk.chunkIndex}`;
    const embedding = await embedText(chunk.text, config);

    await storeEmbedding(pool, {
      ref_type: chunkRefType,
      ref_id: refId,
      embedding,
      content_hash: hash,
    });
    chunksStored++;
  }

  return { embedded: true, content_hash: hash, chunks_stored: chunksStored };
}

/**
 * Check if the Ollama embedding service is reachable and the model is available.
 */
export async function checkOllamaHealth(config: EmbeddingConfig): Promise<{
  reachable: boolean;
  model_available: boolean;
  error?: string;
}> {
  try {
    // Check if Ollama is reachable
    const healthResp = await fetch(`${config.ollama_host}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!healthResp.ok) {
      return { reachable: false, model_available: false, error: `HTTP ${healthResp.status}` };
    }

    const tagsData = (await healthResp.json()) as { models?: Array<{ name: string }> };
    const models = tagsData.models ?? [];
    const modelFound = models.some(
      (m) => m.name === config.ollama_embed_model || m.name.startsWith(`${config.ollama_embed_model}:`)
    );

    return { reachable: true, model_available: modelFound };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { reachable: false, model_available: false, error: message };
  }
}

/**
 * Process the embedding backlog: find documents and events without embeddings and embed them.
 * Returns count of newly embedded items.
 */
export async function processEmbeddingQueue(
  pool: Pool,
  config: EmbeddingConfig,
  batchSize: number = 20
): Promise<{ processed: number; errors: number }> {
  let processed = 0;
  let errors = 0;

  // Process unembedded documents (uses chunking for long content)
  const docs = await getUnembeddedDocuments(pool, batchSize);
  for (const doc of docs) {
    try {
      const textToEmbed = `${doc.title}\n\n${doc.content}`;
      await embedAndStoreChunked(pool, config, 'document', doc.id, textToEmbed);
      processed++;
    } catch (err: unknown) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[the-quorum] Failed to embed document ${doc.id}: ${message}`);
    }
  }

  // Process unembedded events (uses chunking for long content)
  const events = await getUnembeddedEvents(pool, batchSize);
  for (const event of events) {
    try {
      const textToEmbed = `[${event.event_type}] ${event.title}\n\n${event.description}`;
      await embedAndStoreChunked(pool, config, 'event', event.id, textToEmbed);
      processed++;
    } catch (err: unknown) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[the-quorum] Failed to embed event ${event.id}: ${message}`);
    }
  }

  return { processed, errors };
}
