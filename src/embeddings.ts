import { Pool } from 'pg';
import { createHash } from 'crypto';
import {
  storeEmbedding,
  hasEmbedding,
  getUnembeddedDocuments,
  getUnembeddedEvents,
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

  // Process unembedded documents
  const docs = await getUnembeddedDocuments(pool, batchSize);
  for (const doc of docs) {
    try {
      const textToEmbed = `${doc.title}\n\n${doc.content}`;
      await embedAndStore(pool, config, 'document', doc.id, textToEmbed);
      processed++;
    } catch (err: unknown) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[the-quorum] Failed to embed document ${doc.id}: ${message}`);
    }
  }

  // Process unembedded events
  const events = await getUnembeddedEvents(pool, batchSize);
  for (const event of events) {
    try {
      const textToEmbed = `[${event.event_type}] ${event.title}\n\n${event.description}`;
      await embedAndStore(pool, config, 'event', event.id, textToEmbed);
      processed++;
    } catch (err: unknown) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[the-quorum] Failed to embed event ${event.id}: ${message}`);
    }
  }

  return { processed, errors };
}
