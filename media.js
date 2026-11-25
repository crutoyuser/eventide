'use strict';
/**
 * Eventide — загрузка медиа в Cloudinary.
 * Конфиг: env CLOUDINARY_URL (cloudinary://key:secret@cloud) — официальный SDK
 * сам читает эту переменную, явный config оставляем как страховку.
 *
 * Типы Cloudinary: картинки — resource_type 'image'; видео И аудио — 'video'
 * (Cloudinary принимает аудиофайлы именно как video-ресурсы).
 *
 * Для локальных тестов без аккаунта: CLOUDINARY_STUB=1 — загрузка заменяется
 * стабом, возвращающим фиктивный URL (файл никуда не уходит). В проде не включать.
 */
const crypto = require('crypto');
const { v2: cloudinary } = require('cloudinary');

if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ secure: true }); // креды берутся из CLOUDINARY_URL
}
const STUB = process.env.CLOUDINARY_STUB === '1';

function resourceTypeFor(file) {
  const mime = file.mimetype || '';
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'video';
  return 'image';
}

/**
 * Загружает буфер multer-файла в Cloudinary.
 * @returns {Promise<{url: string, publicId: string}>}
 */
function uploadMedia(file, folder) {
  const resourceType = resourceTypeFor(file);
  if (STUB) {
    const publicId = `eventide/${folder}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    return Promise.resolve({
      url: `https://res.cloudinary.com/stub/${resourceType}/upload/${publicId}`,
      publicId,
    });
  }
  if (!process.env.CLOUDINARY_URL) {
    return Promise.reject(new Error('Cloudinary не настроен: задайте CLOUDINARY_URL'));
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: resourceType, folder: `eventide/${folder}` },
      (err, result) => {
        if (err) return reject(new Error('Cloudinary: ' + (err.message || 'ошибка загрузки')));
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(file.buffer);
  });
}

module.exports = { uploadMedia };
