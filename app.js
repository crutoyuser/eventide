'use strict';
/**
 * Eventide — серверная версия соцсети (Express-приложение).
 * Прод-стек: Vercel (serverless, api/index.js) + Neon Postgres + Vercel Blob.
 * Локально: server.js (node server.js, слушает PORT).
 * Этот модуль только экспортирует app — listen здесь нет.
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { query, initDb } = require('./db');
const { uploadMedia } = require('./media');

// ---------- helpers ----------
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, name: u.name,
    isOwner: !!u.is_owner, isVerified: !!u.is_verified,
    avatar: u.avatar || null, bio: u.bio || '',
  };
}
async function getUser(id) {
  const r = await query('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
async function currentUser(req) {
  const token = parseCookies(req).eventide_session;
  if (!token) return null;
  const s = await query('SELECT user_id FROM sessions WHERE token = $1', [token]);
  return s.rows.length ? getUser(s.rows[0].user_id) : null;
}
async function requireAuth(req, res, next) {
  try {
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ error: 'Требуется вход' });
    req.user = u;
    next();
  } catch (e) { next(e); }
}
async function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
  res.setHeader('Set-Cookie',
    `eventide_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
}
// Express 4 не ловит ошибки async-обработчиков сам — оборачиваем.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
// Схема БД создаётся при старте; первый запрос ждёт готовности.
const ready = initDb();
ready.catch((e) => console.error('[db] init failed:', e.message));
app.use((req, res, next) => { ready.then(() => next(), next); });
app.use(express.static(path.join(__dirname, 'public')));

// Файлы держим в памяти и сразу отправляем в Vercel Blob (диска на Vercel нет).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(mp3|m4a|ogg|wav)$/i.test(file.originalname || '') ||
      /audio\//.test(file.mimetype || '');
    cb(ok ? null : new Error('Нужен аудиофайл: mp3, m4a, ogg или wav'), ok);
  },
});

// ---------- auth ----------
app.post('/api/register', ah(async (req, res) => {
  const { name, password } = req.body || {};
  let { username } = req.body || {};
  username = String(username || '').trim().replace(/^@/, '').toLowerCase();
  if (!name || !username || !password) return res.status(400).json({ error: 'Заполните имя, @username и пароль' });
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username: 3–24 символа, латиница, цифры и _' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Пароль слишком короткий' });
  const exists = await query('SELECT id FROM users WHERE username = $1', [username]);
  if (exists.rows.length) {
    return res.status(409).json({ error: 'Этот юзернейм уже занят' });
  }
  const count = await query('SELECT COUNT(*)::int AS c FROM users');
  const isOwner = count.rows[0].c === 0; // самый первый аккаунт — владелец
  const hash = bcrypt.hashSync(String(password), 10);
  const info = await query(
    'INSERT INTO users (username, name, password_hash, is_owner) VALUES ($1, $2, $3, $4) RETURNING id',
    [username, String(name).trim(), hash, isOwner]
  );
  await setSession(res, info.rows[0].id);
  res.json({ user: publicUser(await getUser(info.rows[0].id)) });
}));

app.post('/api/login', ah(async (req, res) => {
  const username = String((req.body || {}).username || '').trim().replace(/^@/, '').toLowerCase();
  const r = await query('SELECT * FROM users WHERE username = $1', [username]);
  const u = r.rows[0];
  if (!u || !bcrypt.compareSync(String((req.body || {}).password || ''), u.password_hash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  await setSession(res, u.id);
  res.json({ user: publicUser(u) });
}));

app.post('/api/logout', ah(async (req, res) => {
  const token = parseCookies(req).eventide_session;
  if (token) await query('DELETE FROM sessions WHERE token = $1', [token]);
  res.setHeader('Set-Cookie', 'eventide_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
}));

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/me', requireAuth, ah(async (req, res) => {
  const { name, bio } = req.body || {};
  await query('UPDATE users SET name = COALESCE($1, name), bio = COALESCE($2, bio) WHERE id = $3',
    [name ? String(name).trim() : null, bio != null ? String(bio) : null, req.user.id]);
  res.json({ user: publicUser(await getUser(req.user.id)) });
}));

app.post('/api/me/avatar', requireAuth, upload.single('avatar'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  const { url, publicId } = await uploadMedia(req.file, 'avatars');
  await query('UPDATE users SET avatar = $1, avatar_public_id = $2 WHERE id = $3', [url, publicId, req.user.id]);
  res.json({ user: publicUser(await getUser(req.user.id)) });
}));

// ---------- admin ----------
function requireOwner(req, res, next) {
  if (!req.user.is_owner) return res.status(403).json({ error: 'Админ-панель доступна только владельцу Eventide' });
  next();
}
app.get('/api/admin/users', requireAuth, requireOwner, ah(async (req, res) => {
  const rows = await query('SELECT * FROM users ORDER BY id');
  res.json({ users: rows.rows.map(publicUser) });
}));
app.post('/api/admin/verify', requireAuth, requireOwner, ah(async (req, res) => {
  const { userId, verified } = req.body || {};
  await query('UPDATE users SET is_verified = $1 WHERE id = $2', [!!verified, Number(userId)]);
  res.json({ user: publicUser(await getUser(Number(userId))) });
}));

// ---------- users, contacts, search ----------
app.get('/api/users/:id', requireAuth, ah(async (req, res) => {
  const u = await getUser(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
  const c = await query('SELECT 1 FROM contacts WHERE user_id = $1 AND contact_id = $2', [req.user.id, u.id]);
  res.json({ user: publicUser(u), isContact: c.rows.length > 0 });
}));

app.get('/api/contacts', requireAuth, ah(async (req, res) => {
  const rows = await query(`SELECT u.* FROM contacts c JOIN users u ON u.id = c.contact_id
    WHERE c.user_id = $1 ORDER BY u.name`, [req.user.id]);
  res.json({ contacts: rows.rows.map(publicUser) });
}));
app.post('/api/contacts', requireAuth, ah(async (req, res) => {
  const id = Number((req.body || {}).userId);
  if (!id || id === req.user.id || !(await getUser(id))) return res.status(400).json({ error: 'Некорректный пользователь' });
  await query('INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, id]);
  res.json({ ok: true });
}));
app.delete('/api/contacts/:id', requireAuth, ah(async (req, res) => {
  await query('DELETE FROM contacts WHERE user_id = $1 AND contact_id = $2', [req.user.id, Number(req.params.id)]);
  res.json({ ok: true });
}));

// Поиск с фильтрацией в JS: так кириллица ищется без учёта регистра
// (подход сохранён с SQLite-версии).
async function searchUsers(q, excludeId, limit = 10) {
  const needle = q.toLowerCase();
  const r = await query('SELECT * FROM users WHERE id != $1 ORDER BY is_verified DESC, name', [excludeId]);
  return r.rows
    .filter((u) => u.name.toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle))
    .slice(0, limit).map(publicUser);
}
async function searchChannels(q, limit = 10) {
  const needle = q.toLowerCase();
  const r = await query(`SELECT c.*, (SELECT COUNT(*)::int FROM channel_subs s WHERE s.channel_id = c.id) AS subs
    FROM channels c ORDER BY subs DESC`);
  return r.rows
    .filter((c) => c.name.toLowerCase().includes(needle) || c.username.toLowerCase().includes(needle))
    .slice(0, limit)
    .map((c) => ({ id: c.id, name: c.name, username: c.username, description: c.description, subs: c.subs, ownerId: c.owner_id }));
}

app.get('/api/search', requireAuth, ah(async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/^@/, '');
  if (!q) return res.json({ users: [], channels: [], chats: [] });
  const users = await searchUsers(q, req.user.id);
  const channels = await searchChannels(q);
  const needle = q.toLowerCase();
  const cr = await query(`SELECT DISTINCT u.* FROM messages m JOIN users u
      ON u.id = CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END
    WHERE m.sender_id = $1 OR m.receiver_id = $1`, [req.user.id]);
  const chats = cr.rows
    .filter((u) => u.name.toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle))
    .slice(0, 10).map(publicUser);
  res.json({ users, channels, chats });
}));

// ---------- posts (feed) ----------
async function postView(p, meId) {
  const author = publicUser(await getUser(p.user_id));
  const likesR = await query('SELECT COUNT(*)::int AS c FROM post_likes WHERE post_id = $1', [p.id]);
  const likedR = await query('SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2', [p.id, meId]);
  const commentsR = await query(`SELECT c.*, u.username, u.name, u.avatar, u.is_verified, u.is_owner
      FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = $1 ORDER BY c.id`, [p.id]);
  const comments = commentsR.rows.map((c) => ({ id: c.id, text: c.text, createdAt: c.created_at,
    author: { id: c.user_id, username: c.username, name: c.name, avatar: c.avatar, isVerified: !!c.is_verified, isOwner: !!c.is_owner } }));
  return { id: p.id, text: p.text, image: p.image, createdAt: p.created_at, author, likes: likesR.rows[0].c, liked: likedR.rows.length > 0, comments };
}
async function getPost(id) {
  const r = await query('SELECT * FROM posts WHERE id = $1', [id]);
  return r.rows[0] || null;
}
app.get('/api/posts', requireAuth, ah(async (req, res) => {
  const rows = await query('SELECT * FROM posts ORDER BY id DESC LIMIT 100');
  res.json({ posts: await Promise.all(rows.rows.map((p) => postView(p, req.user.id))) });
}));
app.post('/api/posts', requireAuth, upload.single('image'), ah(async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  let image = null, imagePublicId = null;
  if (req.file) {
    const up = await uploadMedia(req.file, 'posts');
    image = up.url; imagePublicId = up.publicId;
  }
  if (!text && !image) return res.status(400).json({ error: 'Пост пустой' });
  const info = await query('INSERT INTO posts (user_id, text, image, image_public_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.user.id, text, image, imagePublicId]);
  res.json({ post: await postView(await getPost(info.rows[0].id), req.user.id) });
}));
app.post('/api/posts/:id/like', requireAuth, ah(async (req, res) => {
  const id = Number(req.params.id);
  const has = await query('SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2', [id, req.user.id]);
  if (has.rows.length) await query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [id, req.user.id]);
  else await query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)', [id, req.user.id]);
  res.json({ post: await postView(await getPost(id), req.user.id) });
}));
app.post('/api/posts/:id/comments', requireAuth, ah(async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Комментарий пустой' });
  await query('INSERT INTO comments (post_id, user_id, text) VALUES ($1, $2, $3)', [Number(req.params.id), req.user.id, text]);
  res.json({ post: await postView(await getPost(Number(req.params.id)), req.user.id) });
}));

// ---------- reels ----------
async function reelView(r, meId) {
  const likesR = await query('SELECT COUNT(*)::int AS c FROM reel_likes WHERE reel_id = $1', [r.id]);
  const likedR = await query('SELECT 1 FROM reel_likes WHERE reel_id = $1 AND user_id = $2', [r.id, meId]);
  return { id: r.id, video: r.video, caption: r.caption, createdAt: r.created_at,
    author: publicUser(await getUser(r.user_id)), likes: likesR.rows[0].c, liked: likedR.rows.length > 0 };
}
async function getReel(id) {
  const r = await query('SELECT * FROM reels WHERE id = $1', [id]);
  return r.rows[0] || null;
}
app.get('/api/reels', requireAuth, ah(async (req, res) => {
  const rows = await query('SELECT * FROM reels ORDER BY id DESC LIMIT 50');
  res.json({ reels: await Promise.all(rows.rows.map((r) => reelView(r, req.user.id))) });
}));
app.post('/api/reels', requireAuth, upload.single('video'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет видео' });
  const up = await uploadMedia(req.file, 'reels');
  const info = await query('INSERT INTO reels (user_id, video, video_public_id, caption) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.user.id, up.url, up.publicId, String((req.body || {}).caption || '')]);
  res.json({ reel: await reelView(await getReel(info.rows[0].id), req.user.id) });
}));
app.post('/api/reels/:id/like', requireAuth, ah(async (req, res) => {
  const id = Number(req.params.id);
  const has = await query('SELECT 1 FROM reel_likes WHERE reel_id = $1 AND user_id = $2', [id, req.user.id]);
  if (has.rows.length) await query('DELETE FROM reel_likes WHERE reel_id = $1 AND user_id = $2', [id, req.user.id]);
  else await query('INSERT INTO reel_likes (reel_id, user_id) VALUES ($1, $2)', [id, req.user.id]);
  res.json({ reel: await reelView(await getReel(id), req.user.id) });
}));

// ---------- messages / chats ----------
function msgView(m) {
  return { id: m.id, senderId: m.sender_id, receiverId: m.receiver_id, text: m.text,
    sharedType: m.shared_type, sharedRef: m.shared_ref, sharedLabel: m.shared_label,
    read: !!m.read_at, createdAt: m.created_at };
}
app.get('/api/chats', requireAuth, ah(async (req, res) => {
  const rows = await query(`SELECT m.*, CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END AS peer_id
    FROM messages m WHERE m.sender_id = $1 OR m.receiver_id = $1
    ORDER BY m.id DESC`, [req.user.id]);
  const byPeer = new Map();
  for (const m of rows.rows) if (!byPeer.has(m.peer_id)) byPeer.set(m.peer_id, m);
  const chats = await Promise.all([...byPeer.entries()].map(async ([peerId, last]) => {
    const unread = await query('SELECT COUNT(*)::int AS c FROM messages WHERE sender_id = $1 AND receiver_id = $2 AND read_at IS NULL',
      [peerId, req.user.id]);
    return { peer: publicUser(await getUser(peerId)), last: msgView(last), unread: unread.rows[0].c };
  }));
  chats.sort((a, b) => b.last.id - a.last.id);
  res.json({ chats });
}));
app.get('/api/messages/:userId', requireAuth, ah(async (req, res) => {
  const peerId = Number(req.params.userId);
  await query('UPDATE messages SET read_at = now() WHERE sender_id = $1 AND receiver_id = $2 AND read_at IS NULL',
    [peerId, req.user.id]);
  const rows = await query(`SELECT * FROM messages WHERE (sender_id = $1 AND receiver_id = $2)
    OR (sender_id = $2 AND receiver_id = $1) ORDER BY id`, [req.user.id, peerId]);
  res.json({ peer: publicUser(await getUser(peerId)), messages: rows.rows.map(msgView) });
}));
app.post('/api/messages/:userId', requireAuth, ah(async (req, res) => {
  const peerId = Number(req.params.userId);
  if (!(await getUser(peerId))) return res.status(404).json({ error: 'Пользователь не найден' });
  const { text, sharedType, sharedRef, sharedLabel } = req.body || {};
  if (!String(text || '').trim() && !sharedType) return res.status(400).json({ error: 'Сообщение пустое' });
  const info = await query(`INSERT INTO messages (sender_id, receiver_id, text, shared_type, shared_ref, shared_label)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.user.id, peerId, String(text || ''), sharedType || null,
     sharedRef != null ? String(sharedRef) : null, sharedLabel || null]);
  const m = await query('SELECT * FROM messages WHERE id = $1', [info.rows[0].id]);
  res.json({ message: msgView(m.rows[0]) });
}));

// ---------- channels ----------
async function getChannel(id) {
  const r = await query('SELECT * FROM channels WHERE id = $1', [id]);
  return r.rows[0] || null;
}
async function channelView(c, meId) {
  const subsR = await query('SELECT COUNT(*)::int AS c FROM channel_subs WHERE channel_id = $1', [c.id]);
  const subR = await query('SELECT 1 FROM channel_subs WHERE channel_id = $1 AND user_id = $2', [c.id, meId]);
  const lastR = await query('SELECT * FROM channel_posts WHERE channel_id = $1 ORDER BY id DESC LIMIT 1', [c.id]);
  const last = lastR.rows[0];
  return { id: c.id, name: c.name, username: c.username, description: c.description || '',
    ownerId: c.owner_id, subs: subsR.rows[0].c, subscribed: subR.rows.length > 0,
    lastPost: last ? { text: last.text, media: last.media, createdAt: last.created_at } : null };
}
function channelPostView(p, c) {
  return { id: p.id, channelId: p.channel_id, text: p.text, media: p.media, mediaType: p.media_type,
    createdAt: p.created_at, channel: { id: c.id, name: c.name, username: c.username } };
}
app.get('/api/channels', requireAuth, ah(async (req, res) => {
  const rows = await query('SELECT * FROM channels ORDER BY id DESC');
  res.json({ channels: await Promise.all(rows.rows.map((c) => channelView(c, req.user.id))) });
}));
app.post('/api/channels', requireAuth, ah(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const username = String((req.body || {}).username || '').trim().replace(/^@/, '').toLowerCase();
  if (!name || !/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Нужно название и корректный @username канала' });
  const exists = await query('SELECT id FROM channels WHERE username = $1', [username]);
  if (exists.rows.length) return res.status(409).json({ error: 'Этот @username канала уже занят' });
  const info = await query('INSERT INTO channels (owner_id, name, username, description) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.user.id, name, username, String((req.body || {}).description || '')]);
  await query('INSERT INTO channel_subs (channel_id, user_id) VALUES ($1, $2)', [info.rows[0].id, req.user.id]);
  res.json({ channel: await channelView(await getChannel(info.rows[0].id), req.user.id) });
}));
app.get('/api/channels/:id', requireAuth, ah(async (req, res) => {
  const c = await getChannel(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Канал не найден' });
  const postsR = await query('SELECT * FROM channel_posts WHERE channel_id = $1 ORDER BY id DESC', [c.id]);
  res.json({ channel: await channelView(c, req.user.id), posts: postsR.rows.map((p) => channelPostView(p, c)) });
}));
app.post('/api/channels/:id/subscribe', requireAuth, ah(async (req, res) => {
  const id = Number(req.params.id);
  const has = await query('SELECT 1 FROM channel_subs WHERE channel_id = $1 AND user_id = $2', [id, req.user.id]);
  if (has.rows.length) await query('DELETE FROM channel_subs WHERE channel_id = $1 AND user_id = $2', [id, req.user.id]);
  else await query('INSERT INTO channel_subs (channel_id, user_id) VALUES ($1, $2)', [id, req.user.id]);
  res.json({ channel: await channelView(await getChannel(id), req.user.id) });
}));
app.post('/api/channels/:id/posts', requireAuth, upload.single('media'), ah(async (req, res) => {
  const c = await getChannel(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Канал не найден' });
  if (c.owner_id !== req.user.id) return res.status(403).json({ error: 'Публиковать может только владелец канала' });
  let media = null, mediaPublicId = null, mediaType = null;
  if (req.file) {
    const up = await uploadMedia(req.file, 'channels');
    media = up.url; mediaPublicId = up.publicId;
    mediaType = /video/i.test(req.file.mimetype) ? 'video' : 'image';
  }
  const text = String((req.body || {}).text || '').trim();
  if (!text && !media) return res.status(400).json({ error: 'Пост пустой' });
  const info = await query('INSERT INTO channel_posts (channel_id, text, media, media_public_id, media_type) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [c.id, text, media, mediaPublicId, mediaType]);
  const p = await query('SELECT * FROM channel_posts WHERE id = $1', [info.rows[0].id]);
  res.json({ post: channelPostView(p.rows[0], c) });
}));
app.get('/api/channel-feed', requireAuth, ah(async (req, res) => {
  const rows = await query(`SELECT p.* FROM channel_posts p JOIN channel_subs s ON s.channel_id = p.channel_id
    WHERE s.user_id = $1 ORDER BY p.id DESC LIMIT 50`, [req.user.id]);
  const posts = await Promise.all(rows.rows.map(async (p) => channelPostView(p, await getChannel(p.channel_id))));
  res.json({ posts });
}));

// ---------- music: Deezer proxy ----------
const DEEZER = 'https://api.deezer.com';
async function dz(pathname) {
  const r = await fetch(DEEZER + pathname);
  if (!r.ok) throw new Error('Deezer API: ' + r.status);
  return r.json();
}
function dzTrack(t) {
  if (!t) return null;
  return { id: t.id, title: t.title, duration: t.duration, preview: t.preview,
    artist: t.artist ? { id: t.artist.id, name: t.artist.name, picture: t.artist.picture_medium } : null,
    album: t.album ? { id: t.album.id, title: t.album.title, cover: t.album.cover_medium } : null,
    link: t.link };
}
app.get('/api/music/search', requireAuth, ah(async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ tracks: [] });
    const data = await dz('/search?q=' + encodeURIComponent(q) + '&limit=25');
    res.json({ tracks: (data.data || []).map(dzTrack) });
  } catch (e) { res.status(502).json({ error: 'Каталог музыки недоступен' }); }
}));
app.get('/api/music/chart', requireAuth, ah(async (req, res) => {
  try {
    const data = await dz('/chart/0/tracks?limit=40');
    res.json({ tracks: (data.data || []).map(dzTrack) });
  } catch (e) { res.status(502).json({ error: 'Каталог музыки недоступен' }); }
}));
app.get('/api/music/track/:id', requireAuth, ah(async (req, res) => {
  try {
    const t = await dz('/track/' + encodeURIComponent(req.params.id));
    res.json({ track: dzTrack(t) });
  } catch (e) { res.status(502).json({ error: 'Трек не найден' }); }
}));
app.get('/api/music/artist/:id', requireAuth, ah(async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);
    const [artist, top, albums, related] = await Promise.all([
      dz('/artist/' + id), dz('/artist/' + id + '/top?limit=12'),
      dz('/artist/' + id + '/albums?limit=18'), dz('/artist/' + id + '/related?limit=12'),
    ]);
    res.json({
      artist: { id: artist.id, name: artist.name, picture: artist.picture_xl || artist.picture_medium,
        fans: artist.nb_fan, albumsCount: artist.nb_album, link: artist.link },
      top: (top.data || []).map(dzTrack),
      albums: (albums.data || []).map((a) => ({ id: a.id, title: a.title, cover: a.cover_medium, year: (a.release_date || '').slice(0, 4) })),
      related: (related.data || []).map((a) => ({ id: a.id, name: a.name, picture: a.picture_medium, fans: a.nb_fan })),
    });
  } catch (e) { res.status(502).json({ error: 'Артист не найден' }); }
}));
app.get('/api/music/album/:id', requireAuth, ah(async (req, res) => {
  try {
    const a = await dz('/album/' + encodeURIComponent(req.params.id));
    res.json({ album: { id: a.id, title: a.title, cover: a.cover_xl || a.cover_medium,
      artist: a.artist ? { id: a.artist.id, name: a.artist.name } : null, link: a.link },
      tracks: ((a.tracks && a.tracks.data) || []).map(dzTrack) });
  } catch (e) { res.status(502).json({ error: 'Альбом не найден' }); }
}));

// ---------- song likes / My Wave ----------
app.get('/api/music/likes', requireAuth, ah(async (req, res) => {
  const rows = await query('SELECT * FROM song_likes WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ likes: rows.rows.map((r) => JSON.parse(r.data)) });
}));
app.post('/api/music/likes', requireAuth, ah(async (req, res) => {
  const track = (req.body || {}).track;
  if (!track || track.id == null) return res.status(400).json({ error: 'Нет трека' });
  const key = 'dz:' + track.id;
  const has = await query('SELECT 1 FROM song_likes WHERE user_id = $1 AND track_key = $2', [req.user.id, key]);
  if (has.rows.length) await query('DELETE FROM song_likes WHERE user_id = $1 AND track_key = $2', [req.user.id, key]);
  else await query('INSERT INTO song_likes (user_id, track_key, data) VALUES ($1, $2, $3)', [req.user.id, key, JSON.stringify(track)]);
  res.json({ liked: !has.rows.length });
}));
app.get('/api/music/wave', requireAuth, ah(async (req, res) => {
  try {
    const likesR = await query('SELECT data FROM song_likes WHERE user_id = $1', [req.user.id]);
    const likes = likesR.rows.map((r) => JSON.parse(r.data));
    const trackLikesR = await query(`SELECT t.* FROM user_track_likes l JOIN user_tracks t ON t.id = l.track_id
      WHERE l.user_id = $1`, [req.user.id]);
    const wave = [];
    const seen = new Set();
    const push = (t, source) => { const k = source + ':' + t.id; if (!seen.has(k)) { seen.add(k); wave.push({ ...t, source }); } };
    likes.forEach((t) => push(t, 'deezer'));
    trackLikesR.rows.forEach((t) => push({ id: 'ut' + t.id, title: t.title, artist: { name: t.artist }, userTrackId: t.id, file: t.file }, 'user'));
    const artistIds = [...new Set(likes.map((t) => t.artist && t.artist.id).filter(Boolean))];
    const basedOn = [...new Set(likes.map((t) => t.artist && t.artist.name).filter(Boolean))];
    for (const aid of artistIds.slice(0, 4)) {
      const top = await dz(`/artist/${aid}/top?limit=8`).catch(() => ({ data: [] }));
      (top.data || []).map(dzTrack).forEach((t) => push(t, 'deezer'));
      const rel = await dz(`/artist/${aid}/related?limit=3`).catch(() => ({ data: [] }));
      for (const ra of (rel.data || [])) {
        const rtop = await dz(`/artist/${ra.id}/top?limit=4`).catch(() => ({ data: [] }));
        (rtop.data || []).map(dzTrack).forEach((t) => push(t, 'deezer'));
      }
    }
    if (!wave.length) {
      const chart = await dz('/chart/0/tracks?limit=30');
      (chart.data || []).map(dzTrack).forEach((t) => push(t, 'deezer'));
    }
    res.json({ wave, basedOn });
  } catch (e) { res.status(502).json({ error: 'Волну не удалось собрать' }); }
}));

// ---------- user tracks (community uploads, full playback) ----------
async function userTrackView(t, meId) {
  const likesR = await query('SELECT COUNT(*)::int AS c FROM user_track_likes WHERE track_id = $1', [t.id]);
  const likedR = await query('SELECT 1 FROM user_track_likes WHERE track_id = $1 AND user_id = $2', [t.id, meId]);
  return { id: t.id, title: t.title, artist: t.artist, file: t.file, createdAt: t.created_at,
    uploader: publicUser(await getUser(t.user_id)), likes: likesR.rows[0].c, liked: likedR.rows.length > 0 };
}
async function getUserTrack(id) {
  const r = await query('SELECT * FROM user_tracks WHERE id = $1', [id]);
  return r.rows[0] || null;
}
app.get('/api/tracks', requireAuth, ah(async (req, res) => {
  const rows = await query('SELECT * FROM user_tracks ORDER BY id DESC LIMIT 100');
  res.json({ tracks: await Promise.all(rows.rows.map((t) => userTrackView(t, req.user.id))) });
}));
app.post('/api/tracks', requireAuth, audioUpload.single('audio'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет аудиофайла' });
  let title = String((req.body || {}).title || '').trim();
  let artist = String((req.body || {}).artist || '').trim();
  if (!title) {
    // Распознавание по имени файла вида «Исполнитель — Название.mp3»
    const base = path.basename(req.file.originalname || '', path.extname(req.file.originalname || ''));
    const parts = base.split(/\s+[-—–]\s+/);
    if (parts.length >= 2) { artist = artist || parts[0].trim(); title = parts.slice(1).join(' — ').trim(); }
    else title = base.trim();
  }
  if (!artist) artist = req.user.name;
  const up = await uploadMedia(req.file, 'tracks');
  const info = await query('INSERT INTO user_tracks (user_id, title, artist, file, file_public_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [req.user.id, title, artist, up.url, up.publicId]);
  res.json({ track: await userTrackView(await getUserTrack(info.rows[0].id), req.user.id) });
}));
app.post('/api/tracks/:id/like', requireAuth, ah(async (req, res) => {
  const id = Number(req.params.id);
  const has = await query('SELECT 1 FROM user_track_likes WHERE track_id = $1 AND user_id = $2', [id, req.user.id]);
  if (has.rows.length) await query('DELETE FROM user_track_likes WHERE track_id = $1 AND user_id = $2', [id, req.user.id]);
  else await query('INSERT INTO user_track_likes (track_id, user_id) VALUES ($1, $2)', [id, req.user.id]);
  res.json({ track: await userTrackView(await getUserTrack(id), req.user.id) });
}));

// ---------- profile songs ----------
app.get('/api/users/:id/profile-songs', requireAuth, ah(async (req, res) => {
  const rows = await query('SELECT * FROM profile_songs WHERE user_id = $1 ORDER BY id', [Number(req.params.id)]);
  res.json({ songs: rows.rows.map((r) => ({ id: r.id, kind: r.kind, ref: r.ref, data: JSON.parse(r.data) })) });
}));
app.post('/api/me/profile-songs', requireAuth, ah(async (req, res) => {
  const { kind, ref, data } = req.body || {};
  if (!kind || ref == null || !data) return res.status(400).json({ error: 'Некорректная песня' });
  const info = await query('INSERT INTO profile_songs (user_id, kind, ref, data) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.user.id, String(kind), String(ref), JSON.stringify(data)]);
  res.json({ song: { id: info.rows[0].id, kind, ref: String(ref), data } });
}));
app.delete('/api/me/profile-songs/:id', requireAuth, ah(async (req, res) => {
  await query('DELETE FROM profile_songs WHERE id = $1 AND user_id = $2', [Number(req.params.id), req.user.id]);
  res.json({ ok: true });
}));
app.get('/api/users/:id/tracks', requireAuth, ah(async (req, res) => {
  const rows = await query('SELECT * FROM user_tracks WHERE user_id = $1 ORDER BY id DESC', [Number(req.params.id)]);
  res.json({ tracks: await Promise.all(rows.rows.map((t) => userTrackView(t, req.user.id))) });
}));
app.get('/api/users/:id/posts', requireAuth, ah(async (req, res) => {
  const rows = await query('SELECT * FROM posts WHERE user_id = $1 ORDER BY id DESC', [Number(req.params.id)]);
  res.json({ posts: await Promise.all(rows.rows.map((p) => postView(p, req.user.id))) });
}));

// SPA fallback + errors
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Не найдено' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Файл слишком большой' });
  if (err) return res.status(400).json({ error: err.message || 'Ошибка загрузки' });
  next();
});

app.ready = ready;
module.exports = app;
