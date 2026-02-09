-- Embeddings: vector representations of content across all tables.
-- Uses pgvector with 1024-dimension vectors (mxbai-embed-large default).
-- A single table stores embeddings for documents, chunks, turns, events, and tasks.

CREATE TABLE IF NOT EXISTS embeddings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ref_type        TEXT NOT NULL CHECK (ref_type IN (
                        'document', 'document_chunk', 'conversation_turn',
                        'event', 'task'
                    )),
    ref_id          UUID NOT NULL,
    embedding       vector(1024) NOT NULL,      -- mxbai-embed-large produces 1024-d vectors
    model_name      TEXT DEFAULT 'mxbai-embed-large',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (ref_type, ref_id)
);

-- HNSW index for fast approximate nearest-neighbor cosine search.
-- m=16, ef_construction=64 are reasonable defaults for ~30K+ rows.
CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw
    ON embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_embeddings_ref ON embeddings (ref_type, ref_id);
