-- DocFlare AI - queue lease + chat log retention
-- Apply with: bun run db:migrate (remote) / bun run db:migrate:local

-- Pages are claimed (status = 'processing') before they are crawled. `attempts` counts claims, so a page
-- that keeps getting the Worker killed (CPU, memory or time limit) is marked failed after a few tries
-- instead of blocking the head of the queue forever.
ALTER TABLE pages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

-- The hourly retention job deletes chat log rows by age across all sites.
CREATE INDEX IF NOT EXISTS idx_queries_created ON queries (created_at);
