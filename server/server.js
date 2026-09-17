const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const channels = [
  { id: 'general', name: 'general', type: 'text' },
  { id: 'games', name: 'games', type: 'text' },
  { id: 'memes', name: 'memes', type: 'text' },
  { id: 'lobby', name: 'Lobby', type: 'voice' },
  { id: 'gaming', name: 'Gaming', type: 'voice' }
];
const messages = { general: [], games: [], memes: [] };
const users = new Map();
const groups = new Map();
const friendRequests = new Map(); // targetUserId -> Set(requesterUserId)
const friends = new Map(); // userId -> Set(friendUserId)
let groupCounter = 1;

const NAME_RE = /^[A-Za-z0-9_]{2,24}$/;

function cleanName(name) {
  const n = String(name || '').trim();
  return NAME_RE.test(n) ? n : null;
}
function publicUser(id, u) {
  return { id, name: u.name, avatar: u.avatar || '', status: u.status || 'online', game: u.game || '' };
}
function publicUsers() { return [...users.entries()].map(([id, u]) => publicUser(id, u)); }
function makeGroupId() { return 'group_' + (groupCounter++); }
function friendSet(id) { if (!friends.has(id)) friends.set(id, new Set()); return friends.get(id); }
function friendList(id) { return [...friendSet(id)].filter(x => users.has(x)); }
function emitUsers() { io.emit('users', publicUsers()); }
function emitFriends(id) {
  const list = friendList(id).map(fid => publicUser(fid, users.get(fid)));
  io.to(id).emit('friends:list', list);
}
function emitRequests(id) {
  const incoming = [...(friendRequests.get(id) || [])]
    .filter(x => users.has(x))
    .map(x => publicUser(x, users.get(x)));
  io.to(id).emit('friends:requests', incoming);
}
function emitFriendsToBoth(a, b) { emitFriends(a); emitFriends(b); }
function groupViewFor(id) {
  return [...groups.values()]
    .filter(g => g.members.includes(id))
    .map(g => ({ id: g.id, name: g.name, members: g.members }));
}
function emitGroups(id) { io.to(id).emit('groups', groupViewFor(id)); }
function roomParticipants(room) {
  return [...(io.sockets.adapter.rooms.get(room) || [])]
    .map(id => users.has(id) ? publicUser(id, users.get(id)) : null)
    .filter(Boolean);
}
function emitRoomParticipants(room) { io.to(room).emit('call:participants', roomParticipants(room)); }

// Tenor proxy. Put TENOR_API_KEY in the hosting environment; never expose the key in the browser.
app.get('/api/gifs', async (req, res) => {
  const key = process.env.TENOR_API_KEY;
  if (!key) return res.status(503).json({ error: 'Tenor API key is not configured.' });
  const q = String(req.query.q || 'funny').slice(0, 80);
  const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 24);
  const clientKey = process.env.TENOR_CLIENT_KEY || 'wecsord';
  try {
    const url = new URL('https://tenor.googleapis.com/v2/search');
    url.searchParams.set('q', q);
    url.searchParams.set('key', key);
    url.searchParams.set('client_key', clientKey);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('media_filter', 'gif,tinygif,nanogif');
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || 'Tenor request failed.' });
    const results = (data.results || []).map(x => ({
      id: x.id,
      title: x.content_description || '',
      url: x.media_formats?.gif?.url || x.media_formats?.tinygif?.url || x.media_formats?.nanogif?.url || '',
      preview: x.media_formats?.tinygif?.url || x.media_formats?.nanogif?.url || x.media_formats?.gif?.url || ''
    })).filter(x => x.url);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: 'Tenor request failed.' });
  }
});

io.on('connection', socket => {
  socket.on('join', data => {
    const requested = cleanName(data?.name);
    if (!requested) return socket.emit('join:error', 'Nickname must contain only English letters, numbers or _. Example: Alex_01');
    const taken = [...users.values()].some(u => u.name.toLowerCase() === requested.toLowerCase());
    if (taken) return socket.emit('join:error', 'This nickname is already in use.');
    users.set(socket.id, { name: requested, avatar: data?.avatar || '', status: 'online', game: '' });
    emitUsers();
    emitFriends(socket.id);
    emitRequests(socket.id);
    emitGroups(socket.id);
    io.emit('system', `${requested} joined Wecsord`);
  });

  socket.on('profile:update', data => {
    const u = users.get(socket.id); if (!u) return;
    const requested = cleanName(data?.name);
    if (!requested) return socket.emit('profile:error', 'Nickname: English letters, numbers or _ only.');
    const taken = [...users.entries()].some(([id, other]) => id !== socket.id && other.name.toLowerCase() === requested.toLowerCase());
    if (taken) return socket.emit('profile:error', 'This nickname is already in use.');
    u.name = requested;
    u.avatar = data?.avatar || '';
    u.game = String(data?.game || '').slice(0, 60);
    emitUsers();
    emitFriends(socket.id);
  });

  socket.on('channelMessages', channel => socket.emit('channelMessages', { channel, messages: messages[channel] || [] }));
  socket.on('message', ({ channel, text }) => {
    const u = users.get(socket.id);
    if (!u || !messages[channel] || !String(text).trim()) return;
    const value = String(text).slice(0, 2000);
    const m = { name: u.name, avatar: u.avatar, text: value, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    messages[channel].push(m);
    io.emit('channelMessage', { channel, message: m });
  });

  socket.on('message:gif', ({ channel, url, title }) => {
    const u = users.get(socket.id);
    if (!u || !messages[channel] || !url) return;
    const m = { name: u.name, avatar: u.avatar, gif: String(url).slice(0, 2000), gifTitle: String(title || '').slice(0, 120), time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    messages[channel].push(m);
    io.emit('channelMessage', { channel, message: m });
  });

  socket.on('createChannel', ({ name, type }) => {
    const clean = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/gi, '-').slice(0, 28);
    if (!clean) return;
    const id = clean + '_' + Date.now();
    channels.push({ id, name: clean, type: type === 'voice' ? 'voice' : 'text' });
    if (type !== 'voice') messages[id] = [];
    io.emit('channels', channels);
  });

  socket.on('friends:list', () => emitFriends(socket.id));
  socket.on('friends:requests', () => emitRequests(socket.id));
  socket.on('friends:add', targetId => {
    if (!users.has(socket.id) || !users.has(targetId) || targetId === socket.id) return;
    if (friendSet(socket.id).has(targetId)) return socket.emit('friends:info', 'You are already friends.');
    if ((friendRequests.get(socket.id) || new Set()).has(targetId)) return socket.emit('friends:info', 'This user already sent you a request.');
    if (!friendRequests.has(targetId)) friendRequests.set(targetId, new Set());
    friendRequests.get(targetId).add(socket.id);
    emitRequests(targetId);
    socket.emit('friends:info', 'Friend request sent.');
  });
  socket.on('friends:accept', requesterId => {
    const incoming = friendRequests.get(socket.id);
    if (!incoming || !incoming.has(requesterId) || !users.has(requesterId)) return;
    incoming.delete(requesterId);
    friendSet(socket.id).add(requesterId);
    friendSet(requesterId).add(socket.id);
    emitRequests(socket.id);
    emitFriendsToBoth(socket.id, requesterId);
    io.to(requesterId).emit('friends:info', `${users.get(socket.id).name} accepted your friend request.`);
  });
  socket.on('friends:remove', targetId => {
    friendSet(socket.id).delete(targetId);
    friendSet(targetId).delete(socket.id);
    emitFriendsToBoth(socket.id, targetId);
  });

  socket.on('group:create', data => {
    const name = String(data?.name || 'Group').trim().slice(0, 30) || 'Group';
    const members = [socket.id, ...(Array.isArray(data?.members) ? data.members : [])]
      .filter((x, i, a) => a.indexOf(x) === i && users.has(x) && friendSet(socket.id).has(x));
    if (members.length < 2) return socket.emit('group:error', 'Add at least one friend first.');
    const id = makeGroupId();
    groups.set(id, { id, name, members, messages: [] });
    members.forEach(emitGroups);
  });
  socket.on('group:list', () => emitGroups(socket.id));
  socket.on('group:messages', id => {
    const g = groups.get(id);
    if (g && g.members.includes(socket.id)) socket.emit('group:messages', { id, messages: g.messages });
  });
  socket.on('group:message', ({ id, text }) => {
    const g = groups.get(id), u = users.get(socket.id);
    if (!g || !g.members.includes(socket.id) || !String(text).trim()) return;
    const m = { name: u.name, avatar: u.avatar, text: String(text).slice(0, 2000), time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    g.messages.push(m); g.members.forEach(memberId => io.to(memberId).emit('group:message', { id, message: m }));
  });
  socket.on('group:gif', ({ id, url, title }) => {
    const g = groups.get(id), u = users.get(socket.id);
    if (!g || !g.members.includes(socket.id) || !url) return;
    const m = { name: u.name, avatar: u.avatar, gif: String(url).slice(0, 2000), gifTitle: String(title || '').slice(0, 120), time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    g.messages.push(m); g.members.forEach(memberId => io.to(memberId).emit('group:message', { id, message: m }));
  });

  socket.on('call:join', room => {
    if (!users.has(socket.id)) return;
    socket.join(room);
    const ids = [...(io.sockets.adapter.rooms.get(room) || [])].filter(id => id !== socket.id);
    socket.emit('call:peers', ids);
    socket.to(room).emit('call:newPeer', socket.id);
    emitRoomParticipants(room);
  });
  socket.on('call:offer', ({ to, offer }) => io.to(to).emit('call:offer', { from: socket.id, offer }));
  socket.on('call:answer', ({ to, answer }) => io.to(to).emit('call:answer', { from: socket.id, answer }));
  socket.on('call:ice', ({ to, candidate }) => io.to(to).emit('call:ice', { from: socket.id, candidate }));
  socket.on('call:leave', room => { socket.leave(room); socket.to(room).emit('call:left', socket.id); emitRoomParticipants(room); });

  socket.on('disconnect', () => {
    const u = users.get(socket.id);
    // Remove from friend relationships and pending requests.
    for (const set of friends.values()) set.delete(socket.id);
    for (const set of friendRequests.values()) set.delete(socket.id);
    users.delete(socket.id);
    if (u) io.emit('system', `${u.name} left Wecsord`);
    emitUsers();
    for (const id of users.keys()) { emitFriends(id); emitRequests(id); emitGroups(id); }
  });
});

io.on('connection', s => {
  s.emit('channels', channels);
  s.emit('users', publicUsers());
  s.emit('groups', []);
});

server.listen(PORT, () => console.log(`Wecsord running on port ${PORT}`));
