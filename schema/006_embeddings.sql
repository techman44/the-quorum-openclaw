-- Embeddings: vector representations of content across all tables.
-- Uses pgvector for vector similarity search.
-- A single table stores embeddings for documents, chunks, turns, events, and tasks.
-- Note: the embedding dimension is configured at runtime via ensureSchema() in db.ts.

CREATE TABLE IF NOT EXISTS quorum_embeddings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ref_type        TEXT NOT NULL,
    ref_id          UUID NOT NULL,
    embedding       vector(1024) NOT NULL,      -- default 1024-d; overridden at runtime if needed
    content_hash    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- IVFFlat index for fast approximate nearest-neighbor cosine search.
CREATE INDEX IF NOT EXISTS idx_quorum_embeddings_vector
    ON quorum_embeddings
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_quorum_embeddings_ref ON quorum_embeddings (ref_type, ref_id);
