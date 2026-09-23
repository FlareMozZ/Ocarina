import { useEffect, useState } from 'react';
import axios from 'axios';
import { useLocation, useNavigate } from 'react-router-dom';
import { Disc3, Headphones, ListMusic, Plus, Radio, Search, Settings, ThumbsUp, UserPlus, Users, Volume2 } from 'lucide-react';
import { hasSupabaseConfig, supabase } from './lib/supabase';
import { addTrackDrop, createListenerRoom, getFriendDashboard, getProfile, getRoomByCode, getRoomForHost, getRoomHistory, getRoomQueue, getSentRecommendations, getSpotifyPlayback, mapDropToTrack, markRoomDropsPlayed, pushTrackToSpotifyQueue, searchProfiles, sendFriendRequest, signInAsGuest, signInWithSpotify, subscribeToRoom, updateRoomPlayback } from './services/supabaseService';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [roomCode, setRoomCode] = useState('');
  const [userName, setUserName] = useState('');
  const [joined, setJoined] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [roomState, setRoomState] = useState(null);
  const [error, setError] = useState('');
  const [authUser, setAuthUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [friends, setFriends] = useState([]);
  const [sentRecommendations, setSentRecommendations] = useState([]);
  const [mode, setMode] = useState('welcome');
  const [roomRecord, setRoomRecord] = useState(null);
  const [spotifyProviderToken, setSpotifyProviderToken] = useState('');
  const [history, setHistory] = useState([]);
  const [historyFilter, setHistoryFilter] = useState('');
  const [friendSearch, setFriendSearch] = useState('');
  const [friendResults, setFriendResults] = useState([]);
  const [friendStatus, setFriendStatus] = useState('');

  useEffect(() => {
    const pathParts = window.location.pathname.split('/');
    if (pathParts[1] === 'room' && pathParts[2]) {
      setTimeout(() => setRoomCode(pathParts[2].toUpperCase()), 0);
    }
  }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    let mounted = true;
    const loadUser = async (user, session) => {
      if (!user || !mounted) return;
      try {
        const [nextProfile, nextFriends, nextSent] = await Promise.all([
          getProfile(user.id),
          getFriendDashboard(user.id),
          getSentRecommendations(user.id),
        ]);
        if (mounted) {
          setAuthUser(user); setProfile(nextProfile); setFriends(nextFriends); setSentRecommendations(nextSent);
          setSpotifyProviderToken(session?.provider_token || '');
            const ownRoom = user.is_anonymous ? null : await getRoomForHost(user.id);
            if (ownRoom) setRoomRecord(ownRoom);
            const roomPath = window.location.pathname.match(/^\/room\/([^/]+)/);
            if (roomPath) {
              const room = await getRoomByCode(roomPath[1]);
              const queueItems = await getRoomQueue(room.id, room.session_started_at);
              setRoomRecord(room);
              setRoomCode(room.room_code);
              setRoomState({ roomCode: room.room_code, roomId: room.id, guestCount: 0, currentlyPlaying: room.current_track?.title ? room.current_track : null, spotifyQueue: room.device_queue || [], queue: queueItems.map(mapDropToTrack) });
              setUserName(nextProfile?.username || 'Listener');
              setJoined(true);
              setMode('room');
            } else {
              setMode(user.is_anonymous ? 'guest' : 'dashboard');
              if (!user.is_anonymous) navigate('/friends');
            }
        }
      } catch (loadError) { if (mounted) setError(loadError.message); }
    };
    supabase.auth.getSession().then(({ data }) => loadUser(data.session?.user, data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => loadUser(session?.user, session));
    return () => { mounted = false; listener.subscription.unsubscribe(); };
  }, [navigate]);

  const handleSpotifyLogin = async () => {
    try { await signInWithSpotify(); } catch (loginError) { setError(loginError.message); }
  };

  const openRoom = async (codeToOpen, name) => {
    if (!codeToOpen || !name) return setError('Please enter both your name and room code.');
    try {
      const room = await getRoomByCode(codeToOpen);
      const queueItems = await getRoomQueue(room.id, room.session_started_at);
      const historyItems = await getRoomHistory(room.id);
      setRoomRecord(room);
      setRoomCode(room.room_code);
      setRoomState({ roomCode: room.room_code, roomId: room.id, guestCount: 0, currentlyPlaying: room.current_track?.title ? room.current_track : null, spotifyQueue: room.device_queue || [], queue: queueItems.map(mapDropToTrack) });
      setHistory(historyItems);
      setUserName(name);
      setJoined(true);
      setMode('room');
      navigate(`/room/${room.room_code}/music`);
      setError('');
    } catch (roomError) { setError(roomError.message || 'That room is not active.'); }
  };

  const handleGuestLogin = async () => {
    try {
      if (!hasSupabaseConfig) throw new Error('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to Ocarina/.env.local.');
      const { data } = await signInAsGuest();
      if (data.session?.user) {
        setAuthUser(data.session.user);
        setProfile(await getProfile(data.session.user.id));
      }
      await openRoom(roomCode, userName);
    } catch (loginError) { setError(loginError.message); }
  };

  const handleSearch = async (event) => {
    event.preventDefault();
    if (!searchQuery.trim()) return;
    try {
      const response = await axios.get(`${BACKEND_URL}/api/search`, { params: { roomCode, q: searchQuery } });
      setSearchResults(response.data);
    } catch (searchError) { setError(`Search failed: ${searchError.response?.data?.error || searchError.message}`); }
  };

  const addToQueue = (track) => {
    if (roomRecord?.id) {
      addTrackDrop({ roomId: roomRecord.id, senderId: authUser?.id, receiverId: roomRecord.host_id, senderName: userName, track })
        .then(() => getRoomQueue(roomRecord.id, roomRecord.session_started_at))
        .then((queueItems) => setRoomState((previous) => ({ ...previous, queue: queueItems.map((item) => ({ id: item.id, track: { id: item.spotify_uri, uri: item.spotify_uri, title: item.title, artist: item.artist, albumArt: item.album_art }, addedBy: item.sender?.username || userName, votes: 0 })) })))
        .catch((queueError) => setError(`Could not add song: ${queueError.message}`));
    } else setError('This room is not ready for queue drops yet.');
    setSearchResults([]);
    setSearchQuery('');
  };
  const voteTrack = (itemId) => window.ocarinaSocket?.emit('vote_track', { roomCode, itemId });
  useEffect(() => {
    if (!roomRecord?.id) return undefined;
    return subscribeToRoom(roomRecord.id, async (payload) => {
      const queueItems = await getRoomQueue(roomRecord.id, roomRecord.session_started_at);
      setRoomState((previous) => ({ ...previous, currentlyPlaying: payload?.table === 'rooms' ? payload.new.current_track : previous?.currentlyPlaying, spotifyQueue: payload?.table === 'rooms' ? (payload.new.device_queue || []) : previous?.spotifyQueue, queue: queueItems.map(mapDropToTrack) }));
      if (payload?.table === 'track_drops' && payload.eventType === 'INSERT' && roomRecord.host_id === authUser?.id && spotifyProviderToken) {
        try { await pushTrackToSpotifyQueue(spotifyProviderToken, payload.new.spotify_uri); } catch (queueError) { setError(queueError.message); }
      }
    });
  }, [roomRecord?.id, roomRecord?.session_started_at, roomRecord?.host_id, authUser?.id, spotifyProviderToken]);

  useEffect(() => {
    if (!roomRecord?.id || roomRecord.host_id !== authUser?.id || !spotifyProviderToken) return undefined;
    let active = true;
    let timer;
    const syncPlayback = async () => {
      try {
        const playback = await getSpotifyPlayback(spotifyProviderToken);
        if (!active) return;
        setRoomState((previous) => ({ ...previous, currentlyPlaying: playback.currentlyPlaying, spotifyQueue: playback.spotifyQueue }));
        await updateRoomPlayback(roomRecord.id, playback);
        const playedUris = (playback.currentlyPlaying ? [playback.currentlyPlaying.uri] : []);
        if (playedUris.length) await markRoomDropsPlayed(roomRecord.id, playedUris);
        const remainingMs = playback.currentlyPlaying
          ? Math.max(2500, (playback.currentlyPlaying.durationMs || 180000) - (playback.currentlyPlaying.progressMs || 0) + 750)
          : 10000;
        timer = setTimeout(syncPlayback, Math.min(remainingMs, 10000));
      } catch (playbackError) {
        if (active && !playbackError.message.includes('unavailable')) setError(playbackError.message);
        if (active) timer = setTimeout(syncPlayback, 10000);
      }
    };
    syncPlayback();
    return () => { active = false; clearTimeout(timer); };
  }, [roomRecord?.id, roomRecord?.host_id, authUser?.id, spotifyProviderToken]);

  const queue = roomState?.queue || [];
  const currentTrack = roomState?.currentlyPlaying;

  if (mode === 'dashboard') return <><FriendSearch friendSearch={friendSearch} setFriendSearch={setFriendSearch} friendResults={friendResults} friendStatus={friendStatus} onSearchFriends={async () => { try { setFriendResults(await searchProfiles(friendSearch, authUser?.id)); setFriendStatus(''); } catch (friendError) { setFriendStatus(friendError.message); } }} onAddFriend={async (friendId) => { try { await sendFriendRequest(friendId); setFriendStatus('Friend request sent.'); } catch (friendError) { setFriendStatus(friendError.message); } }} /><FriendsDashboard profile={profile} friends={friends} sentRecommendations={sentRecommendations} onOpenRoom={(friend) => openRoom(friend.room.room_code, profile?.username)} onCreateRoom={async () => { try { const code = Math.random().toString(36).slice(2, 8).toUpperCase(); const room = await createListenerRoom(authUser.id, code); setRoomRecord(room); await openRoom(room.room_code, profile?.username); } catch (roomError) { setError(roomError.message); } }} onLogout={() => supabase?.auth.signOut()} navigate={navigate} /> </>;
  if (!joined) return <Welcome roomCode={roomCode} setRoomCode={setRoomCode} userName={userName} setUserName={setUserName} error={error} onSpotifyLogin={handleSpotifyLogin} onGuestLogin={handleGuestLogin} hasSupabaseConfig={hasSupabaseConfig} />;

  return (
    <main className="app-shell">
      <header className="app-header"><div className="brand-lockup"><span className="brand-dot" /><span>ocarina</span></div><div className="room-chip"><span>ROOM</span>{roomState?.roomCode || roomCode}</div><div className="connected"><Users size={15} /> {roomState?.guestCount || 0} listening</div></header>
      <div className="content-wrap">
        {error && <div className="error-banner">{error}</div>}
        {location.pathname.endsWith('/music') && <><Deck currentTrack={currentTrack} queue={queue} navigate={navigate} roomCode={roomCode} /><QueuePanel {...{ searchQuery, setSearchQuery, handleSearch, searchResults, addToQueue, queue, spotifyQueue: roomState?.spotifyQueue || [], voteTrack }} /></>}
        {location.pathname.endsWith('/friends') && <section className="page-panel"><p className="eyebrow">FRIENDS IN THIS ROOM</p><h1>{roomState?.guestCount || 0} people are listening</h1><p className="panel-copy">Share the room code <strong>{roomState?.roomCode || roomCode}</strong> with friends and let everyone shape the next song.</p><div className="people-grid"><div className="person-card host-person"><span>YOU</span><strong>{userName || 'Host'}</strong><small>Room member</small></div><div className="person-card"><span>ROOM</span><strong>{roomState?.guestCount || 0}</strong><small>Connected listeners</small></div></div></section>}
        {location.pathname.endsWith('/sent') && <SentPanel recommendations={sentRecommendations} />}
        {location.pathname.endsWith('/history') && <HistoryPanel history={history} filter={historyFilter} setFilter={setHistoryFilter} />}
        {location.pathname.endsWith('/settings') && <section className="page-panel"><p className="eyebrow">PREFERENCES</p><h1>Make it yours.</h1><div className="setting-row"><span><strong>Room code</strong><small>Share this with your friends</small></span><b>{roomState?.roomCode || roomCode}</b></div><div className="setting-row"><span><strong>Account</strong><small>{profile?.username || userName}</small></span><b>Connected</b></div></section>}
      </div>
      <nav className="bottom-nav" aria-label="Main navigation">{[['music', Disc3, 'Music'], ['friends', Users, 'Friends'], ['sent', ListMusic, 'Sent'], ['history', ListMusic, 'History'], ['settings', Settings, 'Settings']].map(([id, Icon, label]) => <button key={id} className={location.pathname.endsWith(`/${id}`) ? 'active' : ''} onClick={() => navigate(`/room/${roomCode}/${id}`)} aria-label={label}><Icon size={19} /><span>{label}</span>{id === 'music' && queue.length > 0 && <i />}</button>)}</nav>
    </main>
  );
}

function Welcome({ roomCode, setRoomCode, userName, setUserName, error, onSpotifyLogin, onGuestLogin, hasSupabaseConfig }) {
  return <main className="welcome-shell"><div className="welcome-orbit orbit-one" /><div className="welcome-orbit orbit-two" /><section className="welcome-panel"><div className="brand-lockup"><span className="brand-dot" /><span>ocarina</span></div><div className="welcome-hero"><div className="hero-disc"><Disc3 size={58} strokeWidth={1.4} /></div><p className="eyebrow">THE SHARED SOUNDTRACK</p><h1>Make the room<br /><em>sing together.</em></h1><p className="welcome-copy">Listen with friends, discover active rooms, and shape the next song.</p></div>{error && <div className="error-banner">{error}</div>}<button className="spotify-login" onClick={onSpotifyLogin}><Radio size={16} /> Login with Spotify <span>→</span></button><div className="host-divider"><span>or join nearby</span></div><form className="join-form" onSubmit={(event) => { event.preventDefault(); onGuestLogin(); }}><label>Your name<input value={userName} onChange={(event) => setUserName(event.target.value)} placeholder="e.g. Maya" /></label><label>Room code<input value={roomCode} maxLength={8} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} placeholder="ROOM CODE" /></label><button className="primary-action" type="submit">Join as a guest <span>→</span></button></form>{!hasSupabaseConfig && <small className="config-note">Add Supabase keys to enable account login and guest sessions.</small>}</section></main>;
}

function FriendsDashboard({ profile, friends, sentRecommendations, onOpenRoom, onCreateRoom, onLogout }) {
  return <main className="app-shell"><header className="app-header"><div className="brand-lockup"><span className="brand-dot" /><span>ocarina</span></div><div className="dashboard-user">{profile?.username || 'Listener'}</div><button className="text-button" onClick={onLogout}>Log out</button></header><div className="content-wrap dashboard"><section className="dashboard-intro"><p className="eyebrow">BANDWAGON MODE</p><h1>Who's playing?</h1><p className="panel-copy">Jump into a friend's active room and send a song their way. You do not need to start a room to join the fun.</p><button className="primary-action dashboard-action" onClick={onCreateRoom}><Radio size={16} /> Start my listening room <span>→</span></button></section><section><div className="section-label"><span>ACTIVE FRIENDS</span><small>{friends.filter((friend) => friend.room).length} listening now</small></div>{friends.filter((friend) => friend.room).length === 0 ? <div className="empty-state dashboard-empty"><Users size={28} /><p>No active rooms yet.</p><small>When a friend starts listening, their room will appear here.</small></div> : <div className="friend-list">{friends.filter((friend) => friend.room).map((friend) => <button className="friend-card" style={{ '--friend-color': friend.color }} key={friend.id} onClick={() => onOpenRoom(friend)}><span className="friend-avatar">{friend.username.slice(0, 2).toUpperCase()}</span><span><strong>{friend.username}</strong><small>{friend.room.current_track?.title || 'Room is open for suggestions'}</small></span><b>→</b></button>)}</div>}</section><section className="sent-section"><div className="section-label"><span>RECOMMENDATIONS SENT</span><small>{sentRecommendations.length} friends</small></div>{sentRecommendations.length === 0 ? <p className="muted-note">Songs you recommend to friends will collect here.</p> : sentRecommendations.map((group) => <div className="recommendation-card" style={{ '--friend-color': group.color }} key={group.friend.id}><strong>{group.friend.username}</strong>{group.songs.slice(0, 3).map((song) => <span key={song.id}>{song.title}<small>{new Date(song.created_at).toLocaleDateString()}</small></span>)}</div>)}</section></div></main>;
}

function FriendSearch({ friendSearch, setFriendSearch, friendResults, friendStatus, onSearchFriends, onAddFriend }) {
  return <section className="friend-search"><div className="section-label"><span>ADD FRIENDS</span><small>Search by username</small></div><form className="search-box" onSubmit={(event) => { event.preventDefault(); onSearchFriends(); }}><UserPlus size={17} /><input value={friendSearch} onChange={(event) => setFriendSearch(event.target.value)} placeholder="Find a friend..." /><button type="submit">Search</button></form>{friendStatus && <p className="muted-note">{friendStatus}</p>}{friendResults.map((friend) => <div className="friend-result" key={friend.id}><span><strong>{friend.username}</strong><small>{friend.is_guest ? 'Guest profile' : 'Spotify member'}</small></span><button onClick={() => onAddFriend(friend.id)}>Add</button></div>)}</section>;
}

function Deck({ currentTrack, queue, navigate, roomCode }) {
  return <section className="deck-view"><div className="status-line"><span><Headphones size={14} /> Shared room audio</span><span className="live-pill"><i /> LIVE SESSION</span></div><div className="now-playing"><div className="artwork-frame">{currentTrack?.albumArt ? <img src={currentTrack.albumArt} alt="Album artwork" /> : <Disc3 size={92} strokeWidth={1} />}</div><p className="eyebrow">NOW PLAYING</p><h1>{currentTrack?.title || 'The room is ready'}</h1><p className="artist">{currentTrack?.artist || 'Add a song to start the soundtrack'}</p><div className="fake-progress"><span /></div><div className="player-meta"><span>00:00</span><span><Volume2 size={14} /> Host controls playback</span><span>--:--</span></div></div>{queue[0] && <div className="up-next"><img src={queue[0].track.albumArt} alt="" /><span><small>UP NEXT · {queue[0].addedBy}</small><strong>{queue[0].track.title}</strong><small>{queue[0].track.artist}</small></span><ListMusic size={18} /></div>}<button className="queue-song" onClick={() => navigate(`/room/${roomCode}/music`)}><Plus size={16} /> Queue a song</button></section>;
}

function SentPanel({ recommendations }) {
  return <section className="page-panel"><p className="eyebrow">YOUR RECOMMENDATIONS</p><h1>Sent to friends</h1><p className="panel-copy">Songs you have dropped into friends' rooms, grouped by listener.</p><div className="sent-list">{recommendations.length === 0 ? <div className="empty-state"><ListMusic size={28} /><p>No recommendations yet.</p><small>Open a friend's room to send them a song.</small></div> : recommendations.map((group) => <div className="recommendation-card" style={{ '--friend-color': group.color }} key={group.friend.id}><strong>{group.friend.username}</strong>{group.songs.map((song) => <span key={song.id}>{song.title}<small>{new Date(song.created_at).toLocaleDateString()}</small></span>)}</div>)}</div></section>;
}

function HistoryPanel({ history, filter, setFilter }) {
  const visibleHistory = history.filter((item) => !filter || item.sender?.username === filter);
  const people = [...new Set(history.map((item) => item.sender?.username).filter(Boolean))];
  return <section className="page-panel"><p className="eyebrow">ROOM HISTORY</p><h1>What has played</h1><p className="panel-copy">Past sessions stay out of today's queue, but remain available here for rediscovery.</p><select className="history-filter" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">All friends</option>{people.map((person) => <option key={person} value={person}>{person}</option>)}</select><div className="history-list">{visibleHistory.length === 0 ? <div className="empty-state"><ListMusic size={28} /><p>No history for this filter.</p></div> : visibleHistory.map((item) => <details className="history-item" key={item.id}><summary><span><strong>{item.title}</strong><small>{item.artist} · {item.sender?.username || 'Friend'}</small></span><time>{new Date(item.created_at).toLocaleDateString()}</time></summary><p>Spotify URI: {item.spotify_uri}</p></details>)}</div></section>;
}

function QueuePanel({ searchQuery, setSearchQuery, handleSearch, searchResults, addToQueue, queue, spotifyQueue, voteTrack }) {
  return <section className="queue-panel page-panel"><div className="panel-heading"><div><p className="eyebrow">COLLECTIVE QUEUE</p><h1>Up next</h1></div><span className="queue-count">{queue.length} drops</span></div><form className="search-box" onSubmit={handleSearch}><Search size={17} /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Find a song to add..." /><button type="submit">Search</button></form>{searchResults.length > 0 && <div className="search-results">{searchResults.map((track) => <div className="track-row" key={track.id}><img src={track.albumArt} alt="" /><span><strong>{track.title}</strong><small>{track.artist}</small></span><button onClick={() => addToQueue(track)}><Plus size={16} /></button></div>)}</div>}<div className="queue-list">{queue.length === 0 ? <div className="empty-state"><ListMusic size={28} /><p>Your queue is waiting.</p><small>Search for something everyone will love.</small></div> : queue.map((item) => <div className="track-row queue-track" key={item.id}><img src={item.track.albumArt} alt="" /><span><strong>{item.track.title}</strong><small>{item.track.artist} · added by {item.addedBy}</small></span><button className="vote-button" onClick={() => voteTrack(item.id)}><ThumbsUp size={15} /> {item.votes}</button></div>)}</div>{spotifyQueue.length > 0 && <div className="spotify-queue"><div className="section-label"><span>SPOTIFY DEVICE QUEUE</span><small>{spotifyQueue.length} tracks</small></div>{spotifyQueue.map((track) => <div className="track-row" key={`spotify-${track.id}`}><img src={track.albumArt} alt="" /><span><strong>{track.title}</strong><small>{track.artist} · on Spotify</small></span></div>)}</div>}</section>;
}
