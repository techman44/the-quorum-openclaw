import { Pool, type PoolClient } from 'pg';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QuorumDocument {
  id: string;
  doc_type: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  tags: string[];
  created_at: Date;
  updated_at: Date;
}

export interface QuorumEvent {
  id: string;
  event_type: string;
  title: string;
  description: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface QuorumTask {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  owner: string | null;
  due_at: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface SearchResult {
  id: string;
  doc_type: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  tags: string[];
  score: number;
}

export interface EmbeddingRecord {
  id: string;
  ref_type: string;
  ref_id: string;
  content_hash: string;
  created_at: Date;
}

// ─── Schema Setup ────────────────────────────────────────────────────────────

export async function ensureSchema(pool: Pool, embeddingDim: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await client.query('CREATE EXTENSION IF NOT EXISTS "vector"');

    await client.query(`
      CREATE TABLE IF NOT EXISTS quorum_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doc_type TEXT NOT NULL DEFAULT 'note',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}',
        tags TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS quorum_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS quorum_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        priority TEXT NOT NULL DEFAULT 'medium',
        owner TEXT,
        due_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS quorum_embeddings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ref_type TEXT NOT NULL,
        ref_id UUID NOT NULL,
        embedding vector(${embeddingDim}) NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quorum_documents_doc_type ON quorum_documents(doc_type)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quorum_documents_tags ON quorum_documents USING gin(tags)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quorum_events_event_type ON quorum_events(event_type)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quorum_events_created_at ON quorum_events(created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quorum_tasks_status ON quorum_tasks(status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quorum_tasks_priority ON quorum_tasks(priority)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quorum_tasks_owner ON quorum_tasks(owner)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quorum_embeddings_ref ON quorum_embeddings(ref_type, ref_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quorum_embeddings_vector
      ON quorum_embeddings USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
    `);
  } finally {
    client.release();
  }
}

// ─── Document Operations ─────────────────────────────────────────────────────

export async function storeDocument(
  pool: Pool,
  doc: {
    doc_type: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }
): Promise<QuorumDocument> {
  const result = await pool.query<QuorumDocument>(
    `INSERT INTO quorum_documents (doc_type, title, content, metadata, tags)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      doc.doc_type,
      doc.title,
      doc.content,
      JSON.stringify(doc.metadata ?? {}),
      doc.tags ?? [],
    ]
  );
  return result.rows[0];
}

export async function getDocument(pool: Pool, id: string): Promise<QuorumDocument | null> {
  const result = await pool.query<QuorumDocument>(
    'SELECT * FROM quorum_documents WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}

export async function searchDocumentsByText(
  pool: Pool,
  query: string,
  opts: { doc_type?: string; limit?: number }
): Promise<QuorumDocument[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  conditions.push(`(title ILIKE $${paramIdx} OR content ILIKE $${paramIdx})`);
  params.push(`%${query}%`);
  paramIdx++;

  if (opts.doc_type) {
    conditions.push(`doc_type = $${paramIdx}`);
    params.push(opts.doc_type);
    paramIdx++;
  }

  const limit = opts.limit ?? 20;
  params.push(limit);

  const result = await pool.query<QuorumDocument>(
    `SELECT * FROM quorum_documents
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $${paramIdx}`,
    params
  );
  return result.rows;
}

// ─── Semantic Search ─────────────────────────────────────────────────────────

export async function semanticSearch(
  pool: Pool,
  queryEmbedding: number[],
  opts: { ref_type?: string; limit?: number }
): Promise<SearchResult[]> {
  const vecLiteral = `[${queryEmbedding.join(',')}]`;
  const conditions: string[] = [];
  const params: unknown[] = [vecLiteral];
  let paramIdx = 2;

  if (opts.ref_type) {
    conditions.push(`e.ref_type = $${paramIdx}`);
    params.push(opts.ref_type);
    paramIdx++;
  }

  const limit = opts.limit ?? 10;
  params.push(limit);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query<SearchResult>(
    `SELECT
       d.id,
       d.doc_type,
       d.title,
       d.content,
       d.metadata,
       d.tags,
       1 - (e.embedding <=> $1::vector) AS score
     FROM quorum_embeddings e
     JOIN quorum_documents d ON d.id = e.ref_id AND e.ref_type = 'document'
     ${whereClause}
     ORDER BY e.embedding <=> $1::vector ASC
     LIMIT $${paramIdx}`,
    params
  );
  return result.rows;
}

export async function semanticSearchEvents(
  pool: Pool,
  queryEmbedding: number[],
  opts: { event_type?: string; limit?: number }
): Promise<(QuorumEvent & { score: number })[]> {
  const vecLiteral = `[${queryEmbedding.join(',')}]`;
  const conditions: string[] = [];
  const params: unknown[] = [vecLiteral];
  let paramIdx = 2;

  if (opts.event_type) {
    conditions.push(`ev.event_type = $${paramIdx}`);
    params.push(opts.event_type);
    paramIdx++;
  }

  const limit = opts.limit ?? 10;
  params.push(limit);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query<QuorumEvent & { score: number }>(
    `SELECT
       ev.id,
       ev.event_type,
       ev.title,
       ev.description,
       ev.metadata,
       ev.created_at,
       1 - (e.embedding <=> $1::vector) AS score
     FROM quorum_embeddings e
     JOIN quorum_events ev ON ev.id = e.ref_id AND e.ref_type = 'event'
     ${whereClause}
     ORDER BY e.embedding <=> $1::vector ASC
     LIMIT $${paramIdx}`,
    params
  );
  return result.rows;
}

// ─── Event Operations ────────────────────────────────────────────────────────

export async function storeEvent(
  pool: Pool,
  event: {
    event_type: string;
    title: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<QuorumEvent> {
  const result = await pool.query<QuorumEvent>(
    `INSERT INTO quorum_events (event_type, title, description, metadata)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      event.event_type,
      event.title,
      event.description ?? '',
      JSON.stringify(event.metadata ?? {}),
    ]
  );
  return result.rows[0];
}

export async function listEvents(
  pool: Pool,
  opts: { event_type?: string; limit?: number; since?: Date }
): Promise<QuorumEvent[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.event_type) {
    conditions.push(`event_type = $${paramIdx}`);
    params.push(opts.event_type);
    paramIdx++;
  }

  if (opts.since) {
    conditions.push(`created_at >= $${paramIdx}`);
    params.push(opts.since.toISOString());
    paramIdx++;
  }

  const limit = opts.limit ?? 50;
  params.push(limit);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query<QuorumEvent>(
    `SELECT * FROM quorum_events
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx}`,
    params
  );
  return result.rows;
}

// ─── Task Operations ─────────────────────────────────────────────────────────

export async function createTask(
  pool: Pool,
  task: {
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    owner?: string;
    due_at?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<QuorumTask> {
  const result = await pool.query<QuorumTask>(
    `INSERT INTO quorum_tasks (title, description, status, priority, owner, due_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      task.title,
      task.description ?? '',
      task.status ?? 'open',
      task.priority ?? 'medium',
      task.owner ?? null,
      task.due_at ?? null,
      JSON.stringify(task.metadata ?? {}),
    ]
  );
  return result.rows[0];
}

export async function updateTask(
  pool: Pool,
  id: string,
  updates: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    owner?: string | null;
    due_at?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<QuorumTask | null> {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (updates.title !== undefined) {
    setClauses.push(`title = $${paramIdx}`);
    params.push(updates.title);
    paramIdx++;
  }
  if (updates.description !== undefined) {
    setClauses.push(`description = $${paramIdx}`);
    params.push(updates.description);
    paramIdx++;
  }
  if (updates.status !== undefined) {
    setClauses.push(`status = $${paramIdx}`);
    params.push(updates.status);
    paramIdx++;
  }
  if (updates.priority !== undefined) {
    setClauses.push(`priority = $${paramIdx}`);
    params.push(updates.priority);
    paramIdx++;
  }
  if (updates.owner !== undefined) {
    setClauses.push(`owner = $${paramIdx}`);
    params.push(updates.owner);
    paramIdx++;
  }
  if (updates.due_at !== undefined) {
    setClauses.push(`due_at = $${paramIdx}`);
    params.push(updates.due_at);
    paramIdx++;
  }
  if (updates.metadata !== undefined) {
    setClauses.push(`metadata = $${paramIdx}`);
    params.push(JSON.stringify(updates.metadata));
    paramIdx++;
  }

  if (setClauses.length === 0) return null;

  setClauses.push('updated_at = now()');
  params.push(id);

  const result = await pool.query<QuorumTask>(
    `UPDATE quorum_tasks SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    params
  );
  return result.rows[0] ?? null;
}

export async function getTask(pool: Pool, id: string): Promise<QuorumTask | null> {
  const result = await pool.query<QuorumTask>(
    'SELECT * FROM quorum_tasks WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}

export async function listTasks(
  pool: Pool,
  opts: { status?: string; priority?: string; owner?: string; limit?: number }
): Promise<QuorumTask[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.status) {
    conditions.push(`status = $${paramIdx}`);
    params.push(opts.status);
    paramIdx++;
  }
  if (opts.priority) {
    conditions.push(`priority = $${paramIdx}`);
    params.push(opts.priority);
    paramIdx++;
  }
  if (opts.owner) {
    conditions.push(`owner = $${paramIdx}`);
    params.push(opts.owner);
    paramIdx++;
  }

  const limit = opts.limit ?? 50;
  params.push(limit);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const priorityOrder = `CASE priority
    WHEN 'critical' THEN 0
    WHEN 'high' THEN 1
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 3
    ELSE 4
  END`;

  const result = await pool.query<QuorumTask>(
    `SELECT * FROM quorum_tasks
     ${whereClause}
     ORDER BY ${priorityOrder} ASC, due_at ASC NULLS LAST, created_at DESC
     LIMIT $${paramIdx}`,
    params
  );
  return result.rows;
}

// ─── Embedding Storage ───────────────────────────────────────────────────────

export async function storeEmbedding(
  pool: Pool,
  record: {
    ref_type: string;
    ref_id: string;
    embedding: number[];
    content_hash: string;
  }
): Promise<EmbeddingRecord> {
  const vecLiteral = `[${record.embedding.join(',')}]`;

  // Upsert: replace embedding if ref already exists
  const result = await pool.query<EmbeddingRecord>(
    `INSERT INTO quorum_embeddings (ref_type, ref_id, embedding, content_hash)
     VALUES ($1, $2, $3::vector, $4)
     ON CONFLICT (id) DO NOTHING
     RETURNING id, ref_type, ref_id, content_hash, created_at`,
    [record.ref_type, record.ref_id, vecLiteral, record.content_hash]
  );

  if (result.rows[0]) return result.rows[0];

  // If there's already an embedding for this ref, update it
  const upsert = await pool.query<EmbeddingRecord>(
    `UPDATE quorum_embeddings
     SET embedding = $3::vector, content_hash = $4, created_at = now()
     WHERE ref_type = $1 AND ref_id = $2
     RETURNING id, ref_type, ref_id, content_hash, created_at`,
    [record.ref_type, record.ref_id, vecLiteral, record.content_hash]
  );

  if (upsert.rows[0]) return upsert.rows[0];

  // Fallback: insert fresh (no existing record)
  const fresh = await pool.query<EmbeddingRecord>(
    `INSERT INTO quorum_embeddings (ref_type, ref_id, embedding, content_hash)
     VALUES ($1, $2, $3::vector, $4)
     RETURNING id, ref_type, ref_id, content_hash, created_at`,
    [record.ref_type, record.ref_id, vecLiteral, record.content_hash]
  );
  return fresh.rows[0];
}

export async function hasEmbedding(
  pool: Pool,
  refType: string,
  refId: string,
  contentHash: string
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM quorum_embeddings WHERE ref_type = $1 AND ref_id = $2 AND content_hash = $3 LIMIT 1`,
    [refType, refId, contentHash]
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export async function getUnembeddedDocuments(pool: Pool, limit: number = 100): Promise<QuorumDocument[]> {
  const result = await pool.query<QuorumDocument>(
    `SELECT d.* FROM quorum_documents d
     LEFT JOIN quorum_embeddings e ON e.ref_type = 'document' AND e.ref_id = d.id
     WHERE e.id IS NULL
     ORDER BY d.created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getUnembeddedEvents(pool: Pool, limit: number = 100): Promise<QuorumEvent[]> {
  const result = await pool.query<QuorumEvent>(
    `SELECT ev.* FROM quorum_events ev
     LEFT JOIN quorum_embeddings e ON e.ref_type = 'event' AND e.ref_id = ev.id
     WHERE e.id IS NULL
     ORDER BY ev.created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export async function getStats(pool: Pool): Promise<{
  documents: number;
  events: number;
  tasks: number;
  embeddings: number;
  unembedded_documents: number;
  unembedded_events: number;
}> {
  const [docs, events, tasks, embeds, unembDocs, unembEvents] = await Promise.all([
    pool.query('SELECT count(*)::int AS n FROM quorum_documents'),
    pool.query('SELECT count(*)::int AS n FROM quorum_events'),
    pool.query('SELECT count(*)::int AS n FROM quorum_tasks'),
    pool.query('SELECT count(*)::int AS n FROM quorum_embeddings'),
    pool.query(
      `SELECT count(*)::int AS n FROM quorum_documents d
       LEFT JOIN quorum_embeddings e ON e.ref_type = 'document' AND e.ref_id = d.id
       WHERE e.id IS NULL`
    ),
    pool.query(
      `SELECT count(*)::int AS n FROM quorum_events ev
       LEFT JOIN quorum_embeddings e ON e.ref_type = 'event' AND e.ref_id = ev.id
       WHERE e.id IS NULL`
    ),
  ]);

  return {
    documents: docs.rows[0].n,
    events: events.rows[0].n,
    tasks: tasks.rows[0].n,
    embeddings: embeds.rows[0].n,
    unembedded_documents: unembDocs.rows[0].n,
    unembedded_events: unembEvents.rows[0].n,
  };
}
