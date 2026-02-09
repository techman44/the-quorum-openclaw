import { Pool } from 'pg';
import {
  storeDocument,
  storeEvent,
  createTask,
  updateTask,
  listTasks,
  semanticSearch,
  semanticSearchEvents,
  searchDocumentsByText,
  getStats,
} from './db.js';
import { embedText, embedAndStore, checkOllamaHealth, type EmbeddingConfig } from './embeddings.js';

export interface QuorumConfig {
  db_host: string;
  db_port: number;
  db_user: string;
  db_password: string;
  db_name: string;
  ollama_host: string;
  ollama_embed_model: string;
  embedding_dim: number;
}

/**
 * Register all Quorum agent tools with the OpenClaw API.
 */
export function registerTools(api: any, pool: Pool, config: QuorumConfig): void {
  const embedConfig: EmbeddingConfig = {
    ollama_host: config.ollama_host,
    ollama_embed_model: config.ollama_embed_model,
    embedding_dim: config.embedding_dim,
  };

  // ─── quorum_search ───────────────────────────────────────────────────────

  api.registerTool({
    name: 'quorum_search',
    description:
      'Semantic search over The Quorum memory database. Searches documents and events using vector similarity. Falls back to text search if embeddings are unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query text',
        },
        ref_type: {
          type: 'string',
          enum: ['document', 'event', 'all'],
          description: 'Type of records to search. Defaults to "all".',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return. Defaults to 10.',
        },
      },
      required: ['query'],
    },
    handler: async (input: { query: string; ref_type?: string; limit?: number }) => {
      const limit = input.limit ?? 10;
      const refType = input.ref_type ?? 'all';

      try {
        // Attempt semantic search
        const queryEmbedding = await embedText(input.query, embedConfig);

        const results: Array<{
          id: string;
          type: string;
          title: string;
          content: string;
          metadata: Record<string, unknown>;
          score: number;
        }> = [];

        if (refType === 'all' || refType === 'document') {
          const docResults = await semanticSearch(pool, queryEmbedding, {
            ref_type: refType === 'document' ? 'document' : undefined,
            limit,
          });
          for (const r of docResults) {
            results.push({
              id: r.id,
              type: r.doc_type,
              title: r.title,
              content: r.content,
              metadata: r.metadata,
              score: Number(r.score),
            });
          }
        }

        if (refType === 'all' || refType === 'event') {
          const eventResults = await semanticSearchEvents(pool, queryEmbedding, { limit });
          for (const r of eventResults) {
            results.push({
              id: r.id,
              type: r.event_type,
              title: r.title,
              content: r.description,
              metadata: r.metadata,
              score: Number(r.score),
            });
          }
        }

        // Sort combined results by score descending, take top N
        results.sort((a, b) => b.score - a.score);
        const trimmed = results.slice(0, limit);

        return {
          search_type: 'semantic',
          result_count: trimmed.length,
          results: trimmed,
        };
      } catch (err: unknown) {
        // Fallback to text search if embedding fails
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[the-quorum] Semantic search failed, falling back to text: ${message}`);

        const textResults = await searchDocumentsByText(pool, input.query, {
          doc_type: refType !== 'all' && refType !== 'event' ? refType : undefined,
          limit,
        });

        return {
          search_type: 'text_fallback',
          fallback_reason: message,
          result_count: textResults.length,
          results: textResults.map((d) => ({
            id: d.id,
            type: d.doc_type,
            title: d.title,
            content: d.content,
            metadata: d.metadata,
            score: null,
          })),
        };
      }
    },
  });

  // ─── quorum_store ────────────────────────────────────────────────────────

  api.registerTool({
    name: 'quorum_store',
    description:
      'Store a document, note, or decision into The Quorum memory database. Automatically generates and stores an embedding for semantic search.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_type: {
          type: 'string',
          description: 'Type of document: note, decision, analysis, reference, snippet, etc.',
        },
        title: {
          type: 'string',
          description: 'Title of the document',
        },
        content: {
          type: 'string',
          description: 'Full content of the document',
        },
        metadata: {
          type: 'object',
          description: 'Optional key-value metadata to attach',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization',
        },
      },
      required: ['doc_type', 'title', 'content'],
    },
    handler: async (input: {
      doc_type: string;
      title: string;
      content: string;
      metadata?: Record<string, unknown>;
      tags?: string[];
    }) => {
      const doc = await storeDocument(pool, {
        doc_type: input.doc_type,
        title: input.title,
        content: input.content,
        metadata: input.metadata,
        tags: input.tags,
      });

      // Embed in the background (best effort)
      let embeddingStatus = 'pending';
      try {
        const textToEmbed = `${doc.title}\n\n${doc.content}`;
        const result = await embedAndStore(pool, embedConfig, 'document', doc.id, textToEmbed);
        embeddingStatus = result.embedded ? 'stored' : 'already_current';
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        embeddingStatus = `failed: ${message}`;
        console.error(`[the-quorum] Embedding failed for doc ${doc.id}: ${message}`);
      }

      return {
        id: doc.id,
        doc_type: doc.doc_type,
        title: doc.title,
        tags: doc.tags,
        created_at: doc.created_at,
        embedding_status: embeddingStatus,
      };
    },
  });

  // ─── quorum_store_event ──────────────────────────────────────────────────

  api.registerTool({
    name: 'quorum_store_event',
    description:
      'Log an event into The Quorum memory. Events represent decisions, insights, critiques, opportunities, or any notable occurrence worth remembering.',
    inputSchema: {
      type: 'object',
      properties: {
        event_type: {
          type: 'string',
          enum: ['decision', 'insight', 'critique', 'opportunity', 'milestone', 'error', 'observation'],
          description: 'Category of event',
        },
        title: {
          type: 'string',
          description: 'Short title for the event',
        },
        description: {
          type: 'string',
          description: 'Detailed description of the event',
        },
        metadata: {
          type: 'object',
          description: 'Optional structured metadata to attach',
        },
      },
      required: ['event_type', 'title'],
    },
    handler: async (input: {
      event_type: string;
      title: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }) => {
      const event = await storeEvent(pool, {
        event_type: input.event_type,
        title: input.title,
        description: input.description,
        metadata: input.metadata,
      });

      // Embed the event (best effort)
      let embeddingStatus = 'pending';
      try {
        const textToEmbed = `[${event.event_type}] ${event.title}\n\n${event.description}`;
        const result = await embedAndStore(pool, embedConfig, 'event', event.id, textToEmbed);
        embeddingStatus = result.embedded ? 'stored' : 'already_current';
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        embeddingStatus = `failed: ${message}`;
        console.error(`[the-quorum] Embedding failed for event ${event.id}: ${message}`);
      }

      return {
        id: event.id,
        event_type: event.event_type,
        title: event.title,
        created_at: event.created_at,
        embedding_status: embeddingStatus,
      };
    },
  });

  // ─── quorum_create_task ──────────────────────────────────────────────────

  api.registerTool({
    name: 'quorum_create_task',
    description:
      'Create a new task or update an existing task in The Quorum task tracker. Tasks represent actionable work items with status, priority, and ownership.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'UUID of an existing task to update. Omit to create a new task.',
        },
        title: {
          type: 'string',
          description: 'Title of the task',
        },
        description: {
          type: 'string',
          description: 'Detailed description of the task',
        },
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'blocked', 'done', 'cancelled'],
          description: 'Task status. Defaults to "open" for new tasks.',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Task priority. Defaults to "medium".',
        },
        owner: {
          type: 'string',
          description: 'Who is responsible for this task',
        },
        due_at: {
          type: 'string',
          description: 'Due date in ISO 8601 format',
        },
        metadata: {
          type: 'object',
          description: 'Optional structured metadata',
        },
      },
      required: ['title'],
    },
    handler: async (input: {
      id?: string;
      title: string;
      description?: string;
      status?: string;
      priority?: string;
      owner?: string;
      due_at?: string;
      metadata?: Record<string, unknown>;
    }) => {
      if (input.id) {
        // Update existing task
        const updated = await updateTask(pool, input.id, {
          title: input.title,
          description: input.description,
          status: input.status,
          priority: input.priority,
          owner: input.owner,
          due_at: input.due_at,
          metadata: input.metadata,
        });

        if (!updated) {
          return { error: `Task ${input.id} not found` };
        }

        return {
          action: 'updated',
          task: updated,
        };
      }

      // Create new task
      const task = await createTask(pool, {
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        owner: input.owner,
        due_at: input.due_at,
        metadata: input.metadata,
      });

      return {
        action: 'created',
        task,
      };
    },
  });

  // ─── quorum_list_tasks ───────────────────────────────────────────────────

  api.registerTool({
    name: 'quorum_list_tasks',
    description:
      'List tasks from The Quorum task tracker. Filter by status, priority, or owner. Results are ordered by priority (critical first) and due date.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'blocked', 'done', 'cancelled'],
          description: 'Filter by task status',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Filter by priority level',
        },
        owner: {
          type: 'string',
          description: 'Filter by task owner',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of tasks to return. Defaults to 50.',
        },
      },
    },
    handler: async (input: {
      status?: string;
      priority?: string;
      owner?: string;
      limit?: number;
    }) => {
      const tasks = await listTasks(pool, {
        status: input.status,
        priority: input.priority,
        owner: input.owner,
        limit: input.limit,
      });

      return {
        count: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          owner: t.owner,
          due_at: t.due_at,
          created_at: t.created_at,
          updated_at: t.updated_at,
        })),
      };
    },
  });

  // ─── quorum_embed ────────────────────────────────────────────────────────

  api.registerTool({
    name: 'quorum_embed',
    description:
      'Generate an embedding vector for text content using the configured Ollama model. Optionally stores the embedding linked to a reference (document or event).',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text content to generate an embedding for',
        },
        ref_type: {
          type: 'string',
          enum: ['document', 'event'],
          description: 'If provided with ref_id, stores the embedding linked to this reference type',
        },
        ref_id: {
          type: 'string',
          description: 'UUID of the document or event to link this embedding to',
        },
      },
      required: ['text'],
    },
    handler: async (input: { text: string; ref_type?: string; ref_id?: string }) => {
      const embedding = await embedText(input.text, embedConfig);

      if (input.ref_type && input.ref_id) {
        const result = await embedAndStore(
          pool,
          embedConfig,
          input.ref_type,
          input.ref_id,
          input.text
        );

        return {
          dimension: embedding.length,
          ref_type: input.ref_type,
          ref_id: input.ref_id,
          stored: result.embedded,
          content_hash: result.content_hash,
        };
      }

      return {
        dimension: embedding.length,
        embedding: embedding.slice(0, 5).concat([null as any]),
        note: 'Full embedding generated. Only first 5 dimensions shown. Provide ref_type and ref_id to store.',
      };
    },
  });

  // ─── quorum_integration_status ───────────────────────────────────────────

  api.registerTool({
    name: 'quorum_integration_status',
    description:
      'Show the status of all Quorum integrations: database connectivity, embedding service health, and configuration summary.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const integrations: Record<
        string,
        { status: string; details: Record<string, unknown> }
      > = {};

      // Check PostgreSQL
      try {
        const result = await pool.query('SELECT version() AS version, now() AS server_time');
        const row = result.rows[0];

        const stats = await getStats(pool);

        integrations['postgresql'] = {
          status: 'connected',
          details: {
            host: config.db_host,
            port: config.db_port,
            database: config.db_name,
            server_version: row.version,
            server_time: row.server_time,
            ...stats,
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        integrations['postgresql'] = {
          status: 'error',
          details: {
            host: config.db_host,
            port: config.db_port,
            database: config.db_name,
            error: message,
          },
        };
      }

      // Check pgvector
      try {
        await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
        integrations['pgvector'] = {
          status: 'installed',
          details: { embedding_dim: config.embedding_dim },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        integrations['pgvector'] = {
          status: 'error',
          details: { error: message },
        };
      }

      // Check Ollama
      const ollamaHealth = await checkOllamaHealth(embedConfig);
      integrations['ollama'] = {
        status: ollamaHealth.reachable ? 'connected' : 'unreachable',
        details: {
          host: config.ollama_host,
          model: config.ollama_embed_model,
          model_available: ollamaHealth.model_available,
          ...(ollamaHealth.error ? { error: ollamaHealth.error } : {}),
        },
      };

      const allHealthy = Object.values(integrations).every(
        (i) => i.status === 'connected' || i.status === 'installed'
      );

      return {
        overall_status: allHealthy ? 'healthy' : 'degraded',
        integrations,
      };
    },
  });
}
