import { Pool } from 'pg';
import { readdir, readFile, rename, mkdir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

// pdf-parse is loaded dynamically so PDF support is optional
let pdfParse: ((buf: Buffer) => Promise<{ text: string }>) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('pdf-parse');
  if (typeof mod === 'function') {
    // v1 style: module is directly callable
    pdfParse = mod;
  } else if (typeof mod.default === 'function') {
    pdfParse = mod.default;
  } else if (typeof mod.PDFParse === 'function') {
    // v2 style: exports a class - wrap it
    const PDFParse = mod.PDFParse;
    pdfParse = async (buf: Buffer) => {
      const parser = new PDFParse();
      return parser.loadPDF(buf);
    };
  }
} catch {
  // pdf-parse not installed - PDF files will be skipped
}

/**
 * OCR a PDF using Ollama's deepseek-ocr (or compatible vision model).
 * Converts pages to PNG via pdftoppm, then sends each to Ollama for OCR.
 * Returns the combined extracted text from all pages.
 */
async function ocrPdfWithOllama(
  pdfPath: string,
  ollamaHost: string,
  model: string = 'deepseek-ocr',
): Promise<string> {
  // Create a temp dir for page images
  const tmpDir = await mkdtemp(join(tmpdir(), 'quorum-ocr-'));
  try {
    // Convert PDF to PNG images (one per page)
    await execFileAsync('pdftoppm', ['-png', '-r', '200', pdfPath, join(tmpDir, 'page')]);

    // Read all generated page images
    const pageFiles = (await readdir(tmpDir))
      .filter(f => f.endsWith('.png'))
      .sort();

    if (pageFiles.length === 0) {
      throw new Error('pdftoppm produced no page images');
    }

    const pageTexts: string[] = [];
    for (const pageFile of pageFiles) {
      const imgBuffer = await readFile(join(tmpDir, pageFile));
      const base64Img = imgBuffer.toString('base64');

      const resp = await fetch(`${ollamaHost}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: 'Extract all text from this document image. Return only the extracted text, preserving the original structure and formatting as much as possible. Do not add commentary.',
              images: [base64Img],
            },
          ],
          stream: false,
        }),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Ollama OCR failed (${resp.status}): ${body}`);
      }

      const data = await resp.json() as { message?: { content?: string } };
      const pageText = data.message?.content?.trim() || '';
      if (pageText) {
        pageTexts.push(pageText);
      }
    }

    return pageTexts.join('\n\n--- Page Break ---\n\n');
  } finally {
    // Clean up temp dir
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Check if a specific Ollama model is available.
 */
async function isOllamaModelAvailable(ollamaHost: string, model: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ollamaHost}/api/tags`);
    if (!resp.ok) return false;
    const data = await resp.json() as { models?: Array<{ name: string }> };
    return (data.models ?? []).some(m => m.name === model || m.name.startsWith(`${model}:`));
  } catch {
    return false;
  }
}

/**
 * Check if pdftoppm is available on the system.
 */
async function isPdftoppmAvailable(): Promise<boolean> {
  try {
    await execFileAsync('pdftoppm', ['-v']);
    return true;
  } catch {
    return false;
  }
}
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
  inbox_dir: string;
  processed_dir: string;
}

/**
 * Format a result payload in the OpenClaw tool result format.
 */
function jsonResult(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Register all Quorum agent tools with the OpenClaw API.
 *
 * OpenClaw tools require:
 *   - name: string
 *   - description: string
 *   - parameters: JSON Schema object (NOT inputSchema)
 *   - execute(toolCallId, params, signal?, onUpdate?): returns { content: [{ type: "text", text: "..." }] }
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
    parameters: {
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
      additionalProperties: false,
    },
    execute: async (
      _toolCallId: string,
      input: { query: string; ref_type?: string; limit?: number },
      _signal?: AbortSignal,
    ) => {
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

        return jsonResult({
          search_type: 'semantic',
          result_count: trimmed.length,
          results: trimmed,
        });
      } catch (err: unknown) {
        // Fallback to text search if embedding fails
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[the-quorum] Semantic search failed, falling back to text: ${message}`);

        const textResults = await searchDocumentsByText(pool, input.query, {
          doc_type: refType !== 'all' && refType !== 'event' ? refType : undefined,
          limit,
        });

        return jsonResult({
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
        });
      }
    },
  });

  // ─── quorum_store ────────────────────────────────────────────────────────

  api.registerTool({
    name: 'quorum_store',
    description:
      'Store a document, note, or decision into The Quorum memory database. Automatically generates and stores an embedding for semantic search.',
    parameters: {
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
          additionalProperties: true,
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization',
        },
      },
      required: ['doc_type', 'title', 'content'],
      additionalProperties: false,
    },
    execute: async (
      _toolCallId: string,
      input: {
        doc_type: string;
        title: string;
        content: string;
        metadata?: Record<string, unknown>;
        tags?: string[];
      },
      _signal?: AbortSignal,
    ) => {
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

      return jsonResult({
        id: doc.id,
        doc_type: doc.doc_type,
        title: doc.title,
        tags: doc.tags,
        created_at: doc.created_at,
        embedding_status: embeddingStatus,
      });
    },
  });

  // ─── quorum_store_event ──────────────────────────────────────────────────

  api.registerTool({
    name: 'quorum_store_event',
    description:
      'Log an event into The Quorum memory. Events represent decisions, insights, critiques, opportunities, or any notable occurrence worth remembering.',
    parameters: {
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
          additionalProperties: true,
        },
      },
      required: ['event_type', 'title'],
      additionalProperties: false,
    },
    execute: async (
      _toolCallId: string,
      input: {
        event_type: string;
        title: string;
        description?: string;
        metadata?: Record<string, unknown>;
      },
      _signal?: AbortSignal,
    ) => {
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

      return jsonResult({
        id: event.id,
        event_type: event.event_type,
        title: event.title,
        created_at: event.created_at,
        embedding_status: embeddingStatus,
      });
    },
  });

  // ─── quorum_create_task ──────────────────────────────────────────────────

  api.registerTool({
    name: 'quorum_create_task',
    description:
      'Create a new task or update an existing task in The Quorum task tracker. Tasks represent actionable work items with status, priority, and ownership.',
    parameters: {
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
          additionalProperties: true,
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    execute: async (
      _toolCallId: string,
      input: {
        id?: string;
        title: string;
        description?: string;
        status?: string;
        priority?: string;
        owner?: string;
        due_at?: string;
        metadata?: Record<string, unknown>;
      },
      _signal?: AbortSignal,
    ) => {
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
          return jsonResult({ error: `Task ${input.id} not found` });
        }

        return jsonResult({
          action: 'updated',
          task: updated,
        });
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

      return jsonResult({
        action: 'created',
        task,
      });
    },
  });

  // ─── quorum_list_tasks ───────────────────────────────────────────────────

  api.registerTool({
    name: 'quorum_list_tasks',
    description:
      'List tasks from The Quorum task tracker. Filter by status, priority, or owner. Results are ordered by priority (critical first) and due date.',
    parameters: {
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
      additionalProperties: false,
    },
    execute: async (
      _toolCallId: string,
      input: {
        status?: string;
        priority?: string;
        owner?: string;
        limit?: number;
      },
      _signal?: AbortSignal,
    ) => {
      const tasks = await listTasks(pool, {
        status: input.status,
        priority: input.priority,
        owner: input.owner,
        limit: input.limit,
      });

      return jsonResult({
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
      });
    },
  });

  // ─── quorum_embed ────────────────────────────────────────────────────────

  api.registerTool({
    name: 'quorum_embed',
    description:
      'Generate an embedding vector for text content using the configured Ollama model. Optionally stores the embedding linked to a reference (document or event).',
    parameters: {
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
      additionalProperties: false,
    },
    execute: async (
      _toolCallId: string,
      input: { text: string; ref_type?: string; ref_id?: string },
      _signal?: AbortSignal,
    ) => {
      const embedding = await embedText(input.text, embedConfig);

      if (input.ref_type && input.ref_id) {
        const result = await embedAndStore(
          pool,
          embedConfig,
          input.ref_type,
          input.ref_id,
          input.text
        );

        return jsonResult({
          dimension: embedding.length,
          ref_type: input.ref_type,
          ref_id: input.ref_id,
          stored: result.embedded,
          content_hash: result.content_hash,
        });
      }

      return jsonResult({
        dimension: embedding.length,
        embedding: embedding.slice(0, 5).concat([null as any]),
        note: 'Full embedding generated. Only first 5 dimensions shown. Provide ref_type and ref_id to store.',
      });
    },
  });

  // ─── quorum_integration_status ───────────────────────────────────────────

  api.registerTool({
    name: 'quorum_integration_status',
    description:
      'Show the status of all Quorum integrations: database connectivity, embedding service health, and configuration summary.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async (
      _toolCallId: string,
      _input: Record<string, never>,
      _signal?: AbortSignal,
    ) => {
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
        const pgvResult = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
        if (pgvResult.rowCount && pgvResult.rowCount > 0) {
          integrations['pgvector'] = {
            status: 'installed',
            details: { embedding_dim: config.embedding_dim },
          };
        } else {
          integrations['pgvector'] = {
            status: 'not_installed',
            details: { error: 'pgvector extension is not installed' },
          };
        }
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

      return jsonResult({
        overall_status: allHealthy ? 'healthy' : 'degraded',
        integrations,
      });
    },
  });

  // ─── quorum_scan_inbox ──────────────────────────────────────────────────

  api.registerTool({
    name: 'quorum_scan_inbox',
    description:
      'Scan the inbox directory for new files, ingest them into The Quorum memory system, and move them to the processed directory. Each file is stored as a document with its type inferred from the file extension, then queued for embedding.',
    parameters: {
      type: 'object',
      properties: {
        inbox_path: {
          type: 'string',
          description:
            'Override the default inbox directory path. If not provided, uses the configured inbox_dir.',
        },
        dry_run: {
          type: 'boolean',
          description:
            'If true, list the files that would be ingested without actually processing them. Defaults to false.',
        },
      },
      additionalProperties: false,
    },
    execute: async (
      _toolCallId: string,
      input: { inbox_path?: string; dry_run?: boolean },
      _signal?: AbortSignal,
    ) => {
      const inboxDir = input.inbox_path ?? config.inbox_dir;
      const processedDir = config.processed_dir;
      const dryRun = input.dry_run ?? false;

      // Ensure directories exist
      await mkdir(inboxDir, { recursive: true });
      await mkdir(processedDir, { recursive: true });

      // Map file extensions to doc_type
      function docTypeFromExtension(ext: string): string {
        switch (ext.toLowerCase()) {
          case '.eml':
            return 'email';
          case '.html':
          case '.htm':
            return 'web';
          case '.md':
          case '.txt':
            return 'note';
          case '.json':
          case '.csv':
            return 'record';
          default:
            return 'file';
        }
      }

      let entries: string[];
      try {
        const dirEntries = await readdir(inboxDir, { withFileTypes: true });
        entries = dirEntries
          .filter((e) => e.isFile())
          .map((e) => e.name);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          error: `Failed to read inbox directory: ${message}`,
          inbox_path: inboxDir,
        });
      }

      if (entries.length === 0) {
        return jsonResult({
          inbox_path: inboxDir,
          files_found: 0,
          message: 'No files found in inbox directory.',
        });
      }

      // Dry run: just list files
      if (dryRun) {
        return jsonResult({
          inbox_path: inboxDir,
          dry_run: true,
          files_found: entries.length,
          files: entries.map((name) => ({
            name,
            doc_type: docTypeFromExtension(extname(name)),
          })),
        });
      }

      // Process each file
      const results: Array<{
        file: string;
        doc_id: string;
        doc_type: string;
        title: string;
        embedding_status: string;
        moved_to: string;
      }> = [];
      const errors: Array<{ file: string; error: string }> = [];

      for (const fileName of entries) {
        // Skip macOS metadata and hidden files
        if (fileName.startsWith('.') || fileName.startsWith('._')) {
          continue;
        }

        const filePath = join(inboxDir, fileName);
        try {
          const ext = extname(fileName).toLowerCase();
          let content: string;

          if (ext === '.pdf') {
            // Step 1: Try pdf-parse for text-based PDFs (fast, no GPU needed)
            let pdfText = '';
            if (pdfParse) {
              try {
                const pdfBuffer = await readFile(filePath);
                const pdfData = await pdfParse(pdfBuffer);
                pdfText = pdfData.text?.trim() || '';
              } catch {
                // pdf-parse failed, will try OCR fallback
              }
            }

            // Step 2: If no text extracted, try OCR via Ollama deepseek-ocr
            if (!pdfText) {
              const ocrModel = 'deepseek-ocr';
              const hasOcr = await isOllamaModelAvailable(config.ollama_host, ocrModel);
              const hasPdftoppm = await isPdftoppmAvailable();

              if (hasOcr && hasPdftoppm) {
                pdfText = await ocrPdfWithOllama(filePath, config.ollama_host, ocrModel);
              } else if (!pdfParse && !hasOcr) {
                throw new Error(
                  'No PDF processor available. Install pdf-parse (npm install pdf-parse) ' +
                  'for text PDFs, or install deepseek-ocr (ollama pull deepseek-ocr) + ' +
                  'poppler-utils for image/scanned PDFs.'
                );
              } else if (!pdfText) {
                const reasons: string[] = [];
                if (!hasOcr) reasons.push('deepseek-ocr model not installed (ollama pull deepseek-ocr)');
                if (!hasPdftoppm) reasons.push('pdftoppm not found (install poppler-utils)');
                throw new Error(
                  `PDF contains no extractable text (may be image-only). ` +
                  `OCR fallback unavailable: ${reasons.join('; ')}`
                );
              }
            }

            content = pdfText;
            if (!content.trim()) {
              throw new Error('PDF produced no text after all extraction attempts');
            }
          } else {
            content = await readFile(filePath, 'utf-8');
          }
          const docType = docTypeFromExtension(ext);
          const title = basename(fileName, ext);

          // Store the document
          const doc = await storeDocument(pool, {
            doc_type: docType,
            title,
            content,
            metadata: {
              source: 'inbox',
              original_filename: fileName,
              ingested_at: new Date().toISOString(),
            },
            tags: ['inbox', docType],
          });

          // Embed (best effort)
          let embeddingStatus = 'pending';
          try {
            const textToEmbed = `${doc.title}\n\n${doc.content}`;
            const result = await embedAndStore(pool, embedConfig, 'document', doc.id, textToEmbed);
            embeddingStatus = result.embedded ? 'stored' : 'already_current';
          } catch (embErr: unknown) {
            const embMessage = embErr instanceof Error ? embErr.message : String(embErr);
            embeddingStatus = `failed: ${embMessage}`;
            console.error(`[the-quorum] Embedding failed for inbox file ${fileName}: ${embMessage}`);
          }

          // Move to processed directory with timestamp prefix
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const processedName = `${timestamp}_${fileName}`;
          const processedPath = join(processedDir, processedName);
          await rename(filePath, processedPath);

          results.push({
            file: fileName,
            doc_id: doc.id,
            doc_type: docType,
            title: doc.title,
            embedding_status: embeddingStatus,
            moved_to: processedName,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ file: fileName, error: message });
          console.error(`[the-quorum] Failed to process inbox file ${fileName}: ${message}`);
        }
      }

      return jsonResult({
        inbox_path: inboxDir,
        processed_dir: processedDir,
        files_found: entries.length,
        files_ingested: results.length,
        files_errored: errors.length,
        results,
        ...(errors.length > 0 ? { errors } : {}),
      });
    },
  });
}
