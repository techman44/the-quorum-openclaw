import { Pool } from 'pg';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureSchema, getStats } from './db.js';
import { processEmbeddingQueue, checkOllamaHealth, type EmbeddingConfig } from './embeddings.js';
import { registerTools, type QuorumConfig } from './tools.js';

let pool: Pool | null = null;

function getPool(config: QuorumConfig): Pool {
  if (!pool) {
    pool = new Pool({
      host: config.db_host,
      port: config.db_port,
      user: config.db_user,
      password: config.db_password,
      database: config.db_name,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('[the-quorum] Unexpected pool error:', err.message);
    });
  }
  return pool;
}

function buildConfig(apiConfig: Record<string, unknown> | undefined, pluginDir: string): QuorumConfig {
  const inboxRaw = (apiConfig?.inbox_dir as string) ?? 'data/inbox';
  const processedRaw = (apiConfig?.processed_dir as string) ?? 'data/processed';

  return {
    db_host: (apiConfig?.db_host as string) ?? 'localhost',
    db_port: (apiConfig?.db_port as number) ?? 5432,
    db_user: (apiConfig?.db_user as string) ?? 'quorum',
    db_password: (apiConfig?.db_password as string) ?? '',
    db_name: (apiConfig?.db_name as string) ?? 'quorum',
    ollama_host: (apiConfig?.ollama_host as string) ?? 'http://localhost:11434',
    ollama_embed_model: (apiConfig?.ollama_embed_model as string) ?? 'mxbai-embed-large',
    embedding_dim: (apiConfig?.embedding_dim as number) ?? 1024,
    inbox_dir: resolve(pluginDir, inboxRaw),
    processed_dir: resolve(pluginDir, processedRaw),
  };
}

export default function register(api: any): void {
  const pluginDir = api.pluginDir ?? process.cwd();
  const config = buildConfig(api.config, pluginDir);
  const db = getPool(config);
  const embedConfig: EmbeddingConfig = {
    ollama_host: config.ollama_host,
    ollama_embed_model: config.ollama_embed_model,
    embedding_dim: config.embedding_dim,
  };

  // ─── Register Agent Tools ────────────────────────────────────────────────

  registerTools(api, db, config);

  // ─── Register CLI Commands ───────────────────────────────────────────────

  api.registerCommand({
    name: 'quorum',
    description: 'The Quorum memory management commands',
    subcommands: {
      status: {
        description: 'Show Quorum system status and statistics',
        handler: async () => {
          try {
            const stats = await getStats(db);
            const ollamaHealth = await checkOllamaHealth(embedConfig);

            const lines = [
              '=== The Quorum - Status ===',
              '',
              `Database:    ${config.db_host}:${config.db_port}/${config.db_name}`,
              `Ollama:      ${config.ollama_host} (model: ${config.ollama_embed_model})`,
              `  Reachable: ${ollamaHealth.reachable ? 'yes' : 'no'}`,
              `  Model OK:  ${ollamaHealth.model_available ? 'yes' : 'no'}`,
              ollamaHealth.error ? `  Error:     ${ollamaHealth.error}` : null,
              '',
              '--- Memory Stats ---',
              `Documents:     ${stats.documents}`,
              `Events:        ${stats.events}`,
              `Tasks:         ${stats.tasks}`,
              `Embeddings:    ${stats.embeddings}`,
              `Unembedded:    ${stats.unembedded_documents} docs, ${stats.unembedded_events} events`,
            ];

            console.log(lines.filter((l) => l !== null).join('\n'));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Error: ${message}`);
            console.error('Is the database running and configured correctly?');
          }
        },
      },

      search: {
        description: 'Search the Quorum memory database',
        args: [
          {
            name: 'query',
            description: 'Search query text',
            required: true,
          },
          {
            name: '--limit',
            description: 'Max results (default: 10)',
            required: false,
          },
          {
            name: '--type',
            description: 'Filter by ref type: document, event, or all',
            required: false,
          },
        ],
        handler: async (args: { query: string; limit?: string; type?: string }) => {
          try {
            const { embedText } = await import('./embeddings.js');
            const { semanticSearch, semanticSearchEvents, searchDocumentsByText } = await import('./db.js');

            const limit = args.limit ? parseInt(args.limit, 10) : 10;
            const refType = args.type ?? 'all';

            let usedSemantic = false;
            const results: Array<{
              id: string;
              type: string;
              title: string;
              score: number | null;
              preview: string;
            }> = [];

            try {
              const queryEmbedding = await embedText(args.query, embedConfig);
              usedSemantic = true;

              if (refType === 'all' || refType === 'document') {
                const docs = await semanticSearch(db, queryEmbedding, { limit });
                for (const d of docs) {
                  results.push({
                    id: d.id,
                    type: d.doc_type,
                    title: d.title,
                    score: Number(d.score),
                    preview: d.content.slice(0, 120),
                  });
                }
              }

              if (refType === 'all' || refType === 'event') {
                const events = await semanticSearchEvents(db, queryEmbedding, { limit });
                for (const e of events) {
                  results.push({
                    id: e.id,
                    type: e.event_type,
                    title: e.title,
                    score: Number(e.score),
                    preview: e.description.slice(0, 120),
                  });
                }
              }

              results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
            } catch {
              // Fallback to text search
              const docs = await searchDocumentsByText(db, args.query, { limit });
              for (const d of docs) {
                results.push({
                  id: d.id,
                  type: d.doc_type,
                  title: d.title,
                  score: null,
                  preview: d.content.slice(0, 120),
                });
              }
            }

            if (results.length === 0) {
              console.log('No results found.');
              return;
            }

            console.log(`Search results (${usedSemantic ? 'semantic' : 'text'}):\n`);
            for (const r of results.slice(0, limit)) {
              const scoreStr = r.score !== null ? ` (score: ${r.score.toFixed(4)})` : '';
              console.log(`  [${r.type}] ${r.title}${scoreStr}`);
              console.log(`    ID: ${r.id}`);
              console.log(`    ${r.preview}...`);
              console.log('');
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Search error: ${message}`);
          }
        },
      },

      setup: {
        description: 'Initialize or migrate the Quorum database schema',
        handler: async () => {
          try {
            console.log(`Connecting to ${config.db_host}:${config.db_port}/${config.db_name}...`);
            await ensureSchema(db, config.embedding_dim);
            console.log('Schema created/verified successfully.');

            const ollamaHealth = await checkOllamaHealth(embedConfig);
            if (ollamaHealth.reachable) {
              console.log(`Ollama is reachable at ${config.ollama_host}.`);
              if (ollamaHealth.model_available) {
                console.log(`Embedding model "${config.ollama_embed_model}" is available.`);
              } else {
                console.log(
                  `WARNING: Model "${config.ollama_embed_model}" not found. ` +
                    `Run: ollama pull ${config.ollama_embed_model}`
                );
              }
            } else {
              console.log(
                `WARNING: Ollama not reachable at ${config.ollama_host}. ` +
                  'Embeddings will not work until Ollama is running.'
              );
            }

            console.log('\nThe Quorum is ready.');
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Setup failed: ${message}`);
          }
        },
      },
    },
  });

  // ─── Register Background Service (Embedding Queue Processor) ─────────────

  api.registerService({
    name: 'quorum-embedding-queue',
    description: 'Processes pending embeddings for documents and events stored in The Quorum',
    intervalMs: 30_000, // Run every 30 seconds
    handler: async () => {
      try {
        const result = await processEmbeddingQueue(db, embedConfig, 50);
        if (result.processed > 0 || result.errors > 0) {
          console.log(
            `[the-quorum] Embedding queue: processed=${result.processed}, errors=${result.errors}`
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[the-quorum] Embedding queue error: ${message}`);
      }
    },
  });

  // ─── Lifecycle: Schema initialization on startup ─────────────────────────

  api.onReady?.(async () => {
    try {
      await ensureSchema(db, config.embedding_dim);
      console.log('[the-quorum] Database schema verified.');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[the-quorum] Schema init failed: ${message}`);
      console.error('[the-quorum] Run "openclaw quorum setup" to initialize the database.');
    }

    // Create inbox and processed directories if they don't exist
    try {
      await mkdir(config.inbox_dir, { recursive: true });
      await mkdir(config.processed_dir, { recursive: true });
      console.log(`[the-quorum] Inbox directory ready: ${config.inbox_dir}`);
      console.log(`[the-quorum] Processed directory ready: ${config.processed_dir}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[the-quorum] Failed to create inbox/processed directories: ${message}`);
    }
  });

  // ─── Lifecycle: Clean shutdown ───────────────────────────────────────────

  api.onShutdown?.(async () => {
    if (pool) {
      await pool.end();
      pool = null;
      console.log('[the-quorum] Database pool closed.');
    }
  });
}
