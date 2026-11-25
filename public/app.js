'use strict';
/* Eventide SPA (vanilla JS) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ts) => { const d = new Date((ts || '').replace(' ', 'T') + 'Z'); return isNaN(d) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); };
const fmtDate = (ts) => { const d = new Date((ts || '').replace(' ', 'T') + 'Z'); return isNaN(d) ? '' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); };
const fmtDur = (s) => { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

async function api(pathname, opts = {}) {
  const res = await fetch(pathname, { headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка ' + res.status);
  return data;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; setTimeout(() => (t.hidden = true), 2400); }
function badges(u) {
  return (u.isOwner ? '<span class="badge-owner">ВЛАДЕЦ</span>' : '') + (u.isVerified ? '<span class="badge-verified" title="Верифицирован">✔</span>' : '');
}
function avatarHtml(u, cls = '') {
  const letter = esc((u.name || '?')[0].toUpperCase());
  return u.avatar ? `<img class="avatar ${cls}" src="${esc(u.avatar)}" alt="">` : `<span class="avatar ${cls}">${letter}</span>`;
}
function openModal(html) {
  $('#modal-root').innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
  $('.modal-bg').addEventListener('click', (e) => { if (e.target.classList.contains('modal-bg')) closeModal(); });
}
function closeModal() { $('#modal-root').innerHTML = ''; }

let ME = null;

/* ---------- темы и шрифты (сохраняются) ---------- */
function applyAppearance() {
  document.documentElement.dataset.theme = localStorage.getItem('ev_theme') || 'violet';
  document.documentElement.dataset.font = localStorage.getItem('ev_font') || 'modern';
}
applyAppearance();

/* ---------- auth ---------- */
let authMode = 'login';
function setAuthMode(m) {
  authMode = m;
  $('#tab-login').classList.toggle('active', m === 'login');
  $('#tab-register').classList.toggle('active', m === 'register');
  $('#auth-name').hidden = m === 'login';
  $('#auth-submit').textContent = m === 'login' ? 'Войти' : 'Зарегистрироваться';
  $('#auth-password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
}
$('#tab-login').onclick = () => setAuthMode('login');
$('#tab-register').onclick = () => setAuthMode('register');
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#auth-error').textContent = '';
  try {
    const body = { username: $('#auth-username').value, password: $('#auth-password').value, name: $('#auth-name').value };
    const { user } = await api(authMode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body: JSON.stringify(body) });
    ME = user; enterApp();
  } catch (err) { $('#auth-error').textContent = err.message; }
});
async function tryRestore() {
  try { const { user } = await api('/api/me'); ME = user; enterApp(); } catch { /* остаёмся на экране входа */ }
}
function enterApp() {
  $('#auth-screen').hidden = true;
  $('#app').hidden = false;
  showView('feed');
}

/* ---------- навигация ---------- */
let currentView = 'feed';
function showView(name) {
  currentView = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  ({ feed: renderFeed, reels: renderReels, chats: renderChats, channels: renderChannels, music: renderMusic, profile: renderProfile })[name]();
  window.scrollTo({ top: 0 });
}
$$('.nav-btn').forEach((b) => (b.onclick = () => showView(b.dataset.nav)));

/* ---------- шаринг в ЛС ---------- */
async function shareToFriend(sharedType, sharedRef, sharedLabel) {
  let contacts = [];
  try { contacts = (await api('/api/contacts')).contacts; } catch {}
  if (!contacts.length) { toast('Сначала добавьте друга в контакты (поиск сверху)'); return; }
  openModal(`<h3>Поделиться с другом</h3><div class="share-list stack">
    ${contacts.map((c) => `<button class="contact-row" data-share-to="${c.id}">${avatarHtml(c, 'sm')}<span class="grow"><span class="name-line">${esc(c.name)} ${badges(c)}</span><br><span class="muted">@${esc(c.username)}</span></span></button>`).join('')}
    </div><br><button class="btn" onclick="closeModal()">Отмена</button>`);
  $$('[data-share-to]').forEach((b) => (b.onclick = async () => {
    await api('/api/messages/' + b.dataset.shareTo, { method: 'POST', body: JSON.stringify({ text: '', sharedType, sharedRef, sharedLabel }) });
    closeModal(); toast('Отправлено в личные сообщения');
  }));
}

/* ---------- лента ---------- */
async function renderFeed() {
  const el = $('#view-feed');
  el.innerHTML = `
    <div class="card composer">
      <textarea id="post-text" placeholder="Что нового этим вечером, ${esc(ME.name)}?"></textarea>
      <div class="row between" style="margin-top:9px">
        <label class="btn small">📷 Фото <input id="post-image" type="file" accept="image/*" hidden></label>
        <button class="btn primary" id="post-send">Опубликовать</button>
      </div>
      <div id="post-img-name" class="hint"></div>
    </div>
    <div id="feed-list"><div class="empty">Загружаю ленту…</div></div>`;
  $('#post-image').onchange = (e) => ($('#post-img-name').textContent = e.target.files[0] ? 'Фото: ' + e.target.files[0].name : '');
  $('#post-send').onclick = async () => {
    const fd = new FormData();
    fd.append('text', $('#post-text').value);
    const f = $('#post-image').files[0]; if (f) fd.append('image', f);
    try { await api('/api/posts', { method: 'POST', body: fd }); renderFeed(); } catch (e) { toast(e.message); }
  };
  try {
    const [{ posts }, { posts: chanPosts }] = await Promise.all([api('/api/posts'), api('/api/channel-feed')]);
    const items = [
      ...posts.map((p) => ({ kind: 'post', at: p.id * 10, p })),
      ...chanPosts.map((p) => ({ kind: 'chan', at: p.id * 10 + 5, p })),
    ].sort((a, b) => b.at - a.at);
    $('#feed-list').innerHTML = items.length ? items.map((i) => (i.kind === 'post' ? postCard(i.p) : chanPostCard(i.p, true))).join('') : '<div class="empty">Пока пусто. Опубликуйте первый пост!</div>';
    bindPostCards($('#feed-list'));
  } catch (e) { $('#feed-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function postCard(p) {
  return `<article class="card" data-post="${p.id}">
    <div class="card-head">${avatarHtml(p.author)}<div class="grow">
      <span class="name-line">${esc(p.author.name)} ${badges(p.author)}</span><br>
      <span class="muted">@${esc(p.author.username)} · ${fmtDate(p.createdAt)}</span></div></div>
    ${p.image ? `<img class="card-img" src="${esc(p.image)}" alt="">` : ''}
    <div class="card-actions">
      <button class="icon-btn ${p.liked ? 'liked' : ''}" data-like="${p.id}">❤</button>
      <button class="icon-btn" data-focus-comment="${p.id}">💬</button>
      <button class="icon-btn" data-share-post="${p.id}">↗</button>
      <span class="muted" style="align-self:center">${p.likes} отметок «Нравится»</span>
    </div>
    <div class="card-body">
      ${p.text ? `<div><b>${esc(p.author.username)}</b> ${esc(p.text)}</div>` : ''}
      <div class="comments">${p.comments.map((c) => `<div><b>${esc(c.author.username)}</b> ${c.author.isVerified ? '✔' : ''} ${esc(c.text)}</div>`).join('')}</div>
      <form class="comment-form" data-comment-form="${p.id}">
        <input placeholder="Добавить комментарий…" maxlength="500"><button class="btn small primary">›</button>
      </form>
    </div></article>`;
}
function chanPostCard(p, inFeed) {
  return `<article class="card">
    <div class="card-head"><span class="avatar">📣</span><div class="grow">
      <span class="name-line">${esc(p.channel.name)} <span class="badge-owner" style="background:var(--accent)">КАНАЛ</span></span><br>
      <span class="muted">@${esc(p.channel.username)} · ${fmtDate(p.createdAt)}</span></div>
      ${inFeed ? `<button class="btn small" data-open-channel="${p.channel.id}">Открыть</button>` : ''}</div>
    ${p.media ? (p.mediaType === 'video' ? `<video class="card-img" src="${esc(p.media)}" controls></video>` : `<img class="card-img" src="${esc(p.media)}" alt="">`) : ''}
    <div class="card-body">${p.text ? `<div>${esc(p.text)}</div>` : ''}
      <div style="margin-top:8px"><button class="btn small" data-share-chanpost="${p.id}" data-label="${esc(p.channel.name)}: ${esc((p.text || 'пост канала').slice(0, 60))}">↗ Поделиться</button></div>
    </div></article>`;
}
function bindPostCards(root) {
  $$('[data-like]', root).forEach((b) => (b.onclick = async () => { await api(`/api/posts/${b.dataset.like}/like`, { method: 'POST', body: '{}' }); renderFeed(); }));
  $$('[data-comment-form]', root).forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const text = f.querySelector('input').value.trim(); if (!text) return;
    await api(`/api/posts/${f.dataset.commentForm}/comments`, { method: 'POST', body: JSON.stringify({ text }) }); renderFeed();
  }));
  $$('[data-share-post]', root).forEach((b) => (b.onclick = () => shareToFriend('post', b.dataset.sharePost, 'Пост из ленты Eventide')));
  $$('[data-share-chanpost]', root).forEach((b) => (b.onclick = () => shareToFriend('channel_post', b.dataset.shareChanpost, b.dataset.label)));
  $$('[data-open-channel]', root).forEach((b) => (b.onclick = () => { showView('channels'); setTimeout(() => openChannel(Number(b.dataset.openChannel)), 60); }));
}

/* ---------- рилсы ---------- */
async function renderReels() {
  const el = $('#view-reels');
  el.innerHTML = `
    <div class="card composer"><div class="row between">
      <b>Рилсы</b>
      <label class="btn small primary">＋ Загрузить видео <input id="reel-file" type="file" accept="video/*" hidden></label>
    </div><input id="reel-caption" placeholder="Подпись к видео…" style="margin-top:10px"></div>
    <div id="reels-list" class="reels-wrap"><div class="empty">Загружаю…</div></div>`;
  $('#reel-file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append('video', f); fd.append('caption', $('#reel-caption').value);
    try { await api('/api/reels', { method: 'POST', body: fd }); toast('Видео загружено'); renderReels(); } catch (err) { toast(err.message); }
  };
  try {
    const { reels } = await api('/api/reels');
    $('#reels-list').innerHTML = reels.length ? reels.map((r) => `
      <div class="reel">
        <video src="${esc(r.video)}" loop playsinline preload="metadata"></video>
        <div class="reel-actions">
          <button data-reel-like="${r.id}" class="${r.liked ? 'liked' : ''}">❤</button><small>${r.likes}</small>
          <button data-reel-share="${r.id}">↗</button><small>Делись</small>
        </div>
        <div class="reel-caption"><b>@${esc(r.author.username)}</b> ${r.author.isVerified ? '✔' : ''}<br>${esc(r.caption || '')}</div>
      </div>`).join('') : '<div class="empty">Рилсов пока нет. Загрузите первое вертикальное видео!</div>';
    // Автоплей видимого рилса (как в TikTok при скролле)
    const io = new IntersectionObserver((es) => es.forEach((en) => {
      const v = en.target; if (en.intersectionRatio > 0.6) v.play().catch(() => {}); else v.pause();
    }), { threshold: [0, 0.6, 1] });
    $$('#reels-list video').forEach((v) => { io.observe(v); v.onclick = () => (v.paused ? v.play() : v.pause()); });
    $$('[data-reel-like]').forEach((b) => (b.onclick = async () => { await api(`/api/reels/${b.dataset.reelLike}/like`, { method: 'POST', body: '{}' }); renderReels(); }));
    $$('[data-reel-share]').forEach((b) => (b.onclick = () => shareToFriend('reel', b.dataset.reelShare, 'Рилс из Eventide')));
  } catch (e) { $('#reels-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/* ---------- чаты (Telegram-style) ---------- */
let openPeerId = null;
async function renderChats() {
  openPeerId = null;
  const el = $('#view-chats');
  try {
    const [{ chats }, { contacts }] = await Promise.all([api('/api/chats'), api('/api/contacts')]);
    el.innerHTML = `
      ${contacts.length ? `<h4 class="search-group-title">Контакты</h4>` + contacts.map((c) => `
        <div class="contact-row" data-open-dialog="${c.id}">${avatarHtml(c)}<div class="grow">
          <span class="name-line">${esc(c.name)} ${badges(c)}</span><br><span class="muted">@${esc(c.username)}</span></div></div>`).join('') : ''}
      <h4 class="search-group-title">Диалоги</h4>
      ${chats.length ? chats.map((ch) => `
        <div class="chat-row" data-open-dialog="${ch.peer.id}">${avatarHtml(ch.peer)}<div class="grow">
          <div class="row between"><span class="name-line">${esc(ch.peer.name)} ${badges(ch.peer)}</span><span class="chat-time">${fmtTime(ch.last.createdAt)}</span></div>
          <div class="row between"><span class="chat-last">${ch.last.senderId === ME.id ? 'Ты: ' : ''}${esc(ch.last.sharedLabel || ch.last.text || 'Вложение')}</span>
          ${ch.unread ? `<span class="unread">${ch.unread}</span>` : ''}</div></div></div>`).join('')
        : '<div class="empty">Диалогов пока нет. Найдите друга через поиск 🔍 сверху и напишите ему.</div>'}`;
    $$('[data-open-dialog]', el).forEach((r) => (r.onclick = () => openDialog(Number(r.dataset.openDialog))));
  } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function openDialog(peerId) {
  openPeerId = peerId;
  const el = $('#view-chats');
  try {
    const { peer, messages } = await api('/api/messages/' + peerId);
    let lastDate = '';
    const bubbles = messages.map((m) => {
      const d = fmtDate(m.createdAt);
      const chip = d !== lastDate ? `<div class="date-chip">${d}</div>` : ''; lastDate = d;
      const out = m.senderId === ME.id;
      return chip + `<div class="bubble ${out ? 'out' : 'in'}">
        ${m.sharedLabel ? `<span class="shared">↗ ${esc(m.sharedLabel)}</span>` : ''}
        ${m.text ? esc(m.text) : ''}
        <span class="meta">${fmtTime(m.createdAt)} ${out ? (m.read ? '✔✔' : '✔') : ''}</span></div>`;
    }).join('');
    el.innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <button class="icon-btn" id="chat-back">‹</button>${avatarHtml(peer)}
        <div class="grow"><span class="name-line">${esc(peer.name)} ${badges(peer)}</span><br><span class="muted">@${esc(peer.username)}</span></div>
        <button class="btn small" id="chat-add-contact">В контакты</button>
      </div>
      <div class="dialog">${bubbles || '<div class="empty">Напишите первое сообщение</div>'}</div>
      <form class="msg-form" id="msg-form"><input id="msg-input" placeholder="Сообщение…" autocomplete="off"><button class="btn primary">➤</button></form>`;
    $('#chat-back').onclick = renderChats;
    $('#chat-add-contact').onclick = async () => { await api('/api/contacts', { method: 'POST', body: JSON.stringify({ userId: peerId }) }); toast('Добавлено в контакты'); };
    $('#msg-form').onsubmit = async (e) => {
      e.preventDefault();
      const text = $('#msg-input').value.trim(); if (!text) return;
      await api('/api/messages/' + peerId, { method: 'POST', body: JSON.stringify({ text }) });
      openDialog(peerId);
    };
    window.scrollTo({ top: document.body.scrollHeight });
  } catch (e) { toast(e.message); }
}

/* ---------- каналы (Telegram-style) ---------- */
async function renderChannels() {
  const el = $('#view-channels');
  try {
    const { channels } = await api('/api/channels');
    el.innerHTML = `
      <div class="row between" style="margin-bottom:8px"><b>Каналы</b><button class="btn small primary" id="chan-create">＋ Создать канал</button></div>
      ${channels.length ? channels.map((c) => `
        <div class="chan-row" data-channel="${c.id}"><span class="avatar">📣</span><div class="grow">
          <div class="row between"><span class="name-line">${esc(c.name)}</span><span class="chat-time">${c.lastPost ? fmtTime(c.lastPost.createdAt) : ''}</span></div>
          <div class="chat-last">${c.lastPost ? esc(c.lastPost.text || 'Медиа') : 'Нет постов'}</div>
          <span class="muted">@${esc(c.username)} · ${c.subs} подписчиков</span></div></div>`).join('')
        : '<div class="empty">Каналов пока нет. Создайте первый!</div>'}`;
    $('#chan-create').onclick = () => openModal(`
      <h3>Новый канал</h3><form id="chan-form" class="stack">
        <input id="cf-name" placeholder="Название канала" required>
        <input id="cf-username" placeholder="@username канала" required>
        <input id="cf-desc" placeholder="Описание (необязательно)">
        <div class="error" id="cf-error"></div>
        <button class="btn primary big">Создать</button></form>`);
    $('#chan-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const { channel } = await api('/api/channels', { method: 'POST', body: JSON.stringify({
          name: $('#cf-name').value, username: $('#cf-username').value, description: $('#cf-desc').value }) });
        closeModal(); renderChannels(); setTimeout(() => openChannel(channel.id), 60);
      } catch (err) { $('#cf-error').textContent = err.message; }
    };
    $$('[data-channel]', el).forEach((r) => (r.onclick = () => openChannel(Number(r.dataset.channel))));
  } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function openChannel(id) {
  const el = $('#view-channels');
  try {
    const { channel, posts } = await api('/api/channels/' + id);
    const mine = channel.ownerId === ME.id;
    el.innerHTML = `
      <div class="row" style="margin-bottom:10px"><button class="icon-btn" id="chan-back">‹</button><b>Канал</b></div>
      <div class="chan-head"><div class="row"><span class="avatar">📣</span><div class="grow">
        <span class="name-line">${esc(channel.name)}</span><br>
        <span class="muted">@${esc(channel.username)} · ${channel.subs} подписчиков</span>
        ${channel.description ? `<br>${esc(channel.description)}` : ''}</div>
        ${mine ? '<span class="badge-owner">МОЙ КАНАЛ</span>' : `<button class="btn small ${channel.subscribed ? '' : 'primary'}" id="chan-sub">${channel.subscribed ? 'Вы подписаны' : 'Подписаться'}</button>`}
      </div></div>
      <div>${posts.length ? posts.map((p) => `
        <div class="chan-post">
          ${p.media ? (p.mediaType === 'video' ? `<video src="${esc(p.media)}" controls></video>` : `<img src="${esc(p.media)}" alt="">`) : ''}
          ${p.text ? `<div>${esc(p.text)}</div>` : ''}
          <div class="row between" style="margin-top:5px"><span class="muted" style="font-size:12px">${fmtTime(p.createdAt)} · ${fmtDate(p.createdAt)}</span>
          <button class="btn small" data-share-cp="${p.id}">↗ Поделиться</button></div>
        </div>`).join('') : '<div class="empty">В канале пока нет постов</div>'}</div>
      ${mine ? `<div class="card composer"><textarea id="cp-text" placeholder="Новый пост канала…"></textarea>
        <div class="row between" style="margin-top:9px">
          <label class="btn small">📎 Фото/видео <input id="cp-media" type="file" accept="image/*,video/*" hidden></label>
          <button class="btn primary" id="cp-send">Опубликовать</button></div></div>` : ''}`;
    $('#chan-back').onclick = renderChannels;
    const sub = $('#chan-sub');
    if (sub) sub.onclick = async () => { await api(`/api/channels/${id}/subscribe`, { method: 'POST', body: '{}' }); openChannel(id); };
    $$('[data-share-cp]', el).forEach((b) => (b.onclick = () => shareToFriend('channel_post', b.dataset.shareCp, 'Пост канала ' + channel.name)));
    const send = $('#cp-send');
    if (send) send.onclick = async () => {
      const fd = new FormData(); fd.append('text', $('#cp-text').value);
      const f = $('#cp-media').files[0]; if (f) fd.append('media', f);
      try { await api(`/api/channels/${id}/posts`, { method: 'POST', body: fd }); openChannel(id); } catch (e) { toast(e.message); }
    };
  } catch (e) { toast(e.message); }
}

/* ---------- музыка и плеер ---------- */
const player = { queue: [], idx: -1 };
const audio = $('#audio');
function playQueue(queue, idx) {
  player.queue = queue; player.idx = idx; playCurrent();
}
function playCurrent() {
  const t = player.queue[player.idx];
  if (!t) return;
  const src = t.file || t.preview;
  if (!src) { toast('У этого трека нет доступного аудио'); return; }
  audio.src = src;
  audio.play().catch(() => {});
  $('#player').hidden = false;
  $('#main').classList.add('player-on');
  $('#player-title').textContent = t.title;
  $('#player-artist').textContent = (t.artist && t.artist.name) || '';
  $('#player-cover').src = (t.album && t.album.cover) || (t.artist && t.artist.picture) || '';
  $('#player-toggle').textContent = '⏸';
}
$('#player-toggle').onclick = () => { if (audio.paused) { audio.play(); $('#player-toggle').textContent = '⏸'; } else { audio.pause(); $('#player-toggle').textContent = '▶'; } };
$('#player-next').onclick = () => { if (player.idx < player.queue.length - 1) { player.idx++; playCurrent(); } };
$('#player-prev').onclick = () => { if (player.idx > 0) { player.idx--; playCurrent(); } };
$('#player-close').onclick = () => { audio.pause(); audio.removeAttribute('src'); $('#player').hidden = true; $('#main').classList.remove('player-on'); };
audio.addEventListener('ended', () => { if (player.idx < player.queue.length - 1) { player.idx++; playCurrent(); } });
audio.addEventListener('timeupdate', () => { if (audio.duration) $('#player-bar').style.width = (audio.currentTime / audio.duration * 100) + '%'; });

let likedIds = new Set();
async function refreshLikedIds() {
  try { likedIds = new Set((await api('/api/music/likes')).likes.map((t) => t.id)); } catch { likedIds = new Set(); }
}
function dzRow(t, queue) {
  const liked = likedIds.has(t.id);
  return `<div class="track-row">
    <img class="track-cover" src="${esc((t.album && t.album.cover) || '')}" alt="">
    <div class="grow"><div class="track-title" data-play-dz="${t.id}">${esc(t.title)}</div>
      <div class="track-artist" data-artist="${t.artist ? t.artist.id : ''}">${esc(t.artist ? t.artist.name : '')} · ${fmtDur(t.duration)} · фрагмент 30 сек</div></div>
    <button class="icon-btn" data-dz-page="${t.id}" title="Страница трека">›</button>
    <button class="icon-btn" data-like-dz="${t.id}" style="color:${liked ? '#f43f5e' : 'inherit'}">❤</button>
    <button class="icon-btn" data-share-dz="${t.id}" data-label="${esc((t.artist ? t.artist.name : '') + ' — ' + t.title)}">↗</button>
  </div>`;
}
function bindDzRows(root, queue) {
  $$('[data-play-dz]', root).forEach((b) => (b.onclick = () => { const i = queue.findIndex((t) => String(t.id) === b.dataset.playDz); if (i >= 0) playQueue(queue, i); }));
  $$('[data-like-dz]', root).forEach((b) => (b.onclick = async () => {
    const t = queue.find((x) => String(x.id) === b.dataset.likeDz);
    await api('/api/music/likes', { method: 'POST', body: JSON.stringify({ track: t }) });
    await refreshLikedIds(); renderMusic(currentMusicTab);
  }));
  $$('[data-share-dz]', root).forEach((b) => (b.onclick = () => shareToFriend('song', b.dataset.shareDz, '🎵 ' + b.dataset.label)));
  $$('[data-artist]', root).forEach((b) => (b.onclick = () => { if (b.dataset.artist) openArtist(Number(b.dataset.artist)); }));
  $$('[data-dz-page]', root).forEach((b) => (b.onclick = () => openTrackPage(Number(b.dataset.dzPage))));
}
function utRow(t) {
  return `<div class="track-row">
    <span class="track-cover" style="display:flex;align-items:center;justify-content:center;font-size:20px">🎧</span>
    <div class="grow"><div class="track-title" data-play-ut="${t.id}">${esc(t.title)}</div>
      <div class="track-artist">${esc(t.artist)} · загрузил @${esc(t.uploader.username)} · целиком</div></div>
    <button class="icon-btn" data-like-ut="${t.id}" style="color:${t.liked ? '#f43f5e' : 'inherit'}">❤</button>
    <button class="icon-btn" data-share-ut="${t.id}" data-label="${esc(t.artist + ' — ' + t.title)}">↗</button>
    <button class="icon-btn" data-pin-ut="${t.id}">📌</button>
  </div>`;
}
function bindUtRows(root, tracks) {
  $$('[data-play-ut]', root).forEach((b) => (b.onclick = () => {
    const q = tracks.map((t) => ({ id: 'ut' + t.id, title: t.title, artist: { name: t.artist }, file: t.file }));
    const i = tracks.findIndex((t) => String(t.id) === b.dataset.playUt); if (i >= 0) playQueue(q, i);
  }));
  $$('[data-like-ut]', root).forEach((b) => (b.onclick = async () => { await api(`/api/tracks/${b.dataset.likeUt}/like`, { method: 'POST', body: '{}' }); renderMusic(currentMusicTab); }));
  $$('[data-share-ut]', root).forEach((b) => (b.onclick = () => shareToFriend('user_track', b.dataset.shareUt, '🎵 ' + b.dataset.label)));
  $$('[data-pin-ut]', root).forEach((b) => (b.onclick = async () => {
    const t = tracks.find((x) => String(x.id) === b.dataset.pinUt);
    await api('/api/me/profile-songs', { method: 'POST', body: JSON.stringify({ kind: 'user_track', ref: t.id, data: { title: t.title, artist: t.artist, file: t.file } }) });
    toast('Песня закреплена в профиле');
  }));
}

let currentMusicTab = 'chart';
async function renderMusic(tab = 'chart') {
  currentMusicTab = tab;
  const el = $('#view-music');
  await refreshLikedIds();
  el.innerHTML = `
    <form id="music-search" class="row"><input id="mq" placeholder="Найти песню, исполнителя, альбом…"><button class="btn primary">Найти</button></form>
    <div class="chips">
      ${[['chart', '🔥 Популярное'], ['wave', '🌊 Моя волна'], ['likes', '❤ Мне нравится'], ['community', '🎧 Треки сообщества'], ['upload', '⬆ Загрузить свой']].map(([k, l]) => `<button class="chip ${tab === k ? 'active' : ''}" data-mtab="${k}">${l}</button>`).join('')}
    </div><div id="music-body"><div class="empty">Загружаю…</div></div>`;
  $$('[data-mtab]', el).forEach((b) => (b.onclick = () => renderMusic(b.dataset.mtab)));
  $('#music-search').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#mq').value.trim(); if (!q) return;
    const body = $('#music-body'); body.innerHTML = '<div class="empty">Ищу…</div>';
    try { const { tracks } = await api('/api/music/search?q=' + encodeURIComponent(q)); body.innerHTML = tracks.length ? tracks.map((t) => dzRow(t, tracks)).join('') : '<div class="empty">Ничего не нашлось</div>'; bindDzRows(body, tracks); }
    catch (err) { body.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  };
  const body = $('#music-body');
  try {
    if (tab === 'chart') { const { tracks } = await api('/api/music/chart'); body.innerHTML = tracks.map((t) => dzRow(t, tracks)).join(''); bindDzRows(body, tracks); }
    if (tab === 'wave') {
      const { wave, basedOn } = await api('/api/music/wave');
      body.innerHTML = `<div class="card composer"><b>🌊 Моя волна</b><br><span class="muted">${basedOn.length ? 'Собрана по вашим вкусам: ' + esc(basedOn.join(', ')) : 'Пока строится из чартов — лайкайте песни, и волна станет вашей'}</span>
        <br><button class="btn primary" style="margin-top:10px" id="wave-play">▶ Слушать волну</button></div>` +
        wave.map((t) => t.source === 'user' ? utRow({ id: t.userTrackId, title: t.title, artist: t.artist.name, file: t.file, uploader: { username: '' }, liked: false }) : dzRow(t, wave.filter((x) => x.source === 'deezer'))).join('');
      $('#wave-play').onclick = () => { if (wave.length) playQueue(wave.map((t) => t.source === 'user' ? { ...t, file: t.file } : t), 0); };
      bindDzRows(body, wave.filter((x) => x.source === 'deezer'));
    }
    if (tab === 'likes') {
      const [{ likes }, { tracks: uts }] = await Promise.all([api('/api/music/likes'), api('/api/tracks')]);
      const myLikedUt = uts.filter((t) => t.liked);
      body.innerHTML = (likes.length || myLikedUt.length)
        ? likes.map((t) => dzRow(t, likes)).join('') + myLikedUt.map(utRow).join('')
        : '<div class="empty">Пока пусто. Ставьте ❤ песням — они появятся здесь и соберут «Мою волну».</div>';
      bindDzRows(body, likes); bindUtRows(body, uts);
    }
    if (tab === 'community') {
      const { tracks } = await api('/api/tracks');
      body.innerHTML = tracks.length ? tracks.map(utRow).join('') : '<div class="empty">Сообщество пока не загрузило треков. Станьте первым!</div>';
      bindUtRows(body, tracks);
    }
    if (tab === 'upload') {
      body.innerHTML = `<div class="card composer"><b>Загрузить свой трек</b>
        <p class="hint">Аудиофайл до 20 МБ: mp3, m4a, ogg, wav. Название и исполнитель подхватятся из имени файла вида «Исполнитель — Название.mp3», или укажите вручную. Трек будет играть ЦЕЛИКОМ.</p>
        <div class="stack" style="display:flex;flex-direction:column;gap:10px">
          <input id="ut-artist" placeholder="Исполнитель">
          <input id="ut-title" placeholder="Название">
          <label class="btn">🎵 Выбрать файл <input id="ut-file" type="file" accept="audio/*,.mp3,.m4a,.ogg,.wav" hidden></label>
          <span id="ut-fname" class="hint"></span>
          <button class="btn primary" id="ut-send">Загрузить</button></div></div>`;
      $('#ut-file').onchange = (e) => ($('#ut-fname').textContent = e.target.files[0] ? e.target.files[0].name : '');
      $('#ut-send').onclick = async () => {
        const f = $('#ut-file').files[0]; if (!f) { toast('Выберите файл'); return; }
        const fd = new FormData(); fd.append('audio', f); fd.append('title', $('#ut-title').value); fd.append('artist', $('#ut-artist').value);
        try { await api('/api/tracks', { method: 'POST', body: fd }); toast('Трек загружен'); renderMusic('community'); } catch (err) { toast(err.message); }
      };
    }
  } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function openTrackPage(id) {
  const el = $('#view-music');
  try {
    const { track } = await api('/api/music/track/' + id);
    const { tracks: albumTracks } = track.album ? await api('/api/music/album/' + track.album.id) : { tracks: [] };
    el.innerHTML = `<button class="btn small" id="tp-back">‹ В музыку</button>
      <div class="hero"><img src="${esc((track.album && track.album.cover) || '')}" alt="">
        <h2>${esc(track.title)}</h2>
        <div class="track-artist" data-artist="${track.artist.id}" style="font-size:16px">${esc(track.artist.name)}</div>
        <p class="muted">${fmtDur(track.duration)} · в Eventide звучит официальный фрагмент 30 сек</p>
        <div class="row" style="justify-content:center">
          <button class="btn primary" id="tp-play">▶ Слушать</button>
          <a class="btn" href="${esc(track.link || '#')}" target="_blank" rel="noopener">Слушать полностью в Deezer</a>
          <button class="btn" id="tp-pin">📌 В профиль</button>
        </div></div>
      ${albumTracks.length ? '<h4 class="search-group-title">Треки альбома</h4>' + albumTracks.map((t) => dzRow(t, albumTracks)).join('') : ''}`;
    $('#tp-back').onclick = () => renderMusic('chart');
    $('#tp-play').onclick = () => playQueue([track], 0);
    $('#tp-pin').onclick = async () => { await api('/api/me/profile-songs', { method: 'POST', body: JSON.stringify({ kind: 'deezer', ref: track.id, data: track }) }); toast('Песня закреплена в профиле'); };
    bindDzRows(el, albumTracks);
  } catch (e) { toast(e.message); }
}
async function openArtist(id) {
  const el = $('#view-music'); showViewSilent('music');
  try {
    const d = await api('/api/music/artist/' + id);
    el.innerHTML = `<button class="btn small" id="ar-back">‹ В музыку</button>
      <div class="hero"><img class="round" src="${esc(d.artist.picture || '')}" alt="">
        <h2>${esc(d.artist.name)}</h2><p class="muted">${(d.artist.fans || 0).toLocaleString('ru-RU')} слушателей · ${d.artist.albumsCount || 0} альбомов</p></div>
      <h4 class="search-group-title">Топ треков</h4>${d.top.map((t) => dzRow(t, d.top)).join('')}
      <h4 class="search-group-title">Альбомы</h4><div class="grid-albums">
        ${d.albums.map((a) => `<div class="album-card" data-album="${a.id}"><img src="${esc(a.cover || '')}" alt=""><div>${esc(a.title)}</div><span class="muted">${esc(a.year || '')}</span></div>`).join('')}</div>
      <h4 class="search-group-title">Похожие артисты</h4>
      ${d.related.map((a) => `<div class="contact-row" data-artist2="${a.id}"><img class="avatar" src="${esc(a.picture || '')}" alt=""><div class="grow"><b>${esc(a.name)}</b><br><span class="muted">${(a.fans || 0).toLocaleString('ru-RU')} слушателей</span></div></div>`).join('')}`;
    $('#ar-back').onclick = () => renderMusic('chart');
    bindDzRows(el, d.top);
    $$('[data-album]', el).forEach((c) => (c.onclick = () => openAlbum(Number(c.dataset.album))));
    $$('[data-artist2]', el).forEach((c) => (c.onclick = () => openArtist(Number(c.dataset.artist2))));
  } catch (e) { toast(e.message); }
}
async function openAlbum(id) {
  const el = $('#view-music');
  try {
    const d = await api('/api/music/album/' + id);
    el.innerHTML = `<button class="btn small" id="al-back">‹ В музыку</button>
      <div class="hero"><img src="${esc(d.album.cover || '')}" alt=""><h2>${esc(d.album.title)}</h2>
      <div class="track-artist" data-artist="${d.album.artist.id}" style="font-size:16px">${esc(d.album.artist.name)}</div></div>
      ${d.tracks.map((t) => dzRow(t, d.tracks)).join('')}`;
    $('#al-back').onclick = () => renderMusic('chart');
    bindDzRows(el, d.tracks);
    $$('[data-artist]', el).forEach((b) => (b.onclick = () => openArtist(Number(b.dataset.artist))));
  } catch (e) { toast(e.message); }
}
function showViewSilent(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
}

/* ---------- профиль и настройки ---------- */
async function renderProfile() { renderUserProfile(ME.id, true); }
async function renderUserProfile(userId, isMine) {
  const el = $('#view-profile'); showViewSilent('profile');
  try {
    const [{ user, isContact }, { songs }, { tracks }, { posts }] = await Promise.all([
      api('/api/users/' + userId), api(`/api/users/${userId}/profile-songs`),
      api(`/api/users/${userId}/tracks`), api(`/api/users/${userId}/posts`),
    ]);
    const playProfileSong = (s) => s.kind === 'user_track'
      ? { id: 'ut' + s.ref, title: s.data.title, artist: { name: s.data.artist }, file: s.data.file }
      : s.data;
    el.innerHTML = `
      <div class="profile-head">
        <label style="cursor:${isMine ? 'pointer' : 'default'}">${avatarHtml(user, 'lg')}
          ${isMine ? '<input id="avatar-file" type="file" accept="image/*" hidden>' : ''}</label>
        <h2 style="margin:10px 0 2px"><span class="name-line" style="justify-content:center">${esc(user.name)} ${badges(user)}</span></h2>
        <div class="muted">@${esc(user.username)}</div>
        ${user.bio ? `<p>${esc(user.bio)}</p>` : ''}
        ${isMine ? '' : `<div class="row" style="justify-content:center;margin-top:10px">
          <button class="btn primary" id="pu-msg">Написать</button>
          <button class="btn" id="pu-contact">${isContact ? 'В контактах' : 'В контакты'}</button></div>`}
      </div>
      <h4 class="search-group-title">🎵 Музыка в профиле</h4>
      ${songs.length ? songs.map((s) => `<div class="track-row">
          <span class="track-cover" style="display:flex;align-items:center;justify-content:center">🎵</span>
          <div class="grow"><div class="track-title" data-psong="${s.id}">${esc(s.data.title || '')}</div>
          <div class="track-artist">${esc(s.data.artist ? (s.data.artist.name || s.data.artist) : '')} ${s.kind === 'deezer' ? '· фрагмент 30 сек' : '· целиком'}</div></div>
          ${isMine ? `<button class="icon-btn" data-unpin="${s.id}">✕</button>` : ''}</div>`).join('')
        : '<div class="empty">Песен в профиле пока нет' + (isMine ? '. Закрепляйте треки кнопкой 📌 в разделе «Музыка».' : '') + '</div>'}
      <h4 class="search-group-title">🎧 Загруженные треки</h4>
      ${tracks.length ? tracks.map(utRow).join('') : '<div class="empty">Нет загруженных треков</div>'}
      <h4 class="search-group-title">Посты</h4>
      ${posts.length ? posts.map(postCard).join('') : '<div class="empty">Постов пока нет</div>'}
      ${isMine ? `<div style="margin-top:22px" class="stack" style="display:flex;flex-direction:column;gap:10px">
        <button class="btn big" id="open-settings">⚙ Настройки</button>
        ${ME.isOwner ? '<button class="btn big" id="open-admin">🛡 Админ-панель владельца</button>' : ''}
        <button class="btn big danger" id="logout">Выйти</button></div>` : ''}`;
    if (isMine) {
      const af = $('#avatar-file');
      if (af) af.onchange = async (e) => { const f = e.target.files[0]; if (!f) return;
        const fd = new FormData(); fd.append('avatar', f);
        try { ME = (await api('/api/me/avatar', { method: 'POST', body: fd })).user; toast('Аватарка обновлена'); renderProfile(); } catch (err) { toast(err.message); } };
      $('#open-settings').onclick = renderSettings;
      const adm = $('#open-admin'); if (adm) adm.onclick = renderAdmin;
      $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST', body: '{}' }); location.reload(); };
    } else {
      $('#pu-msg').onclick = () => { showView('chats'); setTimeout(() => openDialog(userId), 60); };
      $('#pu-contact').onclick = async () => { await api('/api/contacts', { method: 'POST', body: JSON.stringify({ userId }) }); toast('Добавлено в контакты'); };
    }
    $$('[data-psong]', el).forEach((b) => (b.onclick = () => {
      const q = songs.map(playProfileSong);
      const i = songs.findIndex((s) => String(s.id) === b.dataset.psong); if (i >= 0) playQueue(q, i);
    }));
    $$('[data-unpin]', el).forEach((b) => (b.onclick = async () => { await api('/api/me/profile-songs/' + b.dataset.unpin, { method: 'DELETE' }); renderProfile(); }));
    bindUtRows(el, tracks); bindPostCards(el);
  } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function renderSettings() {
  const el = $('#view-profile');
  const theme = localStorage.getItem('ev_theme') || 'violet';
  const font = localStorage.getItem('ev_font') || 'modern';
  el.innerHTML = `
    <div class="row" style="margin-bottom:12px"><button class="icon-btn" id="set-back">‹</button><b>Настройки</b></div>
    <div class="settings-list">
      <div class="settings-group"><h4>Аккаунт</h4>
        <div class="settings-item"><span>Имя</span><input id="set-name" value="${esc(ME.name)}" style="max-width:55%"></div>
        <div class="settings-item"><span>О себе</span><input id="set-bio" value="${esc(ME.bio || '')}" style="max-width:55%"></div>
        <div class="settings-item"><span>Юзернейм</span><span class="muted">@${esc(ME.username)} · изменить нельзя</span></div>
        <div class="settings-item"><span></span><button class="btn small primary" id="set-save">Сохранить</button></div>
      </div>
      <div class="settings-group"><h4>Оформление</h4>
        <div class="settings-item"><span>Тема</span><div class="swatches">
          ${[['violet', '#8b5cf6', 'Фиолетовая ночь'], ['redblack', '#ef4444', 'Красно-чёрная'], ['frost', '#38bdf8', 'Морозная'], ['taiga', '#34d399', 'Таёжная']].map(([k, c, l]) => `<button class="swatch ${theme === k ? 'active' : ''}" data-theme-set="${k}" title="${l}" style="background:${c}"></button>`).join('')}
        </div></div>
        <div class="settings-item"><span>Шрифт</span><select id="set-font" style="max-width:55%">
          ${[['modern', 'Современный'], ['serif', 'Книжный (serif)'], ['mono', 'Моноширинный'], ['rounded', 'Округлый']].map(([k, l]) => `<option value="${k}" ${font === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      </div>
      <div class="settings-group"><h4>Уведомления</h4>
        <div class="settings-item"><span>Новые сообщения</span><input type="checkbox" checked style="width:auto"></div>
        <div class="settings-item"><span>Новые посты каналов</span><input type="checkbox" checked style="width:auto"></div>
      </div>
      <div class="settings-group"><h4>Приватность</h4>
        <div class="settings-item"><span>Кто видит мои треки</span><span class="muted">Все</span></div>
        <div class="settings-item"><span>Кто может писать мне</span><span class="muted">Все</span></div>
      </div>
      <div class="settings-group"><h4>Данные и память</h4>
        <div class="settings-item"><span>Медиа хранятся в облаке Eventide</span><span class="muted">Cloudinary</span></div>
      </div>
      <div class="settings-group"><h4>Язык</h4>
        <div class="settings-item"><span>Язык интерфейса</span><span class="muted">Русский</span></div>
      </div>
    </div>`;
  $('#set-back').onclick = renderProfile;
  $('#set-save').onclick = async () => {
    try { ME = (await api('/api/me', { method: 'PATCH', body: JSON.stringify({ name: $('#set-name').value, bio: $('#set-bio').value }) })).user; toast('Сохранено'); } catch (e) { toast(e.message); }
  };
  $$('[data-theme-set]').forEach((b) => (b.onclick = () => { localStorage.setItem('ev_theme', b.dataset.themeSet); applyAppearance(); renderSettings(); }));
  $('#set-font').onchange = (e) => { localStorage.setItem('ev_font', e.target.value); applyAppearance(); };
}
async function renderAdmin() {
  const el = $('#view-profile');
  try {
    const { users } = await api('/api/admin/users');
    el.innerHTML = `<div class="row" style="margin-bottom:12px"><button class="icon-btn" id="adm-back">‹</button><b>🛡 Админ-панель владельца</b></div>
      ${users.map((u) => `<div class="contact-row" style="cursor:default">${avatarHtml(u)}<div class="grow">
        <span class="name-line">${esc(u.name)} ${badges(u)}</span><br><span class="muted">@${esc(u.username)}</span></div>
        <button class="btn small ${u.isVerified ? '' : 'primary'}" data-verify="${u.id}" data-v="${u.isVerified ? 0 : 1}">${u.isVerified ? 'Снять галочку' : 'Дать галочку ✔'}</button></div>`).join('')}`;
    $('#adm-back').onclick = renderProfile;
    $$('[data-verify]').forEach((b) => (b.onclick = async () => {
      await api('/api/admin/verify', { method: 'POST', body: JSON.stringify({ userId: Number(b.dataset.verify), verified: b.dataset.v === '1' }) });
      renderAdmin();
    }));
  } catch (e) { toast(e.message); }
}

/* ---------- глобальный поиск ---------- */
$('#global-search-btn').onclick = () => {
  openModal(`<h3>Поиск</h3>
    <input id="gs-q" placeholder="Люди, каналы, чаты — по имени или @username">
    <div id="gs-results"><div class="empty">Начните вводить — найду всё в одном месте</div></div>
    <br><button class="btn" onclick="closeModal()">Закрыть</button>`);
  const input = $('#gs-q'); input.focus();
  let timer;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim(); if (!q) return;
      try {
        const r = await api('/api/search?q=' + encodeURIComponent(q));
        const person = (u) => `<div class="contact-row" data-gs-user="${u.id}">${avatarHtml(u, 'sm')}<div class="grow"><span class="name-line">${esc(u.name)} ${badges(u)}</span><br><span class="muted">@${esc(u.username)}</span></div><button class="btn small" data-gs-msg="${u.id}">Написать</button></div>`;
        $('#gs-results').innerHTML =
          (r.chats.length ? '<div class="search-group-title">Чаты</div>' + r.chats.map(person).join('') : '') +
          (r.users.length ? '<div class="search-group-title">Люди</div>' + r.users.map(person).join('') : '') +
          (r.channels.length ? '<div class="search-group-title">Каналы</div>' + r.channels.map((c) => `<div class="contact-row" data-gs-chan="${c.id}"><span class="avatar sm">📣</span><div class="grow"><b>${esc(c.name)}</b><br><span class="muted">@${esc(c.username)} · ${c.subs} подписчиков</span></div></div>`).join('') : '') ||
          '<div class="empty">Ничего не нашлось</div>';
        $$('[data-gs-user]').forEach((row) => (row.onclick = (e) => { if (e.target.dataset.gsMsg) return; closeModal(); renderUserProfile(Number(row.dataset.gsUser), Number(row.dataset.gsUser) === ME.id); }));
        $$('[data-gs-msg]').forEach((b) => (b.onclick = () => { closeModal(); showView('chats'); setTimeout(() => openDialog(Number(b.dataset.gsMsg)), 60); }));
        $$('[data-gs-chan]').forEach((row) => (row.onclick = () => { closeModal(); showView('channels'); setTimeout(() => openChannel(Number(row.dataset.gsChan)), 60); }));
      } catch (e) { $('#gs-results').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    }, 250);
  };
};

/* ---------- старт ---------- */
tryRestore();
