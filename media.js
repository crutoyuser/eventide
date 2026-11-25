'use strict';
/**
 * Eventide — хранение медиа прямо в Postgres (таблица media).
 * Почему так: бесплатный хостинг (Render) не даёт постоянного диска, а
 * внешние хранилища упёрлись в региональные ограничения. Файлы лежат в базе
 * Neon рядом с остальными данными и отдаются через GET /media/:id.
 * Лимит Neon free — объём базы, поэтому для старта ок, для роста — миграция
 * на объектное хранилище позже (интерфейс uploadMedia менять не придётся).
 *
 * Для локальных тестов без базы: MEDIA_STUB=1 — загрузка заменяется стабом,
 * возвращающим фиктивный URL (файл никуда не уходит). В проде не включать.
 */
const crypto = require('crypto');
const { query } = require('./db');

const STUB = process.env.MEDIA_STUB === '1' || process.env.CLOUDINARY_STUB === '1';

/**
 * Сохраняет буфер multer-файла в таблицу media.
 * @returns {Promise<{url: string, publicId: string}>}
 */
async function uploadMedia(file, folder) {
  const id = `${folder}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  if (STUB) {
    return { url: `https://stub.local/media/${id}`, publicId: id };
  }
  await query('INSERT INTO media (id, mime, data) VALUES ($1, $2, $3)',
    [id, file.mimetype || 'application/octet-stream', file.buffer]);
  return { url: `/media/${id}`, publicId: id };
}

/** Достаёт файл из таблицы media по id (publicId). */
async function getMedia(id) {
  const r = await query('SELECT mime, data FROM media WHERE id = $1', [id]);
  if (!r.rows.length) return null;
  return { mime: r.rows[0].mime, data: r.rows[0].data };
}

module.exports = { uploadMedia, getMedia };
