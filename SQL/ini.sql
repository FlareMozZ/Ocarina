-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================
-- 1. PROFILES TABLE
-- Extends Supabase auth.users with app-specific info
-- ==========================================
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  avatar_url TEXT,
  spotify_id TEXT UNIQUE,
  is_guest BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast username & spotify_id lookups
CREATE INDEX idx_profiles_username ON public.profiles(username);
CREATE INDEX idx_profiles_spotify_id ON public.profiles(spotify_id);

-- ==========================================
-- 2. FRIENDSHIPS TABLE
-- Connects friends for Category 2 (Bandwagon Friends)
-- ==========================================
CREATE TABLE public.friendships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'ACCEPTED' CHECK (status IN ('PENDING', 'ACCEPTED', 'BLOCKED')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Prevent duplicate friending pairs
  CONSTRAINT unique_friendship UNIQUE (user_id, friend_id)
);

CREATE INDEX idx_friendships_user ON public.friendships(user_id);
CREATE INDEX idx_friendships_friend ON public.friendships(friend_id);

-- ==========================================
-- 3. ROOMS TABLE
-- ONLY created for Category 1 (Active/Passive Listeners)
-- Bandwagon Friends DO NOT create rows here!
-- ==========================================
CREATE TABLE public.rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id UUID UNIQUE NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  room_code VARCHAR(8) UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT true,
  
  -- Current track payload synced via Supabase Realtime/Presence
  current_track JSONB DEFAULT '{}'::jsonb, -- { "title": "Numb", "artist": "Linkin Park", "albumArt": "...", "uri": "..." }
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_rooms_code ON public.rooms(room_code);
CREATE INDEX idx_rooms_active ON public.rooms(is_active);

-- ==========================================
-- 4. TRACK DROPS (QUEUE & SENT RECOMMENDATIONS)
-- Tracks all drops sent across rooms
-- ==========================================
CREATE TABLE public.track_drops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES public.rooms(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  
  spotify_uri TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album_art TEXT,
  
  status TEXT DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'PLAYED', 'FAILED')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fast queries for "Room Queue" and "Sent Panel"
CREATE INDEX idx_track_drops_room ON public.track_drops(room_id);
CREATE INDEX idx_track_drops_sender ON public.track_drops(sender_id);
CREATE INDEX idx_track_drops_receiver ON public.track_drops(receiver_id);

-- ==========================================
-- 5. REALTIME ENABLEMENT
-- Allows frontend subscriptions for dynamic queues and playback updates
-- ==========================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;
ALTER PUBLICATION supabase_realtime ADD TABLE public.track_drops;

-- ==========================================
-- 6. AUTOMATIC PROFILE TRIGGER
-- Automatically creates a public profile row whenever a user signs up
-- ==========================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, username, avatar_url, spotify_id, is_guest)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      NEW.raw_user_meta_data->>'user_name',
      'guest_' || substring(NEW.id::text from 1 for 8)
    ),
    NEW.raw_user_meta_data->>'avatar_url',
    NEW.raw_user_meta_data->>'provider_id',
    (NEW.is_anonymous IS TRUE)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();