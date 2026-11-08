-- Align an existing Ocarina database with the Ocean backend.
-- Safe to run after ini.sql or initiation.sql; it does not delete application data.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  avatar_url TEXT,
  spotify_id TEXT UNIQUE,
  is_guest BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ocean creates Spotify profiles directly; they are not Supabase Auth users.
ALTER TABLE public.profiles ALTER COLUMN id SET DEFAULT gen_random_uuid();
DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND contype = 'f'
      AND confrelid = 'auth.users'::regclass
  LOOP
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END
$$;

CREATE TABLE IF NOT EXISTS public.friendships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACCEPTED', 'BLOCKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_friendship UNIQUE (user_id, friend_id)
);

ALTER TABLE public.friendships
  ADD COLUMN IF NOT EXISTS user_id UUID,
  ADD COLUMN IF NOT EXISTS friend_id UUID,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'friendships_user_id_fkey') THEN
    ALTER TABLE public.friendships
      ADD CONSTRAINT friendships_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'friendships_friend_id_fkey') THEN
    ALTER TABLE public.friendships
      ADD CONSTRAINT friendships_friend_id_fkey
      FOREIGN KEY (friend_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  room_code VARCHAR(8) NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  current_track JSONB NOT NULL DEFAULT '{}'::jsonb,
  recent_plays JSONB NOT NULL DEFAULT '[]'::jsonb,
  shuffle_state BOOLEAN NOT NULL DEFAULT false,
  session_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_ping_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  device_queue JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS recent_plays JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS shuffle_state BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_ping_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS device_queue JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_host_id_fkey') THEN
    ALTER TABLE public.rooms
      ADD CONSTRAINT rooms_host_id_fkey
      FOREIGN KEY (host_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.track_drops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES public.rooms(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  receiver_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  guest_name TEXT,
  sender_name TEXT NOT NULL DEFAULT 'Guest listener',
  spotify_uri TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album_art TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'PLAYED', 'FAILED', 'SKIPPED')),
  host_note TEXT CHECK (char_length(host_note) <= 150),
  was_echoed BOOLEAN NOT NULL DEFAULT false,
  chain_id UUID,
  chain_order SMALLINT,
  session_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.track_drops
  ADD COLUMN IF NOT EXISTS guest_name TEXT,
  ADD COLUMN IF NOT EXISTS host_note TEXT,
  ADD COLUMN IF NOT EXISTS was_echoed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS chain_id UUID,
  ADD COLUMN IF NOT EXISTS chain_order SMALLINT,
  ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS sender_name TEXT NOT NULL DEFAULT 'Guest listener';
ALTER TABLE public.track_drops ALTER COLUMN sender_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'track_drops_room_id_fkey') THEN
    ALTER TABLE public.track_drops
      ADD CONSTRAINT track_drops_room_id_fkey
      FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'track_drops_sender_id_fkey') THEN
    ALTER TABLE public.track_drops
      ADD CONSTRAINT track_drops_sender_id_fkey
      FOREIGN KEY (sender_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'track_drops_receiver_id_fkey') THEN
    ALTER TABLE public.track_drops
      ADD CONSTRAINT track_drops_receiver_id_fkey
      FOREIGN KEY (receiver_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.spotify_tokens (
  user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.backlogs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  spotify_uri TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album_art TEXT,
  dropped_by_name TEXT NOT NULL,
  dropped_by_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  dropped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_room_code VARCHAR(8) NOT NULL,
  chain_id UUID,
  chain_order SMALLINT,
  expires_at TIMESTAMPTZ NOT NULL,
  is_dismissed BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE public.backlogs
  ADD COLUMN IF NOT EXISTS chain_id UUID,
  ADD COLUMN IF NOT EXISTS chain_order SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backlogs_host_id_fkey') THEN
    ALTER TABLE public.backlogs
      ADD CONSTRAINT backlogs_host_id_fkey
      FOREIGN KEY (host_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backlogs_dropped_by_id_fkey') THEN
    ALTER TABLE public.backlogs
      ADD CONSTRAINT backlogs_dropped_by_id_fkey
      FOREIGN KEY (dropped_by_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_profiles_username ON public.profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_spotify_id ON public.profiles(spotify_id);
CREATE INDEX IF NOT EXISTS idx_friendships_user ON public.friendships(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_friend ON public.friendships(friend_id);
CREATE INDEX IF NOT EXISTS idx_rooms_code ON public.rooms(room_code);
CREATE INDEX IF NOT EXISTS idx_rooms_active ON public.rooms(is_active);
CREATE INDEX IF NOT EXISTS idx_track_drops_room_status_created
  ON public.track_drops(room_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backlogs_host_expiry
  ON public.backlogs(host_id, expires_at) WHERE is_dismissed = false;

-- Ocean accesses these tables with its server-only service role key.
-- RLS prevents direct anon/authenticated access to token and backlog contents.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.track_drops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spotify_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backlogs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.profiles,
  public.friendships,
  public.rooms,
  public.track_drops,
  public.spotify_tokens,
  public.backlogs
TO service_role;

NOTIFY pgrst, 'reload schema';
