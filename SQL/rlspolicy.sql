-- 1. ENABLE RLS ON ALL TABLES
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.track_drops ENABLE ROW LEVEL SECURITY;

-- 2. PROFILES POLICIES
CREATE POLICY "Public profiles are viewable by authenticated users"
  ON public.profiles FOR SELECT TO authenticated USING (true);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);

-- 3. FRIENDSHIPS POLICIES
CREATE POLICY "Users can view their own friendships"
  ON public.friendships FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR auth.uid() = friend_id);

CREATE POLICY "Users can send or accept friendship requests"
  ON public.friendships FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Recipients can accept friendship requests"
  ON public.friendships FOR UPDATE TO authenticated
  USING (auth.uid() = friend_id)
  WITH CHECK (auth.uid() = friend_id AND status IN ('ACCEPTED', 'BLOCKED'));

CREATE POLICY "Users can delete their friendships"
  ON public.friendships FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR auth.uid() = friend_id);

-- 4. ROOMS POLICIES
CREATE POLICY "Anyone can view active rooms"
  ON public.rooms FOR SELECT TO authenticated, anon USING (is_active = true);

CREATE POLICY "Hosts can create their own room"
  ON public.rooms FOR INSERT TO authenticated WITH CHECK (auth.uid() = host_id);

CREATE POLICY "Hosts can update their own room"
  ON public.rooms FOR UPDATE TO authenticated USING (auth.uid() = host_id);

-- 5. TRACK DROPS POLICIES
CREATE POLICY "Users can view drops sent by them, sent to them, or in their active room"
  ON public.track_drops FOR SELECT TO authenticated, anon
  USING (
    auth.uid() = sender_id OR 
    auth.uid() = receiver_id OR 
    EXISTS (
      SELECT 1 FROM public.rooms WHERE rooms.id = track_drops.room_id AND rooms.is_active = true
    )
  );

CREATE POLICY "Anyone can drop a track into an active room"
  ON public.track_drops FOR INSERT TO authenticated, anon
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.rooms WHERE rooms.id = track_drops.room_id AND rooms.is_active = true
    )
  );

CREATE POLICY "Hosts can mark drops as played"
  ON public.track_drops FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.rooms WHERE rooms.id = track_drops.room_id AND rooms.host_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.rooms WHERE rooms.id = track_drops.room_id AND rooms.host_id = auth.uid()));