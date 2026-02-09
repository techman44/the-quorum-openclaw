-- Documents: the primary unit of stored knowledge.
-- Each document can be chunked for finer-grained embedding and retrieval.

CREATE TABLE IF NOT EXISTS quorum_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_type        TEXT NOT NULL DEFAULT 'note',
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    metadata        JSONB NOT NULL DEFAULT '{}',
    tags            TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS idx_quorum_documents_doc_type   ON quorum_documents (doc_type);
CREATE INDEX IF NOT EXISTS idx_quorum_documents_tags       ON quorum_documents USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_quorum_documents_created_at ON quorum_documents (created_at);

-- Auto-update updated_at on row modification.
CREATE OR REPLACE FUNCTION update_quorum_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quorum_documents_updated_at ON quorum_documents;
CREATE TRIGGER trg_quorum_documents_updated_at
    BEFORE UPDATE ON quorum_documents
    FOR EACH ROW
    EXECUTE FUNCTION update_quorum_documents_updated_at();


-- Document chunks: subdivisions of a document for granular embedding.
CREATE TABLE IF NOT EXISTS quorum_document_chunks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES quorum_documents (id) ON DELETE CASCADE,
    chunk_index     INT NOT NULL,
    content         TEXT NOT NULL,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_quorum_document_chunks_document_id ON quorum_document_chunks (document_id);
