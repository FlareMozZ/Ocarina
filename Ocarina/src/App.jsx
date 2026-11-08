import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Check, Copy, Disc3,
  Headphones, Heart, ListMusic, LockKeyhole, LogOut, Music2, Plus, Radio, Search,
  Send, Settings, Shuffle, Sparkles, ThumbsUp, Trash2, UserMinus, Users, X,
} from 'lucide-react';
import {
  acceptFriendRequest, addBacklogItem, clearBacklog, closeRoom, createRoom, dismissBacklogItem,
  deleteProfile, getBacklog, getFriends, getIncomingRequests, getProfile, getRoom, getRoomDrops, getSentDrops,
  getSession, logout, quickDrop, searchFriends, searchTracks, updateProfile, writeDropNote,
  removeFriend, sendFriendRequest,
} from './services/backendService';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || `http://${window.location.hostname}:5000`;
const EMPTY_ROOM = { guestCount: 0, queue: [], recentPlays: [], currentlyPlaying: null };

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const socketRef = useRef(null);
  const sessionRef = useRef(null);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]);
  const [sentDrops, setSentDrops] = useState([]);
  const [backlog, setBacklog] = useState([]);
  const [room, setRoom] = useState(null);
  const [ownRoomCode, setOwnRoomCode] = useState('');
  const [roomDrops, setRoomDrops] = useState([]);
  const [isHost, setIsHost] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(new URLSearchParams(location.search).has('error')
    ? 'Spotify sign-in did not complete. Please try again.' : '');
  const [notice, setNotice] = useState('');
  const [guestName, setGuestName] = useState('');
  const [roomCodeInput, setRoomCodeInput] = useState(location.pathname.match(/^\/room\/([^/]+)/)?.[1]?.toUpperCase() || '');

  const showError = useCallback((err) => {
    setError(err?.response?.data?.error || err?.message || 'Something went wrong. Please try again.');
    setNotice('');
  }, []);

  const refreshSocial = useCallback(async () => {
    if (session?.sessionType !== 'spotify') return;
    const [nextProfile, nextFriends, nextRequests, nextSent, nextBacklog] = await Promise.all([
      getProfile(), getFriends(), getIncomingRequests(), getSentDrops(), getBacklog(),
    ]);
    setProfile(nextProfile);
    setFriends(nextFriends);
    setRequests(nextRequests);
    setSentDrops(nextSent);
    setBacklog(nextBacklog);
  }, [session]);

  const loadRoom = useCallback(async (code, hostHint = false) => {
    const [roomInfo, drops] = await Promise.all([getRoom(code), getRoomDrops(code)]);
    const activeSession = sessionRef.current;
    const active = activeSession?.sessionType === 'spotify'
      ? await axios.get(`${BACKEND_URL}/api/rooms/my/active`, { withCredentials: true }).catch((err) => {
        if (err.response?.status === 401 || err.response?.status === 403) return { data: { hasActiveRoom: false } };
        throw err;
      })
      : { data: { hasActiveRoom: false } };
    if (active.data.hasActiveRoom) setOwnRoomCode(active.data.roomCode);
    const host = hostHint || (active.data.hasActiveRoom && active.data.roomCode === roomInfo.code);
    setRoom({ ...EMPTY_ROOM, roomCode: roomInfo.code, host: roomInfo.host, currentlyPlaying: roomInfo.currentTrack, ...roomInfo });
    setRoomDrops(drops);
    setRoomCodeInput(roomInfo.code);
    setIsHost(host);
    setError('');
    navigate(`/room/${roomInfo.code}/music`, { replace: true });
  }, [navigate]);

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      try {
        const currentSession = await getSession();
        if (!active) return;
        sessionRef.current = currentSession;
        setSession(currentSession);
        if (currentSession.sessionType === 'spotify') {
          const [nextProfile, nextFriends, nextRequests, nextSent, nextBacklog, activeRoom] = await Promise.all([
            getProfile(), getFriends(), getIncomingRequests(), getSentDrops(), getBacklog(),
            axios.get(`${BACKEND_URL}/api/rooms/my/active`, { withCredentials: true }),
          ]);
          if (!active) return;
          setProfile(nextProfile);
          setFriends(nextFriends);
          setRequests(nextRequests);
          setSentDrops(nextSent);
          setBacklog(nextBacklog);
          setOwnRoomCode(activeRoom.data.roomCode || '');
          const requestedRoom = window.location.pathname.match(/^\/room\/([^/]+)/);
          if (requestedRoom) {
            await loadRoom(requestedRoom[1], new URLSearchParams(window.location.search).get('isHost') === 'true');
          } else if (window.location.pathname === '/' && activeRoom.data.hasActiveRoom) {
            await loadRoom(activeRoom.data.roomCode, true);
          } else if (window.location.pathname === '/') {
            navigate('/friends', { replace: true });
          }
        } else if (currentSession.sessionType === 'guest') {
          setGuestName(currentSession.guestName);
          if (window.location.pathname.startsWith('/room/')) {
            await loadRoom(currentSession.roomCode);
          } else {
            navigate(`/room/${currentSession.roomCode}/music`, { replace: true });
            await loadRoom(currentSession.roomCode);
          }
        }
      } catch (loadError) {
        if (loadError.response?.status !== 401 && active) showError(loadError);
      } finally {
        if (active) setLoading(false);
      }
    };
    initialize();
    return () => { active = false; };
  }, [loadRoom, navigate, showError]);

  useEffect(() => {
    if (!room?.roomCode || !session) return undefined;
    const socket = io(BACKEND_URL, { withCredentials: true, transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => {
      if (isHost) socket.emit('host_connect', { roomCode: room.roomCode, userId: session.id });
      else socket.emit('join_room', {
        roomCode: room.roomCode,
        userName: session.sessionType === 'guest' ? session.guestName : profile?.username,
        userId: session.sessionType === 'spotify' ? session.id : undefined,
      });
    });
    socket.on('room_state_update', (nextState) => {
      setRoom((previous) => ({ ...previous, ...nextState }));
      getRoomDrops(room.roomCode)
        .then((drops) => setRoomDrops((previous) => mergeLiveQueue(drops, nextState.queue || [], previous)))
        .catch((dropError) => {
          setRoomDrops((previous) => mergeLiveQueue(previous, nextState.queue || [], previous));
          showError(dropError);
        });
    });
    socket.on('track_echoed', ({ artist, echoed = [] }) => {
      const echoedIds = new Set(echoed);
      setRoomDrops((drops) => drops.map((drop) => echoedIds.has(drop.id) ? { ...drop, wasEchoed: true } : drop));
      setSentDrops((groups) => groups.map((group) => ({
        ...group,
        drops: group.drops.map((drop) => echoedIds.has(drop.id) ? { ...drop, wasEchoed: true } : drop),
      })));
      setNotice(`The room carried on with ${artist} — your drop echoed.`);
    });
    socket.on('room_closed', ({ message }) => {
      setRoom(null);
      setNotice(message || 'This listening room has closed.');
      navigate('/friends');
    });
    socket.on('error_message', ({ message }) => showError(new Error(message)));
    socket.on('connect_error', (connectError) => showError(connectError));
    return () => {
      socket.emit('leave_room', { roomCode: room.roomCode });
      socket.disconnect();
      socketRef.current = null;
    };
  }, [isHost, navigate, profile?.username, room?.roomCode, session, showError]);

  const handleSpotifyLogin = () => { window.location.href = `${BACKEND_URL}/auth/spotify`; };

  const joinAsGuest = async (event) => {
    event.preventDefault();
    try {
      const { data } = await axios.post(`${BACKEND_URL}/auth/guest`, {
        username: guestName, roomCode: roomCodeInput,
      }, { withCredentials: true });
      const guestSession = { sessionType: 'guest', id: data.guestId, guestName: data.guestName, roomCode: data.roomCode };
      sessionRef.current = guestSession;
      setSession(guestSession);
      setGuestName(data.guestName);
      await loadRoom(data.roomCode);
    } catch (joinError) { showError(joinError); }
  };

  const signOut = async () => {
    try {
      await logout();
      socketRef.current?.disconnect();
      sessionRef.current = null;
      setSession(null); setProfile(null); setRoom(null); setIsHost(false); setOwnRoomCode('');
      navigate('/');
    } catch (logoutError) { showError(logoutError); }
  };

  const startRoom = async () => {
    try {
      if (ownRoomCode) {
        await loadRoom(ownRoomCode, true);
        return;
      }
      const result = await createRoom();
      setOwnRoomCode(result.roomCode);
      await loadRoom(result.roomCode, true);
      setNotice('Your listening room is live. Keep Spotify open on an active device.');
    } catch (roomError) { showError(roomError); }
  };

  if (loading) return <LoadingScreen />;
  if (error && !session && !location.pathname.startsWith('/room/')) {
    return <Welcome error={error} guestName={guestName} setGuestName={setGuestName} roomCode={roomCodeInput} setRoomCode={setRoomCodeInput} onSpotifyLogin={handleSpotifyLogin} onJoin={joinAsGuest} />;
  }
  if (!session) {
    if (location.pathname.startsWith('/room/')) {
      return <Welcome error={error} guestName={guestName} setGuestName={setGuestName} roomCode={roomCodeInput} setRoomCode={setRoomCodeInput} onSpotifyLogin={handleSpotifyLogin} onJoin={joinAsGuest} />;
    }
    return <Welcome error={error} guestName={guestName} setGuestName={setGuestName} roomCode={roomCodeInput} setRoomCode={setRoomCodeInput} onSpotifyLogin={handleSpotifyLogin} onJoin={joinAsGuest} />;
  }

  const currentPage = location.pathname.split('/').filter(Boolean).at(-1) || 'friends';
  const roomPage = location.pathname.startsWith('/room/');
  if (roomPage && room) {
    return (
      <RoomApp
        room={room}
        roomDrops={roomDrops}
        isHost={isHost}
        session={session}
        profile={profile}
        ownRoomCode={ownRoomCode}
        currentPage={currentPage}
        error={error}
        notice={notice}
        onClearMessage={() => { setError(''); setNotice(''); }}
        onLogout={signOut}
        onLeave={async () => {
          if (isHost) {
            try { await closeRoom(room.roomCode); } catch (closeError) { showError(closeError); return; }
            setOwnRoomCode('');
          }
          socketRef.current?.emit('leave_room', { roomCode: room.roomCode });
          setRoom(null); setIsHost(false); navigate(session.sessionType === 'spotify' ? '/friends' : '/');
        }}
        onAddTrack={(track) => socketRef.current?.emit('add_to_queue', {
          roomCode: room.roomCode, track, userName: session.sessionType === 'guest' ? session.guestName : profile?.username,
          userId: session.sessionType === 'spotify' ? session.id : undefined,
        })}
        onAddChain={(tracks) => socketRef.current?.emit('add_chain', {
          roomCode: room.roomCode, tracks,
          userName: session.sessionType === 'guest' ? session.guestName : profile?.username,
          userId: session.sessionType === 'spotify' ? session.id : undefined,
        })}
        onVote={(itemId) => socketRef.current?.emit('vote_track', { roomCode: room.roomCode, itemId })}
        onLock={(itemId) => socketRef.current?.emit('lock_queue_item', { roomCode: room.roomCode, itemId, hostUserId: session.id })}
        onSearch={searchTracks}
        onSaveNote={async (dropId, note) => {
          try { await writeDropNote(dropId, note); setRoomDrops((items) => items.map((item) => item.id === dropId ? { ...item, hostNote: note } : item)); }
          catch (noteError) { showError(noteError); }
        }}
      />
    );
  }

  if (session.sessionType === 'guest') return <Welcome error="Enter the room code from your invite to rejoin." guestName={guestName} setGuestName={setGuestName} roomCode={roomCodeInput} setRoomCode={setRoomCodeInput} onSpotifyLogin={handleSpotifyLogin} onJoin={joinAsGuest} />;

  return (
    <Dashboard
      profile={profile}
      friends={friends}
      requests={requests}
      sentDrops={sentDrops}
      backlog={backlog}
      currentPage={currentPage}
      error={error}
      notice={notice}
      onClearMessage={() => { setError(''); setNotice(''); }}
      onStartRoom={startRoom}
      onJoinRoom={(code) => loadRoom(code)}
      onLogout={signOut}
      onSearchFriends={searchFriends}
      onSendFriendRequest={sendFriendRequest}
      onActionError={showError}
      onAcceptRequest={async (id) => { try { await acceptFriendRequest(id); await refreshSocial(); } catch (acceptError) { showError(acceptError); } }}
      onRemoveFriend={async (friendId) => { try { await removeFriend(friendId); await refreshSocial(); } catch (removeError) { showError(removeError); } }}
      onQuickDrop={async (friendId, track) => {
        try { await quickDrop(friendId, track); setNotice(`Dropped “${track.title}” to your friend.`); await refreshSocial(); }
        catch (dropError) { showError(dropError); }
      }}
      onBacklogQueue={async (id) => {
        try { const result = await addBacklogItem(id); setBacklog((items) => items.filter((item) => item.id !== id)); await loadRoom(result.roomCode, true); }
        catch (backlogError) { showError(backlogError); }
      }}
      onDismissBacklog={async (id) => {
        try { if (id) { await dismissBacklogItem(id); setBacklog((items) => items.filter((item) => item.id !== id)); } else { await clearBacklog(); setBacklog([]); } }
        catch (backlogError) { showError(backlogError); }
      }}
      onSaveProfile={async (changes) => {
        try { setProfile(await updateProfile(changes)); setNotice('Profile saved.'); }
        catch (profileError) { showError(profileError); }
      }}
      onDeleteAccount={async () => {
        try {
          await deleteProfile();
          sessionRef.current = null;
          setSession(null); setProfile(null); setOwnRoomCode(''); navigate('/');
        } catch (deleteError) { showError(deleteError); }
      }}
    />
  );
}

function LoadingScreen() {
  return <main className="loading-screen"><span className="brand-dot" /><p>Finding your people…</p></main>;
}

function Welcome({ error, guestName, setGuestName, roomCode, setRoomCode, onSpotifyLogin, onJoin }) {
  return (
    <main className="welcome-shell">
      <div className="welcome-orbit orbit-one" /><div className="welcome-orbit orbit-two" />
      <section className="welcome-panel">
        <Brand />
        <div className="welcome-hero">
          <div className="hero-disc"><Disc3 size={58} strokeWidth={1.4} /></div>
          <p className="eyebrow">THE SHARED SOUNDTRACK</p>
          <h1>Make the room<br /><em>sing together.</em></h1>
          <p className="welcome-copy">Listen with friends, read the room, and shape the next song together.</p>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button className="spotify-login" onClick={onSpotifyLogin}><Radio size={17} /> Continue with Spotify <ArrowRight size={17} /></button>
        <div className="host-divider"><span>or join a listening room</span></div>
        <form className="join-form" onSubmit={onJoin}>
          <label>Your name<input required maxLength={30} value={guestName} onChange={(event) => setGuestName(event.target.value)} placeholder="e.g. Maya" /></label>
          <label>Room code<input required maxLength={8} value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} placeholder="6-LETTER CODE" /></label>
          <button className="primary-action" type="submit">Join as a guest <ArrowRight size={17} /></button>
        </form>
        <p className="welcome-footnote">No Spotify account needed to join a friend’s room.</p>
      </section>
    </main>
  );
}

function Brand() {
  return <div className="brand-lockup"><span className="brand-dot" /><span>ocarina</span></div>;
}

function Dashboard({
  profile, ownRoomCode, friends, requests, sentDrops, backlog, currentPage, error, notice, onClearMessage,
  onStartRoom, onJoinRoom, onLogout, onSearchFriends, onSendFriendRequest, onActionError, onAcceptRequest, onRemoveFriend, onQuickDrop,
  onBacklogQueue, onDismissBacklog, onSaveProfile, onDeleteAccount,
}) {
  const [query, setQuery] = useState('');
  const [friendResults, setFriendResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [profileName, setProfileName] = useState(profile?.username || '');
  const [profileBusy, setProfileBusy] = useState(false);
  const [quickSearch, setQuickSearch] = useState('');
  const [quickResults, setQuickResults] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const activeFriends = friends.filter((friend) => friend.isListening);

  const submitFriendSearch = async (event) => {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try { setFriendResults(await onSearchFriends(query.trim())); }
    catch (searchError) { setFriendResults([]); onActionError(searchError); }
    finally { setSearching(false); }
  };

  const quickTrackSearch = async (friendId, event) => {
    event.preventDefault();
    if (!quickSearch.trim()) return;
    try {
      const tracks = await searchTracks(quickSearch.trim());
      setQuickResults((previous) => ({ ...previous, [friendId]: tracks }));
    } catch (searchError) { setQuickResults((previous) => ({ ...previous, [friendId]: [] })); onActionError(searchError); }
  };

  return (
    <main className="app-shell">
      <AppHeader profile={profile} onLogout={onLogout} />
      <div className="dashboard-layout">
        <aside className="side-nav">
          <p className="eyebrow">YOUR SPACE</p>
          <SideLink id="friends" active={currentPage === 'friends'} icon={Users} label="Friends" count={requests.length} />
          <SideLink id="sent" active={currentPage === 'sent'} icon={Send} label="Sent drops" />
          <SideLink id="backlog" active={currentPage === 'backlog'} icon={ListMusic} label="Missed drops" count={backlog.length} />
          <SideLink id="settings" active={currentPage === 'settings'} icon={Settings} label="Settings" />
          <div className="sidebar-card"><Sparkles size={17} /><strong>Keep the room moving</strong><p>Drop songs that fit the moment. The queue makes space for everyone.</p></div>
        </aside>
        <div className="dashboard-main">
          <Alerts error={error} notice={notice} onClose={onClearMessage} />
          {currentPage === 'friends' && (
            <section className="page-panel">
              <div className="dashboard-intro">
                <div><p className="eyebrow">YOUR LISTENING CIRCLE</p><h1>Who's playing?</h1><p className="panel-copy">Catch a friend's vibe and send the perfect next track.</p></div>
                <button className="primary-action dashboard-action" onClick={onStartRoom}><Radio size={17} /> {ownRoomCode ? 'Open my listening room' : 'Start my listening room'} <ArrowRight size={17} /></button>
              </div>
              {requests.length > 0 && <section className="content-section">
                <SectionLabel title="FRIEND REQUESTS" count={`${requests.length} waiting`} />
                <div className="request-list">{requests.map((request) => <div className="request-card" key={request.requestId}>
                  <Avatar name={request.from.username} color={request.from.color} image={request.from.avatarUrl} />
                  <div className="person-info"><strong>{request.from.username}</strong><small>wants to connect</small></div>
                  <button className="small-action" onClick={() => onAcceptRequest(request.requestId)}><Check size={15} /> Accept</button>
                  <button className="icon-button" title={`Decline ${request.from.username}'s request`} onClick={() => onRemoveFriend(request.from.userId)}><X size={15} /></button>
                </div>)}</div>
              </section>}
              <section className="content-section">
                <SectionLabel title="ACTIVE ROOMS" count={`${activeFriends.length} listening`} />
                {activeFriends.length === 0 ? <EmptyState icon={Headphones} title="Your friends are quiet for now" copy="Add a friend, or start a room and let them pick the next song." /> :
                  <div className="friend-grid">{activeFriends.map((friend) => <article className="active-friend" key={friend.userId}>
                    <div className="friend-card-top"><Avatar name={friend.username} color={friend.color} image={friend.avatarUrl} /><span className="live-tag"><i /> LISTENING</span></div>
                    <h2>{friend.username}</h2>
                    {friend.currentTrack?.title ? <div className="track-preview"><Music2 size={15} /><span><strong>{friend.currentTrack.title}</strong><small>{friend.currentTrack.artist}</small></span></div> : <p className="muted-copy">Room is open for a recommendation.</p>}
                    {friend.recentPlays?.length > 0 && <p className="recent-hint">Recently: {friend.recentPlays.slice(-2).map((track) => track.title).filter(Boolean).join(' · ')}</p>}
                    <div className="friend-actions"><button className="secondary-action" onClick={() => onJoinRoom(friend.activeRoomCode)}>Join room <ArrowRight size={15} /></button>
                      <form className="quick-drop-form" onSubmit={(event) => quickTrackSearch(friend.userId, event)}><input aria-label={`Search tracks to send to ${friend.username}`} value={quickSearch} onChange={(event) => setQuickSearch(event.target.value)} placeholder="Quick drop…" /><button type="submit" aria-label="Search tracks"><Search size={15} /></button></form>
                    </div>
                    {(quickResults[friend.userId] || []).slice(0, 3).map((track) => <button className="quick-track" key={track.uri} onClick={() => onQuickDrop(friend.userId, track)}><span><strong>{track.title}</strong><small>{track.artist}</small></span><Plus size={16} /></button>)}
                  </article>)}</div>}
              </section>
              <section className="content-section">
                <SectionLabel title="YOUR FRIENDS" count={`${friends.length} connected`} />
                {friends.length === 0 ? <p className="muted-copy">Your accepted friends will show up here.</p> :
                  <div className="friend-directory">{friends.map((friend) => <div className="directory-row" key={friend.userId}>
                    <Avatar name={friend.username} color={friend.color} image={friend.avatarUrl} />
                    <span className="person-info"><strong>{friend.username}</strong><small>{friend.isListening ? `Listening · ${friend.currentTrack?.title || 'room open'}` : 'Not listening right now'}</small></span>
                    <button className="icon-button" title={`Remove ${friend.username}`} onClick={() => onRemoveFriend(friend.userId)}><UserMinus size={15} /></button>
                  </div>)}</div>}
              </section>
              <section className="content-section add-friend-section">
                <SectionLabel title="FIND YOUR PEOPLE" count="Search by username" />
                <form className="search-box" onSubmit={submitFriendSearch}><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Ocarina users…" /><button disabled={searching} type="submit">{searching ? 'Searching' : 'Search'}</button></form>
                {friendResults.map((friend) => <div className="friend-result" key={friend.id}><Avatar name={friend.username} color={friend.color} image={friend.avatar_url} /><span className="person-info"><strong>{friend.username}</strong><small>Ocarina listener</small></span><button className="small-action" onClick={async () => { try { await onSendFriendRequest(friend.id); setFriendResults((items) => items.filter((item) => item.id !== friend.id)); } catch (requestError) { onActionError(requestError); } }}>Add friend <Plus size={14} /></button></div>)}
              </section>
              <SentSummary sentDrops={sentDrops} />
            </section>
          )}
          {currentPage === 'sent' && <SentPage sentDrops={sentDrops} friends={friends} onQuickDrop={onQuickDrop} onError={onActionError} />}
          {currentPage === 'backlog' && <BacklogPage backlog={backlog} onQueue={onBacklogQueue} onDismiss={onDismissBacklog} />}
          {currentPage === 'settings' && <section className="page-panel settings-panel">
            <p className="eyebrow">YOUR ACCOUNT</p><h1>Make it yours.</h1><p className="panel-copy">Update your listening identity. It shapes the color friends see beside your drops.</p>
            <form className="settings-form" onSubmit={async (event) => { event.preventDefault(); setProfileBusy(true); await onSaveProfile({ username: profileName }); setProfileBusy(false); }}>
              <div className="profile-summary"><Avatar name={profile?.username} color={profile?.color} image={profile?.avatar_url} large /><span><strong>{profile?.username}</strong><small>Spotify connected</small></span></div>
              <label>Username<input required minLength={3} maxLength={30} value={profileName} onChange={(event) => setProfileName(event.target.value)} /></label>
              <button className="primary-action dashboard-action" disabled={profileBusy} type="submit">{profileBusy ? 'Saving…' : 'Save profile'} <Check size={16} /></button>
            </form>
            <div className="danger-zone"><div><strong>Delete account</strong><small>Remove your profile and social connections permanently.</small></div>{confirmDelete ? <><button className="danger-action" onClick={onDeleteAccount}>Confirm deletion</button><button className="text-button" onClick={() => setConfirmDelete(false)}>Cancel</button></> : <button className="danger-action" onClick={() => setConfirmDelete(true)}><Trash2 size={15} /> Delete account</button>}</div>
          </section>}
        </div>
      </div>
    </main>
  );
}

function AppHeader({ profile, onLogout }) {
  return <header className="app-header"><Brand /><div className="header-account"><Avatar name={profile?.username} color={profile?.color} image={profile?.avatar_url} /><span>{profile?.username || 'Listener'}</span><button className="icon-button" title="Log out" onClick={onLogout}><LogOut size={17} /></button></div></header>;
}

function SideLink({ id, active, icon: Icon, label, count }) {
  const navigate = useNavigate();
  return <button className={`side-link ${active ? 'active' : ''}`} onClick={() => navigate(`/${id}`)}><Icon size={18} /><span>{label}</span>{count > 0 && <b>{count}</b>}</button>;
}

function RoomApp({ room, roomDrops, isHost, session, profile, currentPage, error, notice, onClearMessage, onLogout, onLeave, onAddTrack, onAddChain, onVote, onLock, onSearch, onSaveNote }) {
  const navigate = useNavigate();
  const [searchText, setSearchText] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedTracks, setSelectedTracks] = useState([]);
  const [searchError, setSearchError] = useState('');
  const [copied, setCopied] = useState(false);
  const tracks = room.queue || [];
  const listenerCount = (room.guestCount || 0) + (isHost ? 1 : 0);
  const search = async (event) => {
    event.preventDefault();
    if (!searchText.trim()) return;
    setSearching(true); setSearchError('');
    try { setResults(await onSearch(searchText.trim(), room.roomCode)); }
    catch (err) { setSearchError(err.response?.data?.error || err.message); }
    finally { setSearching(false); }
  };
  const addTrack = (track) => {
    onAddTrack(track);
    setResults((items) => items.filter((item) => item.uri !== track.uri));
    setSearchText('');
  };
  const selectChainTrack = (track) => {
    setSelectedTracks((items) => items.some((item) => item.uri === track.uri)
      ? items.filter((item) => item.uri !== track.uri)
      : items.length < 2 ? [...items, track] : items);
  };
  const addChain = () => {
    if (selectedTracks.length === 2) {
      onAddChain(selectedTracks);
      setSelectedTracks([]); setResults([]); setSearchText('');
    }
  };
  const copyRoomLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/room/${room.roomCode}`);
      setCopied(true); window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
      setSearchError('Could not copy the invite link. Share the room code instead.');
    }
  };
  return (
    <main className="app-shell room-shell">
      <header className="app-header">
        <Brand />
        <div className="room-header-info"><span className="room-chip"><i /> ROOM {room.roomCode}</span><span className="connected"><Users size={15} /> {listenerCount} listening</span></div>
        <div className="header-account"><span className="host-mark">{isHost ? 'HOST' : (profile?.username || session.guestName || 'GUEST')}</span><button className="icon-button" title="Leave room" onClick={onLeave}><ArrowLeft size={17} /></button></div>
      </header>
      <div className="room-layout">
        <div className="room-main">
          <Alerts error={error || searchError} notice={notice} onClose={() => { setSearchError(''); onClearMessage(); }} />
          {currentPage === 'music' && <>
            <section className="room-hero">
              <div className="hero-copy"><p className="eyebrow"><span className="live-dot" /> LIVE LISTENING ROOM</p><h1>One room.<br /><em>Many good picks.</em></h1><p>Drop a track, read the vibe, and let the queue find its rhythm.</p></div>
              <div className="room-code-card"><span>INVITE FRIENDS</span><strong>{room.roomCode}</strong><button onClick={copyRoomLink}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy invite'}</button></div>
            </section>
            <section className="player-card">
              <div className="player-art">{room.currentlyPlaying?.albumArt ? <img src={room.currentlyPlaying.albumArt} alt="" /> : <Disc3 size={62} strokeWidth={1.2} />}</div>
              <div className="player-details"><p className="eyebrow">ON THE TURNTABLE</p><h2>{room.currentlyPlaying?.title || 'The room is ready'}</h2><p>{room.currentlyPlaying?.artist || 'Add a song to start the soundtrack'}</p><div className="player-bottom"><span><span className="live-dot" /> {room.currentlyPlaying ? 'PLAYING ON HOST DEVICE' : 'WAITING FOR A TRACK'}</span><span>{room.shuffleState ? <><Shuffle size={13} /> Shuffle on</> : 'Host controls playback'}</span></div></div>
            </section>
            <div className="room-columns">
              <section className="queue-panel">
                <div className="panel-heading"><div><p className="eyebrow">THE COMMUNITY QUEUE</p><h2>Up next <span>{tracks.length}</span></h2></div><span className="soft-pill"><Shuffle size={13} /> Fair turns</span></div>
                <p className="panel-subtitle">Songs take turns by contributor. Two-song chains stay together.</p>
                {tracks.length === 0 ? <EmptyState icon={ListMusic} title="The queue is open" copy="Search for a track and make the first drop." /> :
                  <div className="queue-list">{tracks.map((item, index) => <QueueItem key={item.id} item={item} index={index} isHost={isHost} onVote={onVote} onLock={onLock} onSaveNote={onSaveNote} />)}</div>}
              </section>
              <aside className="drop-panel">
                <div className="panel-heading"><div><p className="eyebrow">ADD TO THE VIBE</p><h2>Find a track</h2></div><Search size={18} /></div>
                <form className="track-search" onSubmit={search}><Search size={17} /><input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Song, artist, or album" /><button disabled={searching} type="submit">{searching ? '…' : 'Find'}</button></form>
                {selectedTracks.length > 0 && <div className="chain-selection"><span>{selectedTracks.length}/2 selected for a chain</span><button disabled={selectedTracks.length !== 2} onClick={addChain}>Drop together <ArrowRight size={14} /></button></div>}
                <div className="search-results">{results.map((track) => {
                  const selected = selectedTracks.some((item) => item.uri === track.uri);
                  return <article className={`track-result ${selected ? 'selected' : ''}`} key={track.uri}>
                    <AlbumImage src={track.albumArt} />
                    <span><strong>{track.title}</strong><small>{track.artist}</small></span>
                    <button className="add-track-button" title="Drop track" onClick={() => addTrack(track)}><Plus size={17} /></button>
                    <button className={`chain-track-button ${selected ? 'selected' : ''}`} onClick={() => selectChainTrack(track)}>{selected ? <Check size={13} /> : 'Chain'}</button>
                  </article>;
                })}</div>
                {results.length === 0 && <p className="search-hint">Search Spotify and drop a song into the room queue.</p>}
              </aside>
            </div>
            {room.recentPlays?.length > 0 && <section className="recent-plays"><SectionLabel title="RECENTLY PLAYED" count="Room mood" />{room.recentPlays.slice().reverse().map((track, index) => <span key={`${track.id || track.title}-${index}`}><Music2 size={13} />{track.title}<small>{track.artist}</small></span>)}</section>}
          </>}
                  {currentPage === 'friends' && <section className="page-panel"><p className="eyebrow">IN THE ROOM</p><h1>Listening together.</h1><p className="panel-copy">Share room code <strong>{room.roomCode}</strong> to invite friends. There are {listenerCount} connected listeners.</p><div className="setting-row"><span><strong>Room host</strong><small>Steering the Spotify session</small></span><b>{room.host?.username || 'Room host'}</b></div><div className="setting-row"><span><strong>Shuffle</strong><small>Spotify playback mode</small></span><b>{room.shuffleState ? 'On' : 'Off'}</b></div></section>}
          {currentPage === 'sent' && <section className="page-panel"><p className="eyebrow">ROOM DROPS</p><h1>Every pick, together.</h1><div className="room-drop-list">{roomDrops.map((drop) => <RoomDropEntry key={drop.id} drop={drop} isHost={isHost} onSaveNote={onSaveNote} />)}</div></section>}
          {currentPage === 'settings' && <section className="page-panel"><p className="eyebrow">ROOM SETTINGS</p><h1>Good vibes only.</h1><div className="setting-row"><span><strong>Room code</strong><small>Send this to friends to invite them</small></span><b>{room.roomCode}</b></div><div className="setting-row"><span><strong>Session status</strong><small>Room closes when the host leaves</small></span><b className="online-value"><i /> Live</b></div>{isHost && <button className="danger-action close-room-button" onClick={onLeave}><X size={15} /> Stop sharing this room</button>}<button className="text-button logout-room" onClick={onLogout}><LogOut size={15} /> Log out</button></section>}
        </div>
        <aside className="room-aside">
          <div className="aside-card"><SectionLabel title="ROOM ENERGY" count="Live" /><div className="energy-count"><Users size={20} /><strong>{listenerCount}</strong><span>listening now</span></div><div className="energy-bar"><i style={{ width: `${Math.min(100, 18 + listenerCount * 12)}%` }} /></div><p>Every listener can shape what comes next.</p></div>
          <div className="aside-card"><SectionLabel title="YOUR DROPS" count={`${roomDrops.length} tracks`} /><div className="drop-status-summary"><span><i className="queued-dot" /> Waiting to play <b>{roomDrops.filter((drop) => drop.status === 'QUEUED').length}</b></span><span><i className="played-dot" /> Already played <b>{roomDrops.filter((drop) => drop.status === 'PLAYED').length}</b></span></div></div>
          {session.sessionType === 'spotify' && <button className="room-exit-link" onClick={() => navigate('/friends')}><Users size={15} /> Back to your friends</button>}
          <button className="room-exit-link" onClick={onLeave}><ArrowLeft size={15} /> {isHost ? 'Stop sharing' : 'Leave this room'}</button>
        </aside>
      </div>
      <RoomNav roomCode={room.roomCode} currentPage={currentPage} queueCount={tracks.length} />
    </main>
  );
}

function QueueItem({ item, index, isHost, onVote, onLock, onSaveNote }) {
  const [note, setNote] = useState(item.hostNote || '');
  const [noteOpen, setNoteOpen] = useState(false);
  const contributor = item.addedBy?.username || item.addedBy || 'Listener';
  return <article className={`queue-item ${item.locked ? 'locked' : ''}`}>
    <span className="queue-number">{String(index + 1).padStart(2, '0')}</span>
    <AlbumImage src={item.track?.albumArt || item.albumArt} />
    <div className="queue-track-info"><strong>{item.track?.title || item.title}</strong><small>{item.track?.artist || item.artist}</small><span className="added-by"><i style={{ background: item.addedByColor || item.addedBy?.color || 'var(--blue)' }} /> {contributor}{item.chainId && <em>CHAIN {item.chainOrder === 0 ? '1/2' : '2/2'}</em>}</span></div>
    <div className="queue-controls">{isHost && <button title={item.locked ? 'Unlock position' : 'Lock position'} onClick={() => onLock(item.queueItemId || item.id)} className={item.locked ? 'locked-button' : ''}><LockKeyhole size={15} /></button>}<button title="Vote for this track" onClick={() => onVote(item.queueItemId || item.id)}><ThumbsUp size={15} /><small>{item.votes || 0}</small></button></div>
    {isHost && item.status === 'PLAYED' && <button className="note-toggle" onClick={() => setNoteOpen((open) => !open)}>{item.hostNote ? 'Edit note' : 'Leave a note'}</button>}
    {noteOpen && <form className="host-note-form" onSubmit={(event) => { event.preventDefault(); onSaveNote(item.id, note); setNoteOpen(false); }}><input maxLength={150} value={note} onChange={(event) => setNote(event.target.value)} placeholder="A little note for the person who dropped this…" /><button type="submit">Save</button></form>}
    {item.hostNote && <p className="host-note">“{item.hostNote}”</p>}
  </article>;
}

function QueueItemSmall({ item }) {
  return <div className="sent-track-line"><AlbumImage src={item.albumArt} /><span><strong>{item.title}</strong><small>{item.artist}</small></span><span className={`status-pill ${item.status?.toLowerCase()}`}>{item.status}</span>{item.wasEchoed && <span className="echo-badge"><Heart size={12} /> echoed</span>}</div>;
}

function RoomDropEntry({ drop, isHost, onSaveNote }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(drop.hostNote || '');
  return <div className="room-drop-row">
    <AlbumImage src={drop.albumArt} />
    <span><strong>{drop.title}</strong><small>{drop.artist} · from {drop.addedBy?.username || 'Listener'}</small>
      {drop.hostNote && <small className="room-drop-note">“{drop.hostNote}”</small>}
    </span>
    <span className={`status-pill ${drop.status?.toLowerCase()}`}>{drop.status}</span>
    {isHost && drop.status === 'PLAYED' && <button className="text-button room-note-button" onClick={() => setEditing((current) => !current)}>{drop.hostNote ? 'Edit note' : 'Leave note'}</button>}
    {editing && <form className="host-note-form room-drop-note-form" onSubmit={(event) => { event.preventDefault(); onSaveNote(drop.id, note); setEditing(false); }}>
      <input maxLength={150} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Write a short note (150 characters max)" />
      <button type="submit">Save note</button>
    </form>}
  </div>;
}

function SentPage({ sentDrops, friends, onQuickDrop, onError }) {
  return <section className="page-panel"><p className="eyebrow">YOUR RECOMMENDATIONS</p><h1>Little gifts, sent.</h1><p className="panel-copy">See how your drops landed. A quiet echo means your friend kept the artist going.</p>
    {sentDrops.length === 0 ? <EmptyState icon={Send} title="No drops yet" copy="Join a friend's active room and send a track their way." /> : sentDrops.map((group) => <article className="sent-group" key={group.friend.userId}><div className="sent-group-header"><Avatar name={group.friend.username} color={group.friend.color} image={group.friend.avatarUrl} /><div className="person-info"><strong>{group.friend.username}</strong><small>{group.drops.length} recommendation{group.drops.length === 1 ? '' : 's'}</small></div></div>{group.drops.map((drop) => <div className="sent-drop" key={drop.id}><QueueItemSmall item={drop} /><div className="sent-feedback">{drop.hostNote && <p>“{drop.hostNote}”</p>}{drop.wasEchoed && <span className="echo-badge"><Heart size={12} /> They kept the vibe going</span>}{drop.chainId && <span className="soft-pill">Part of a 2-song chain</span>}{!drop.hostNote && !drop.wasEchoed && <small>{drop.status === 'PLAYED' ? 'Played in their room' : 'Waiting in their queue'}</small>}</div></div>)}
      {friends.find((friend) => friend.userId === group.friend.userId)?.isListening && <QuickDropBox friend={group.friend} onQuickDrop={onQuickDrop} onError={onError} />}
    </article>)}
  </section>;
}

function QuickDropBox({ friend, onQuickDrop, onError }) {
  const [query, setQuery] = useState('');
  const [tracks, setTracks] = useState([]);
  return <div className="sent-quick-drop"><form onSubmit={async (event) => { event.preventDefault(); try { setTracks(await searchTracks(query)); } catch (error) { onError(error); } }}><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Quick drop to ${friend.username}`} /><button>Search</button></form>{tracks.map((track) => <button className="quick-track" key={track.uri} onClick={() => onQuickDrop(friend.userId, track)}><span><strong>{track.title}</strong><small>{track.artist}</small></span><Plus size={15} /></button>)}</div>;
}

function BacklogPage({ backlog, onQueue, onDismiss }) {
  return <section className="page-panel"><div className="dashboard-intro"><div><p className="eyebrow">WHILE YOU WERE AWAY</p><h1>Missed connections.</h1><p className="panel-copy">Unplayed drops from your last session, ready when you are. They expire after 48 hours.</p></div>{backlog.length > 0 && <button className="text-button clear-backlog" onClick={() => onDismiss(null)}><Trash2 size={15} /> Clear all</button>}</div>
    {backlog.length === 0 ? <EmptyState icon={ListMusic} title="Nothing waiting" copy="Unplayed recommendations from your next session will show up here." /> : <div className="backlog-list">{backlog.map((item) => <article className="backlog-item" key={item.id}><AlbumImage src={item.albumArt} /><div className="backlog-track"><strong>{item.title}</strong><small>{item.artist}</small><span>Dropped by <b>{item.droppedBy?.name}</b> · {new Date(item.droppedAt).toLocaleDateString()}</span></div><span className="expires-tag">48 HOUR INBOX</span><button className="secondary-action" onClick={() => onQueue(item.id)}><Plus size={15} /> Queue</button><button className="icon-button" title="Dismiss drop" onClick={() => onDismiss(item.id)}><X size={16} /></button></article>)}</div>}
  </section>;
}

function SentSummary({ sentDrops }) {
  const total = sentDrops.reduce((sum, group) => sum + group.drops.length, 0);
  if (!total) return null;
  return <section className="content-section"><SectionLabel title="YOUR RECENT DROPS" count={`${total} sent`} /><div className="summary-list">{sentDrops.slice(0, 3).map((group) => <div className="summary-card" key={group.friend.userId}><Avatar name={group.friend.username} color={group.friend.color} image={group.friend.avatarUrl} /><span><strong>{group.drops[0]?.title}</strong><small>to {group.friend.username} · {group.drops[0]?.status?.toLowerCase()}</small></span>{group.drops[0]?.wasEchoed && <Heart size={15} />}</div>)}</div></section>;
}

function RoomNav({ roomCode, currentPage, queueCount }) {
  const navigate = useNavigate();
  const links = [['music', Disc3, 'Music'], ['friends', Users, 'Room'], ['sent', ListMusic, 'Drops'], ['settings', Settings, 'Settings']];
  return <nav className="bottom-nav" aria-label="Room navigation">{links.map(([id, Icon, label]) => <button key={id} className={currentPage === id ? 'active' : ''} onClick={() => navigate(`/room/${roomCode}/${id}`)}><Icon size={19} /><span>{label}</span>{id === 'music' && queueCount > 0 && <i />}</button>)}</nav>;
}

function SectionLabel({ title, count }) {
  return <div className="section-label"><span>{title}</span>{count && <small>{count}</small>}</div>;
}

function EmptyState({ icon: Icon, title, copy }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={24} /></span><strong>{title}</strong><p>{copy}</p></div>;
}

function Alerts({ error, notice, onClose }) {
  if (!error && !notice) return null;
  return <div className={error ? 'error-banner app-alert' : 'notice-banner app-alert'} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button onClick={onClose} aria-label="Dismiss message"><X size={15} /></button></div>;
}

function Avatar({ name = 'Listener', color, image, large = false }) {
  return <span className={`avatar ${large ? 'large' : ''}`} style={{ backgroundColor: color || '#a5cce4' }}>
    {image ? <img src={image} alt="" /> : (name || 'Listener').slice(0, 1).toUpperCase()}
  </span>;
}

function AlbumImage({ src }) {
  return <span className="album-image">{src ? <img src={src} alt="" loading="lazy" /> : <Disc3 size={20} />}</span>;
}

function mergeLiveQueue(drops, liveQueue, previous) {
  const pending = [...liveQueue];
  const merged = drops.map((drop) => {
    const index = pending.findIndex((item) =>
      item.track?.uri === drop.spotifyUri && item.addedBy === drop.addedBy?.username);
    if (index < 0) return drop;
    const [item] = pending.splice(index, 1);
    return {
      ...drop,
      queueItemId: item.id,
      votes: item.votes,
      locked: item.locked,
    };
  });
  const previousByKey = new Map(previous.map((drop) => [`${drop.spotifyUri}:${drop.addedBy?.username}`, drop]));
  return [...merged, ...pending.map((item) => ({
    ...previousByKey.get(`${item.track?.uri}:${item.addedBy}`),
    id: previousByKey.get(`${item.track?.uri}:${item.addedBy}`)?.id || item.id,
    queueItemId: item.id,
    spotifyUri: item.track?.uri,
    title: item.track?.title,
    artist: item.track?.artist,
    albumArt: item.track?.albumArt,
    status: 'QUEUED',
    addedBy: { username: item.addedBy, color: item.addedByColor },
    chainId: item.chainId,
    chainOrder: item.chainOrder,
    votes: item.votes,
    locked: item.locked,
  }))];
}
