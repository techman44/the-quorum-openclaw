-- Enable required PostgreSQL extensions.
-- pgvector: vector similarity search for embeddings
-- pgcrypto: gen_random_uuid() for UUID generation

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
