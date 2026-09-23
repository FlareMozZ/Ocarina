-- Run once against an existing database created before session-aware queues.
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS last_ping_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS device_queue JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.track_drops ADD COLUMN IF NOT EXISTS sender_name TEXT NOT NULL DEFAULT 'Guest listener';
ALTER TABLE public.track_drops ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ DEFAULT NOW();

UPDATE public.rooms SET session_started_at = COALESCE(session_started_at, created_at) WHERE session_started_at IS NULL;
UPDATE public.track_drops SET session_started_at = COALESCE(session_started_at, created_at) WHERE session_started_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_track_drops_room_status_created
  ON public.track_drops(room_id, status, created_at DESC);
