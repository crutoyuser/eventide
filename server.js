'use strict';
/**
 * Eventide — локальный запуск. Само приложение — в app.js
 *
 * Запуск: npm install && npm start  (порт: env PORT, по умолчанию 3000)
 * Нужны env: DATABASE_URL (Postgres — данные и медиа), SESSION_SECRET.
 */
const app = require('./app');

const PORT = process.env.PORT || 3000;

app.ready
  .then(() => {
    app.listen(PORT, () => console.log(`Eventide запущен: http://localhost:${PORT}`));
  })
  .catch((e) => {
    console.error('Не удалось подключиться к базе / создать схему:', e.message);
    process.exit(1);
  });
