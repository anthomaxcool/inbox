-- Inbox schema (plan §7). Every ID is random 128-bit base32 (src/shared/ids.ts), never sequential.
-- Thread state is derived, not stored: see src/shared/threads.ts.

CREATE TABLE threads (
	id TEXT PRIMARY KEY,
	mailbox TEXT NOT NULL,
	subject TEXT NOT NULL DEFAULT '',
	counterparty_name TEXT,
	counterparty_address TEXT NOT NULL,
	reply_to TEXT NOT NULL,
	cc_seen TEXT NOT NULL DEFAULT '[]',
	last_message_at TEXT NOT NULL,
	last_direction TEXT NOT NULL CHECK (last_direction IN ('in', 'out')),
	archived_at TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX threads_mailbox_last ON threads (mailbox, last_message_at DESC);

CREATE TABLE messages (
	id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL REFERENCES threads (id),
	mailbox TEXT NOT NULL,
	direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
	message_id_hdr TEXT NOT NULL,
	in_reply_to TEXT,
	references_hdr TEXT,
	from_name TEXT,
	from_address TEXT NOT NULL,
	"to" TEXT NOT NULL DEFAULT '[]',
	cc TEXT NOT NULL DEFAULT '[]',
	subject TEXT NOT NULL DEFAULT '',
	date TEXT NOT NULL,
	text_body TEXT NOT NULL DEFAULT '',
	had_html INTEGER NOT NULL DEFAULT 0,
	raw_key TEXT,
	size INTEGER NOT NULL DEFAULT 0,
	send_attempt_id TEXT REFERENCES send_attempts (id),
	created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX messages_mailbox_msgid ON messages (mailbox, message_id_hdr);
CREATE INDEX messages_thread ON messages (thread_id, date);

CREATE TABLE attachments (
	id TEXT PRIMARY KEY,
	message_id TEXT NOT NULL REFERENCES messages (id),
	filename TEXT NOT NULL,
	content_type TEXT NOT NULL,
	size INTEGER NOT NULL,
	r2_key TEXT NOT NULL
);
CREATE INDEX attachments_message ON attachments (message_id);

CREATE TABLE drafts (
	id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL REFERENCES threads (id),
	status TEXT NOT NULL CHECK (status IN ('open', 'sending', 'sent', 'discarded')),
	owner_locked INTEGER NOT NULL DEFAULT 0 CHECK (owner_locked IN (0, 1)),
	current_revision_id TEXT,
	notified_at TEXT,
	created_at TEXT NOT NULL,
	closed_at TEXT
);
-- At most one live draft per thread.
CREATE UNIQUE INDEX drafts_one_live_per_thread ON drafts (thread_id) WHERE status IN ('open', 'sending');

-- Append-only. No UPDATE or DELETE on this table exists in the code (test/invariants.test.ts).
CREATE TABLE draft_revisions (
	id TEXT PRIMARY KEY,
	draft_id TEXT NOT NULL REFERENCES drafts (id),
	n INTEGER NOT NULL,
	body TEXT NOT NULL,
	body_sha256 TEXT NOT NULL,
	author TEXT NOT NULL,
	agent_key_id TEXT REFERENCES agent_keys (id),
	created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX draft_revisions_draft_n ON draft_revisions (draft_id, n);

CREATE TABLE send_attempts (
	id TEXT PRIMARY KEY,
	draft_id TEXT NOT NULL REFERENCES drafts (id),
	revision_id TEXT NOT NULL REFERENCES draft_revisions (id),
	idempotency_key TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'unknown')),
	to_address TEXT NOT NULL,
	provider_message_id TEXT,
	error TEXT,
	created_at TEXT NOT NULL,
	finished_at TEXT
);
CREATE UNIQUE INDEX send_attempts_idempotency_key ON send_attempts (idempotency_key);

CREATE TABLE agent_keys (
	id TEXT PRIMARY KEY,
	label TEXT NOT NULL,
	key_hash TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT
);
CREATE UNIQUE INDEX agent_keys_label ON agent_keys (label);
CREATE UNIQUE INDEX agent_keys_hash ON agent_keys (key_hash);

CREATE TABLE notifications (
	id TEXT PRIMARY KEY,
	draft_id TEXT NOT NULL REFERENCES drafts (id),
	channel TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
	error TEXT,
	at TEXT NOT NULL
);

-- Append-only audit log. Every refused request on a draft or send route lands here.
CREATE TABLE events (
	id TEXT PRIMARY KEY,
	at TEXT NOT NULL,
	actor TEXT NOT NULL,
	kind TEXT NOT NULL,
	ref TEXT,
	detail TEXT
);
CREATE INDEX events_at ON events (at);
