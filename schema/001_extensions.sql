-- Enable required PostgreSQL extensions.
-- pgvector: vector similarity search for embeddings
-- uuid-ossp: UUID generation functions

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
