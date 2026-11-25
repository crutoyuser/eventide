'use strict';
/**
 * Eventide — доступ к Postgres (Neon в проде, любой Postgres локально).
 * Подключение: env DATABASE_URL. Для Neon нужен SSL — включаем его, когда
 * в строке подключения есть sslmode=require или хост neon.tech.
 */
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('[db] DATABASE_URL не задан — задайте строку подключения Postgres');
}
const needsSsl = /neon\.tech|sslmode=require/i.test(connectionString || '');

const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  max: 5,
});

const query = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_owner BOOLEAN NOT NULL DEFAULT false,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  avatar TEXT,
  avatar_public_id TEXT,
  bio TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT DEFAULT '',
  image TEXT,
  image_public_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reels (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  video TEXT NOT NULL,
  video_public_id TEXT,
  caption TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT DEFAULT '',
  shared_type TEXT,
  shared_ref TEXT,
  shared_label TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS channel_subs (
  channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS channel_posts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  text TEXT DEFAULT '',
  media TEXT,
  media_public_id TEXT,
  media_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS song_likes (
  user_id INTEGER NOT NULL,
  track_key TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, track_key)
);
CREATE TABLE IF NOT EXISTS user_tracks (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  file TEXT NOT NULL,
  file_public_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_track_likes (
  track_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  PRIMARY KEY (track_id, user_id)
);
CREATE TABLE IF NOT EXISTS profile_songs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let initPromise = null;
/** Создаёт таблицы, если их нет. Идемпотентно, безопасно вызывать многократно. */
function initDb() {
  if (!initPromise) {
    initPromise = pool.query(SCHEMA).catch((e) => {
      initPromise = null; // позволить повтор при следующем запросе
      throw e;
    });
  }
  return initPromise;
}

module.exports = { pool, query, initDb };
