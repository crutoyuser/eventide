'use strict';
/**
 * Eventide — загрузка медиа в Vercel Blob.
 * Конфиг: env BLOB_READ_WRITE_TOKEN — Vercel сам подставляет его, когда
 * Blob-хранилище подключено к проекту (Storage → Blob). Отдельный аккаунт
 * Cloudinary не нужен.
 *
 * Для локальных тестов без хранилища: MEDIA_STUB=1 (или CLOUDINARY_STUB=1) —
 * загрузка заменяется стабом, возвращающим фиктивный URL (файл никуда не
 * уходит). В проде не включать.
 */
const crypto = require('crypto');
const { put } = require('@vercel/blob');

const STUB = process.env.MEDIA_STUB === '1' || process.env.CLOUDINARY_STUB === '1';

function extFor(file) {
  const name = file.originalname || '';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && name.length - dot <= 6) return name.slice(dot).toLowerCase();
  const mime = file.mimetype || '';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime.startsWith('image/')) return '.jpg';
  if (mime === 'video/webm') return '.webm';
  if (mime.startsWith('video/')) return '.mp4';
  if (mime === 'audio/mpeg') return '.mp3';
  if (mime === 'audio/mp4') return '.m4a';
  if (mime === 'audio/ogg') return '.ogg';
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return '.wav';
  return '';
}

/**
 * Загружает буфер multer-файла в Vercel Blob.
 * @returns {Promise<{url: string, publicId: string}>}
 */
async function uploadMedia(file, folder) {
  const pathname = `eventide/${folder}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}${extFor(file)}`;
  if (STUB) {
    return { url: `https://stub.public.blob.vercel-storage.com/${pathname}`, publicId: pathname };
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('Хранилище не настроено: подключите Vercel Blob к проекту (env BLOB_READ_WRITE_TOKEN)');
  }
  const blob = await put(pathname, file.buffer, {
    access: 'public',
    contentType: file.mimetype || undefined,
  });
  return { url: blob.url, publicId: blob.pathname };
}

module.exports = { uploadMedia };
