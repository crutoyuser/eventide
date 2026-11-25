'use strict';
/**
 * Eventide — серверная версия соцсети.
 * Node.js + Express + SQLite (better-sqlite3). Медиа — файлы в data/uploads.
 * Запуск: npm install && npm start  (порт: env PORT, по умолчанию 3000)
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
// SESSION_SECRET используется для подписи служебных токенов; задайте свой в проде.
const SESSION_SECRET = process.env.SESSION_SECRET || 'eventide-dev-secret-change-me';

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'eventide.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  is_verified INTEGER NOT NULL DEFAULT 0,
  avatar TEXT,
  bio TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT DEFAULT '',
  image TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  video TEXT NOT NULL,
  caption TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reel_likes (
  reel_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  PRIMARY KEY (reel_id, user_id)
);
CREATE TABLE IF NOT EXISTS contacts (
  user_id INTEGER NOT NULL, contact_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, contact_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT DEFAULT '',
  shared_type TEXT,
  shared_ref TEXT,
  shared_label TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS channel_subs (
  channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS channel_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  text TEXT DEFAULT '',
  media TEXT,
  media_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS song_likes (
  user_id INTEGER NOT NULL,
  track_key TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, track_key)
);
CREATE TABLE IF NOT EXISTS user_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  file TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_track_likes (
  track_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  PRIMARY KEY (track_id, user_id)
);
CREATE TABLE IF NOT EXISTS profile_songs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- helpers ----------
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, name: u.name,
    isOwner: !!u.is_owner, isVerified: !!u.is_verified,
    avatar: u.avatar || null, bio: u.bio || '',
  };
}
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const token = parseCookies(req).eventide_session;
  if (!token) return null;
  const s = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
  return s ? getUser(s.user_id) : null;
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Требуется вход' });
  req.user = u;
  next();
}
function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  res.setHeader('Set-Cookie',
    `eventide_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: 60 * 1024 * 1024 },
});
const audioUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(mp3|m4a|ogg|wav)$/i.test(file.originalname || '') ||
      /audio\//.test(file.mimetype || '');
    cb(ok ? null : new Error('Нужен аудиофайл: mp3, m4a, ogg или wav'), ok);
  },
});

// ---------- auth ----------
app.post('/api/register', (req, res) => {
  const { name, password } = req.body || {};
  let { username } = req.body || {};
  username = String(username || '').trim().replace(/^@/, '').toLowerCase();
  if (!name || !username || !password) return res.status(400).json({ error: 'Заполните имя, @username и пароль' });
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username: 3–24 символа, латиница, цифры и _' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Пароль слишком короткий' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'Этот юзернейм уже занят' });
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const isOwner = count === 0 ? 1 : 0; // самый первый аккаунт — владелец
  const hash = bcrypt.hashSync(String(password), 10);
  const info = db.prepare(
    'INSERT INTO users (username, name, password_hash, is_owner) VALUES (?, ?, ?, ?)'
  ).run(username, String(name).trim(), hash, isOwner);
  setSession(res, info.lastInsertRowid);
  res.json({ user: publicUser(getUser(info.lastInsertRowid)) });
});

app.post('/api/login', (req, res) => {
  const username = String((req.body || {}).username || '').trim().replace(/^@/, '').toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !bcrypt.compareSync(String((req.body || {}).password || ''), u.password_hash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  setSession(res, u.id);
  res.json({ user: publicUser(u) });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).eventide_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'eventide_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/me', requireAuth, (req, res) => {
  const { name, bio } = req.body || {};
  db.prepare('UPDATE users SET name = COALESCE(?, name), bio = COALESCE(?, bio) WHERE id = ?')
    .run(name ? String(name).trim() : null, bio != null ? String(bio) : null, req.user.id);
  res.json({ user: publicUser(getUser(req.user.id)) });
});

app.post('/api/me/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  const url = '/uploads/' + req.file.filename;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, req.user.id);
  res.json({ user: publicUser(getUser(req.user.id)) });
});

// ---------- admin ----------
function requireOwner(req, res, next) {
  if (!req.user.is_owner) return res.status(403).json({ error: 'Админ-панель доступна только владельцу Eventide' });
  next();
}
app.get('/api/admin/users', requireAuth, requireOwner, (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
  res.json({ users: rows.map(publicUser) });
});
app.post('/api/admin/verify', requireAuth, requireOwner, (req, res) => {
  const { userId, verified } = req.body || {};
  db.prepare('UPDATE users SET is_verified = ? WHERE id = ?').run(verified ? 1 : 0, Number(userId));
  res.json({ user: publicUser(getUser(Number(userId))) });
});

// ---------- users, contacts, search ----------
app.get('/api/users/:id', requireAuth, (req, res) => {
  const u = getUser(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
  const isContact = !!db.prepare('SELECT 1 FROM contacts WHERE user_id = ? AND contact_id = ?')
    .get(req.user.id, u.id);
  res.json({ user: publicUser(u), isContact });
});

app.get('/api/contacts', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT u.* FROM contacts c JOIN users u ON u.id = c.contact_id
    WHERE c.user_id = ? ORDER BY u.name`).all(req.user.id);
  res.json({ contacts: rows.map(publicUser) });
});
app.post('/api/contacts', requireAuth, (req, res) => {
  const id = Number((req.body || {}).userId);
  if (!id || id === req.user.id || !getUser(id)) return res.status(400).json({ error: 'Некорректный пользователь' });
  db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)').run(req.user.id, id);
  res.json({ ok: true });
});
app.delete('/api/contacts/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_id = ?').run(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

// Поиск с фильтрацией в JS: SQLite LIKE не учитывает регистр кириллицы.
function searchUsers(q, excludeId, limit = 10) {
  const needle = q.toLowerCase();
  return db.prepare('SELECT * FROM users WHERE id != ? ORDER BY is_verified DESC, name').all(excludeId)
    .filter((u) => u.name.toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle))
    .slice(0, limit).map(publicUser);
}
function searchChannels(q, limit = 10) {
  const needle = q.toLowerCase();
  return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM channel_subs s WHERE s.channel_id = c.id) AS subs
    FROM channels c ORDER BY subs DESC`).all()
    .filter((c) => c.name.toLowerCase().includes(needle) || c.username.toLowerCase().includes(needle))
    .slice(0, limit)
    .map((c) => ({ id: c.id, name: c.name, username: c.username, description: c.description, subs: c.subs, ownerId: c.owner_id }));
}

app.get('/api/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().replace(/^@/, '');
  if (!q) return res.json({ users: [], channels: [], chats: [] });
  const users = searchUsers(q, req.user.id);
  const channels = searchChannels(q);
  const needle = q.toLowerCase();
  const chats = db.prepare(`SELECT DISTINCT u.* FROM messages m JOIN users u
      ON u.id = CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END
    WHERE m.sender_id = ? OR m.receiver_id = ?`).all(req.user.id, req.user.id, req.user.id)
    .filter((u) => u.name.toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle))
    .slice(0, 10).map(publicUser);
  res.json({ users, channels, chats });
});

// ---------- posts (feed) ----------
function postView(p, meId) {
  const author = publicUser(getUser(p.user_id));
  const likes = db.prepare('SELECT COUNT(*) AS c FROM post_likes WHERE post_id = ?').get(p.id).c;
  const liked = !!db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(p.id, meId);
  const comments = db.prepare(`SELECT c.*, u.username, u.name, u.avatar, u.is_verified, u.is_owner
      FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id`).all(p.id)
    .map((c) => ({ id: c.id, text: c.text, createdAt: c.created_at,
      author: { id: c.user_id, username: c.username, name: c.name, avatar: c.avatar, isVerified: !!c.is_verified, isOwner: !!c.is_owner } }));
  return { id: p.id, text: p.text, image: p.image, createdAt: p.created_at, author, likes, liked, comments };
}
app.get('/api/posts', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM posts ORDER BY id DESC LIMIT 100').all();
  res.json({ posts: rows.map((p) => postView(p, req.user.id)) });
});
app.post('/api/posts', requireAuth, upload.single('image'), (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  const image = req.file ? '/uploads/' + req.file.filename : null;
  if (!text && !image) return res.status(400).json({ error: 'Пост пустой' });
  const info = db.prepare('INSERT INTO posts (user_id, text, image) VALUES (?, ?, ?)').run(req.user.id, text, image);
  res.json({ post: postView(db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid), req.user.id) });
});
app.post('/api/posts/:id/like', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const has = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(id, req.user.id);
  if (has) db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(id, req.user.id);
  else db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').run(id, req.user.id);
  res.json({ post: postView(db.prepare('SELECT * FROM posts WHERE id = ?').get(id), req.user.id) });
});
app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Комментарий пустой' });
  db.prepare('INSERT INTO comments (post_id, user_id, text) VALUES (?, ?, ?)').run(Number(req.params.id), req.user.id, text);
  res.json({ post: postView(db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id)), req.user.id) });
});

// ---------- reels ----------
function reelView(r, meId) {
  const likes = db.prepare('SELECT COUNT(*) AS c FROM reel_likes WHERE reel_id = ?').get(r.id).c;
  const liked = !!db.prepare('SELECT 1 FROM reel_likes WHERE reel_id = ? AND user_id = ?').get(r.id, meId);
  return { id: r.id, video: r.video, caption: r.caption, createdAt: r.created_at, author: publicUser(getUser(r.user_id)), likes, liked };
}
app.get('/api/reels', requireAuth, (req, res) => {
  res.json({ reels: db.prepare('SELECT * FROM reels ORDER BY id DESC LIMIT 50').all().map((r) => reelView(r, req.user.id)) });
});
app.post('/api/reels', requireAuth, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет видео' });
  const info = db.prepare('INSERT INTO reels (user_id, video, caption) VALUES (?, ?, ?)')
    .run(req.user.id, '/uploads/' + req.file.filename, String((req.body || {}).caption || ''));
  res.json({ reel: reelView(db.prepare('SELECT * FROM reels WHERE id = ?').get(info.lastInsertRowid), req.user.id) });
});
app.post('/api/reels/:id/like', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const has = db.prepare('SELECT 1 FROM reel_likes WHERE reel_id = ? AND user_id = ?').get(id, req.user.id);
  if (has) db.prepare('DELETE FROM reel_likes WHERE reel_id = ? AND user_id = ?').run(id, req.user.id);
  else db.prepare('INSERT INTO reel_likes (reel_id, user_id) VALUES (?, ?)').run(id, req.user.id);
  res.json({ reel: reelView(db.prepare('SELECT * FROM reels WHERE id = ?').get(id), req.user.id) });
});

// ---------- messages / chats ----------
function msgView(m) {
  return { id: m.id, senderId: m.sender_id, receiverId: m.receiver_id, text: m.text,
    sharedType: m.shared_type, sharedRef: m.shared_ref, sharedLabel: m.shared_label,
    read: !!m.read_at, createdAt: m.created_at };
}
app.get('/api/chats', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT m.*, CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END AS peer_id
    FROM messages m WHERE m.sender_id = ? OR m.receiver_id = ?
    ORDER BY m.id DESC`).all(req.user.id, req.user.id, req.user.id);
  const byPeer = new Map();
  for (const m of rows) if (!byPeer.has(m.peer_id)) byPeer.set(m.peer_id, m);
  const chats = [...byPeer.entries()].map(([peerId, last]) => {
    const unread = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL')
      .get(peerId, req.user.id).c;
    return { peer: publicUser(getUser(peerId)), last: msgView(last), unread };
  }).sort((a, b) => b.last.id - a.last.id);
  res.json({ chats });
});
app.get('/api/messages/:userId', requireAuth, (req, res) => {
  const peerId = Number(req.params.userId);
  db.prepare('UPDATE messages SET read_at = datetime(\'now\') WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL')
    .run(peerId, req.user.id);
  const rows = db.prepare(`SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?)
    OR (sender_id = ? AND receiver_id = ?) ORDER BY id`).all(req.user.id, peerId, peerId, req.user.id);
  res.json({ peer: publicUser(getUser(peerId)), messages: rows.map(msgView) });
});
app.post('/api/messages/:userId', requireAuth, (req, res) => {
  const peerId = Number(req.params.userId);
  if (!getUser(peerId)) return res.status(404).json({ error: 'Пользователь не найден' });
  const { text, sharedType, sharedRef, sharedLabel } = req.body || {};
  if (!String(text || '').trim() && !sharedType) return res.status(400).json({ error: 'Сообщение пустое' });
  const info = db.prepare(`INSERT INTO messages (sender_id, receiver_id, text, shared_type, shared_ref, shared_label)
    VALUES (?, ?, ?, ?, ?, ?)`).run(req.user.id, peerId, String(text || ''), sharedType || null,
    sharedRef != null ? String(sharedRef) : null, sharedLabel || null);
  res.json({ message: msgView(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)) });
});

// ---------- channels ----------
function channelView(c, meId) {
  const subs = db.prepare('SELECT COUNT(*) AS c FROM channel_subs WHERE channel_id = ?').get(c.id).c;
  const subscribed = !!db.prepare('SELECT 1 FROM channel_subs WHERE channel_id = ? AND user_id = ?').get(c.id, meId);
  const last = db.prepare('SELECT * FROM channel_posts WHERE channel_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
  return { id: c.id, name: c.name, username: c.username, description: c.description || '',
    ownerId: c.owner_id, subs, subscribed,
    lastPost: last ? { text: last.text, media: last.media, createdAt: last.created_at } : null };
}
function channelPostView(p, c) {
  return { id: p.id, channelId: p.channel_id, text: p.text, media: p.media, mediaType: p.media_type,
    createdAt: p.created_at, channel: { id: c.id, name: c.name, username: c.username } };
}
app.get('/api/channels', requireAuth, (req, res) => {
  res.json({ channels: db.prepare('SELECT * FROM channels ORDER BY id DESC').all().map((c) => channelView(c, req.user.id)) });
});
app.post('/api/channels', requireAuth, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const username = String((req.body || {}).username || '').trim().replace(/^@/, '').toLowerCase();
  if (!name || !/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Нужно название и корректный @username канала' });
  if (db.prepare('SELECT id FROM channels WHERE username = ?').get(username)) return res.status(409).json({ error: 'Этот @username канала уже занят' });
  const info = db.prepare('INSERT INTO channels (owner_id, name, username, description) VALUES (?, ?, ?, ?)')
    .run(req.user.id, name, username, String((req.body || {}).description || ''));
  db.prepare('INSERT INTO channel_subs (channel_id, user_id) VALUES (?, ?)').run(info.lastInsertRowid, req.user.id);
  res.json({ channel: channelView(db.prepare('SELECT * FROM channels WHERE id = ?').get(info.lastInsertRowid), req.user.id) });
});
app.get('/api/channels/:id', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Канал не найден' });
  const posts = db.prepare('SELECT * FROM channel_posts WHERE channel_id = ? ORDER BY id DESC').all(c.id)
    .map((p) => channelPostView(p, c));
  res.json({ channel: channelView(c, req.user.id), posts });
});
app.post('/api/channels/:id/subscribe', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const has = db.prepare('SELECT 1 FROM channel_subs WHERE channel_id = ? AND user_id = ?').get(id, req.user.id);
  if (has) db.prepare('DELETE FROM channel_subs WHERE channel_id = ? AND user_id = ?').run(id, req.user.id);
  else db.prepare('INSERT INTO channel_subs (channel_id, user_id) VALUES (?, ?)').run(id, req.user.id);
  res.json({ channel: channelView(db.prepare('SELECT * FROM channels WHERE id = ?').get(id), req.user.id) });
});
app.post('/api/channels/:id/posts', requireAuth, upload.single('media'), (req, res) => {
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Канал не найден' });
  if (c.owner_id !== req.user.id) return res.status(403).json({ error: 'Публиковать может только владелец канала' });
  const media = req.file ? '/uploads/' + req.file.filename : null;
  const mediaType = req.file ? (/video/i.test(req.file.mimetype) ? 'video' : 'image') : null;
  const text = String((req.body || {}).text || '').trim();
  if (!text && !media) return res.status(400).json({ error: 'Пост пустой' });
  const info = db.prepare('INSERT INTO channel_posts (channel_id, text, media, media_type) VALUES (?, ?, ?, ?)')
    .run(c.id, text, media, mediaType);
  res.json({ post: channelPostView(db.prepare('SELECT * FROM channel_posts WHERE id = ?').get(info.lastInsertRowid), c) });
});
app.get('/api/channel-feed', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT p.* FROM channel_posts p JOIN channel_subs s ON s.channel_id = p.channel_id
    WHERE s.user_id = ? ORDER BY p.id DESC LIMIT 50`).all(req.user.id);
  res.json({ posts: rows.map((p) => channelPostView(p, db.prepare('SELECT * FROM channels WHERE id = ?').get(p.channel_id))) });
});

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
app.get('/api/music/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ tracks: [] });
    const data = await dz('/search?q=' + encodeURIComponent(q) + '&limit=25');
    res.json({ tracks: (data.data || []).map(dzTrack) });
  } catch (e) { res.status(502).json({ error: 'Каталог музыки недоступен' }); }
});
app.get('/api/music/chart', requireAuth, async (req, res) => {
  try {
    const data = await dz('/chart/0/tracks?limit=40');
    res.json({ tracks: (data.data || []).map(dzTrack) });
  } catch (e) { res.status(502).json({ error: 'Каталог музыки недоступен' }); }
});
app.get('/api/music/track/:id', requireAuth, async (req, res) => {
  try {
    const t = await dz('/track/' + encodeURIComponent(req.params.id));
    res.json({ track: dzTrack(t) });
  } catch (e) { res.status(502).json({ error: 'Трек не найден' }); }
});
app.get('/api/music/artist/:id', requireAuth, async (req, res) => {
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
});
app.get('/api/music/album/:id', requireAuth, async (req, res) => {
  try {
    const a = await dz('/album/' + encodeURIComponent(req.params.id));
    res.json({ album: { id: a.id, title: a.title, cover: a.cover_xl || a.cover_medium,
      artist: a.artist ? { id: a.artist.id, name: a.artist.name } : null, link: a.link },
      tracks: ((a.tracks && a.tracks.data) || []).map(dzTrack) });
  } catch (e) { res.status(502).json({ error: 'Альбом не найден' }); }
});

// ---------- song likes / My Wave ----------
app.get('/api/music/likes', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM song_likes WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ likes: rows.map((r) => JSON.parse(r.data)) });
});
app.post('/api/music/likes', requireAuth, (req, res) => {
  const track = (req.body || {}).track;
  if (!track || track.id == null) return res.status(400).json({ error: 'Нет трека' });
  const key = 'dz:' + track.id;
  const has = db.prepare('SELECT 1 FROM song_likes WHERE user_id = ? AND track_key = ?').get(req.user.id, key);
  if (has) db.prepare('DELETE FROM song_likes WHERE user_id = ? AND track_key = ?').run(req.user.id, key);
  else db.prepare('INSERT INTO song_likes (user_id, track_key, data) VALUES (?, ?, ?)').run(req.user.id, key, JSON.stringify(track));
  res.json({ liked: !has });
});
app.get('/api/music/wave', requireAuth, async (req, res) => {
  try {
    const likes = db.prepare('SELECT data FROM song_likes WHERE user_id = ?').all(req.user.id).map((r) => JSON.parse(r.data));
    const trackLikes = db.prepare(`SELECT t.* FROM user_track_likes l JOIN user_tracks t ON t.id = l.track_id
      WHERE l.user_id = ?`).all(req.user.id);
    const wave = [];
    const seen = new Set();
    const push = (t, source) => { const k = source + ':' + t.id; if (!seen.has(k)) { seen.add(k); wave.push({ ...t, source }); } };
    likes.forEach((t) => push(t, 'deezer'));
    trackLikes.forEach((t) => push({ id: 'ut' + t.id, title: t.title, artist: { name: t.artist }, userTrackId: t.id, file: t.file }, 'user'));
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
});

// ---------- user tracks (community uploads, full playback) ----------
function userTrackView(t, meId) {
  const likes = db.prepare('SELECT COUNT(*) AS c FROM user_track_likes WHERE track_id = ?').get(t.id).c;
  const liked = !!db.prepare('SELECT 1 FROM user_track_likes WHERE track_id = ? AND user_id = ?').get(t.id, meId);
  return { id: t.id, title: t.title, artist: t.artist, file: t.file, createdAt: t.created_at,
    uploader: publicUser(getUser(t.user_id)), likes, liked };
}
app.get('/api/tracks', requireAuth, (req, res) => {
  res.json({ tracks: db.prepare('SELECT * FROM user_tracks ORDER BY id DESC LIMIT 100').all().map((t) => userTrackView(t, req.user.id)) });
});
app.post('/api/tracks', requireAuth, audioUpload.single('audio'), (req, res) => {
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
  const info = db.prepare('INSERT INTO user_tracks (user_id, title, artist, file) VALUES (?, ?, ?, ?)')
    .run(req.user.id, title, artist, '/uploads/' + req.file.filename);
  res.json({ track: userTrackView(db.prepare('SELECT * FROM user_tracks WHERE id = ?').get(info.lastInsertRowid), req.user.id) });
});
app.post('/api/tracks/:id/like', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const has = db.prepare('SELECT 1 FROM user_track_likes WHERE track_id = ? AND user_id = ?').get(id, req.user.id);
  if (has) db.prepare('DELETE FROM user_track_likes WHERE track_id = ? AND user_id = ?').run(id, req.user.id);
  else db.prepare('INSERT INTO user_track_likes (track_id, user_id) VALUES (?, ?)').run(id, req.user.id);
  res.json({ track: userTrackView(db.prepare('SELECT * FROM user_tracks WHERE id = ?').get(id), req.user.id) });
});

// ---------- profile songs ----------
app.get('/api/users/:id/profile-songs', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM profile_songs WHERE user_id = ? ORDER BY id').all(Number(req.params.id));
  res.json({ songs: rows.map((r) => ({ id: r.id, kind: r.kind, ref: r.ref, data: JSON.parse(r.data) })) });
});
app.post('/api/me/profile-songs', requireAuth, (req, res) => {
  const { kind, ref, data } = req.body || {};
  if (!kind || ref == null || !data) return res.status(400).json({ error: 'Некорректная песня' });
  const info = db.prepare('INSERT INTO profile_songs (user_id, kind, ref, data) VALUES (?, ?, ?, ?)')
    .run(req.user.id, String(kind), String(ref), JSON.stringify(data));
  res.json({ song: { id: info.lastInsertRowid, kind, ref: String(ref), data } });
});
app.delete('/api/me/profile-songs/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM profile_songs WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});
app.get('/api/users/:id/tracks', requireAuth, (req, res) => {
  res.json({ tracks: db.prepare('SELECT * FROM user_tracks WHERE user_id = ? ORDER BY id DESC').all(Number(req.params.id))
    .map((t) => userTrackView(t, req.user.id)) });
});
app.get('/api/users/:id/posts', requireAuth, (req, res) => {
  res.json({ posts: db.prepare('SELECT * FROM posts WHERE user_id = ? ORDER BY id DESC').all(Number(req.params.id))
    .map((p) => postView(p, req.user.id)) });
});

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

app.listen(PORT, () => console.log(`Eventide запущен: http://localhost:${PORT}`));
