import axios from 'axios';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || `http://${window.location.hostname}:5000`;
const api = axios.create({ baseURL: BACKEND_URL, withCredentials: true });

async function request(config) {
  const { data } = await api.request(config);
  return data;
}

export const getSession = () => request({ method: 'GET', url: '/auth/me' });
export const getProfile = () => request({ method: 'GET', url: '/api/profile' });
export const getFriends = () => request({ method: 'GET', url: '/api/friends' });
export const getIncomingRequests = () => request({ method: 'GET', url: '/api/friends/requests' });
export const getSentDrops = () => request({ method: 'GET', url: '/api/drops/sent' });
export const getBacklog = () => request({ method: 'GET', url: '/api/backlog' });
export const getRoom = (code) => request({ method: 'GET', url: `/api/rooms/${encodeURIComponent(code)}` });
export const getRoomDrops = (code) => request({ method: 'GET', url: `/api/drops/room/${encodeURIComponent(code)}` });

export async function searchFriends(query) {
  return request({ method: 'GET', url: '/api/profile/search', params: { q: query } });
}

export async function searchTracks(query, roomCode) {
  return request({ method: 'GET', url: '/api/search', params: { q: query, roomCode } });
}

export const sendFriendRequest = (targetUserId) => request({
  method: 'POST', url: '/api/friends/request', data: { targetUserId },
});

export const acceptFriendRequest = (requestId) => request({
  method: 'PUT', url: `/api/friends/requests/${encodeURIComponent(requestId)}/accept`,
});

export const removeFriend = (friendId) => request({
  method: 'DELETE', url: `/api/friends/${encodeURIComponent(friendId)}`,
});

export const createRoom = () => request({ method: 'POST', url: '/api/rooms/start-listening' });
export const logout = () => request({ method: 'POST', url: '/auth/logout' });

export const closeRoom = (code) => request({
  method: 'DELETE', url: `/api/rooms/${encodeURIComponent(code)}`,
});

export const quickDrop = (friendId, track) => request({
  method: 'POST', url: '/api/drops', data: { friendId, track },
});

export const addBacklogItem = (itemId) => request({
  method: 'POST', url: `/api/backlog/${encodeURIComponent(itemId)}/queue`,
});

export const dismissBacklogItem = (itemId) => request({
  method: 'DELETE', url: `/api/backlog/${encodeURIComponent(itemId)}`,
});

export const clearBacklog = () => request({ method: 'DELETE', url: '/api/backlog' });

export const writeDropNote = (dropId, note) => request({
  method: 'PUT', url: `/api/drops/${encodeURIComponent(dropId)}/note`, data: { note },
});

export const updateProfile = (changes) => request({
  method: 'PUT', url: '/api/profile', data: changes,
});

export const deleteProfile = () => request({ method: 'DELETE', url: '/api/profile' });
