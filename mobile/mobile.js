'use strict';

const $ = (selector) => document.querySelector(selector);
const state = {
  token: '',
  connected: false,
  photoBlob: null,
  photoW: 0,
  photoH: 0,
  audioBlob: null,
  audioDuration: 0,
  recorder: null,
  stream: null,
  chunks: [],
  recordStarted: 0,
  timer: null
};

/* ── token ── */
const pageUrl = new URL(location.href);
const urlToken = pageUrl.searchParams.get('token');
if (urlToken) {
  state.token = urlToken;
  try { localStorage.setItem('hippocampus_token', urlToken); } catch (e) { /* ignore */ }
  pageUrl.searchParams.delete('token');
  history.replaceState({}, '', pageUrl.pathname + pageUrl.search + pageUrl.hash);
} else {
  try { state.token = localStorage.getItem('hippocampus_token') || ''; } catch (e) { /* ignore */ }
}

/* ── helpers ── */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function setStatus(text, kind) {
  const el = $('#status');
  if (!el) return;
  el.className = 'status ' + (kind || '');
  el.innerHTML = '<i></i>' + esc(text);
}

let toastTimer = null;
function toast(text, bad) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('bad', !!bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
}

function vibrate() {
  try { navigator.vibrate && navigator.vibrate(18); } catch (e) { /* ignore */ }
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtTime(ms) {
  const d = new Date(ms || Date.now());
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return hh + ':' + mm;
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hh + ':' + mm;
}

async function request(path, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({}, opts.headers || {});
  if (state.token) opts.headers['X-Hippocampus-Token'] = state.token;
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (res.status === 401) {
    state.connected = false;
    setStatus('未配对', 'bad');
    showPair();
    throw new Error('配对失效，请重新扫码或填配对码');
  }
  if (!res.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || ('HTTP ' + res.status));
  }
  return data || {};
}

/* ── pairing ── */
function showPair() {
  const card = $('#pairCard');
  if (card) card.hidden = false;
}
function hidePair() {
  const card = $('#pairCard');
  if (card) card.hidden = true;
}

async function ping() {
  try {
    const data = await request('/api/sense/ping');
    state.connected = true;
    setStatus('已连接 · ' + (data.nodes || 0) + ' 条记忆', 'ok');
    hidePair();
    return true;
  } catch (e) {
    state.connected = false;
    setStatus('连接不上电脑', 'bad');
    showPair();
    return false;
  }
}

async function pair() {
  const input = $('#tokenInput');
  const token = (input && input.value || '').trim();
  if (!token) {
    toast('先填配对码', true);
    return;
  }
  state.token = token;
  try { localStorage.setItem('hippocampus_token', token); } catch (e) { /* ignore */ }
  const ok = await ping();
  if (ok) {
    toast('已连接电脑大脑');
    refreshRecent();
  } else {
    toast('配对码不对，或电脑服务没开', true);
  }
}

/* ── photo ── */
async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) { /* fall through */ }
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    const u = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(u); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(u); reject(new Error('图片解码失败')); };
    image.src = u;
  });
}

async function prepareImage(file) {
  try {
    const bitmap = await loadBitmap(file);
    const width = bitmap.width || bitmap.naturalWidth || 0;
    const height = bitmap.height || bitmap.naturalHeight || 0;
    if (!width || !height) throw new Error('图片尺寸异常');
    const max = 1600;
    const scale = Math.min(1, max / Math.max(width, height));
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, tw, th);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.84));
    if (!blob) throw new Error('压缩失败');
    return { blob, width: tw, height: th };
  } catch (e) {
    if (/^image\/(jpeg|png|webp)$/i.test(file.type)) {
      return { blob: file, width: 0, height: 0 };
    }
    throw e;
  }
}

function resetPhoto() {
  state.photoBlob = null;
  state.photoW = 0;
  state.photoH = 0;
  const preview = $('#photoPreview');
  if (preview) preview.hidden = true;
  const img = $('#photoImg');
  if (img) img.removeAttribute('src');
  const note = $('#photoNote');
  if (note) note.value = '';
}

async function onPhotoPicked(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    toast('请选择图片文件', true);
    return;
  }
  const btn = $('#photoInput');
  try {
    if (btn) btn.disabled = true;
    const prepared = await prepareImage(file);
    state.photoBlob = prepared.blob;
    state.photoW = prepared.width;
    state.photoH = prepared.height;
    const img = $('#photoImg');
    img.src = URL.createObjectURL(prepared.blob);
    $('#photoMeta').textContent = (prepared.width ? prepared.width + '×' + prepared.height + ' · ' : '') + fmtSize(prepared.blob.size);
    $('#photoPreview').hidden = false;
    $('#photoPreview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    toast('这张照片打不开：' + e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function sendPhoto() {
  if (!state.photoBlob) {
    toast('先拍一张，或选一张照片', true);
    return;
  }
  const btn = $('#photoSend');
  const note = ($('#photoNote').value || '').trim();
  btn.disabled = true;
  btn.textContent = '送入中…';
  try {
    const qs = new URLSearchParams({ note, w: String(state.photoW || 0), h: String(state.photoH || 0) });
    const data = await request('/api/sense/photo?' + qs.toString(), {
      method: 'POST',
      headers: { 'Content-Type': state.photoBlob.type || 'image/jpeg' },
      body: state.photoBlob
    });
    toast('已送入：' + data.title);
    vibrate();
    resetPhoto();
    refreshRecent();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '送入大脑';
  }
}

/* ── audio ── */
function canRecord() {
  return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

function updateRecordButton(recording) {
  const btn = $('#recordBtn');
  if (!btn) return;
  btn.classList.toggle('on', !!recording);
  const title = btn.querySelector('b');
  const sub = btn.querySelector('small');
  if (title) title.textContent = recording ? '停止录音' : '开始录音';
  if (sub) sub.textContent = recording ? '再点一次停止并预览' : '再点一次停止';
}

function startTimer() {
  const el = $('#recordTimer');
  if (!el) return;
  el.hidden = false;
  el.classList.add('on');
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    const seconds = Math.max(0, Math.floor((Date.now() - state.recordStarted) / 1000));
    el.textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  }, 200);
}

function stopTimer() {
  clearInterval(state.timer);
  state.timer = null;
  const el = $('#recordTimer');
  if (el) {
    el.classList.remove('on');
    el.hidden = true;
  }
}

function finishRecording(recorder) {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  const type = (recorder.mimeType || 'audio/webm').split(';')[0];
  const blob = new Blob(state.chunks, { type: recorder.mimeType || type });
  state.audioBlob = blob;
  state.audioDuration = Math.max(0, (Date.now() - state.recordStarted) / 1000);
  state.recorder = null;
  const player = $('#audioPlayer');
  if (player) player.src = URL.createObjectURL(blob);
  const preview = $('#recordPreview');
  if (preview) preview.hidden = false;
  updateRecordButton(false);
  stopTimer();
  toast('录好了，可以加一句备注');
}

async function startRecording() {
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    const mime = types.find((type) => window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(type)) || '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    state.chunks = [];
    state.stream = stream;
    state.recorder = recorder;
    state.recordStarted = Date.now();
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) state.chunks.push(event.data);
    };
    recorder.onstop = () => finishRecording(recorder);
    recorder.start(250);
    updateRecordButton(true);
    startTimer();
  } catch (e) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    state.recorder = null;
    toast('无法开麦：' + e.message, true);
  }
}

function stopRecording() {
  const recorder = state.recorder;
  if (!recorder) return;
  try { recorder.stop(); } catch (e) { /* ignore */ }
}

async function toggleRecord() {
  if (state.recorder && state.recorder.state === 'recording') stopRecording();
  else await startRecording();
}

async function sendAudio(blob, note, duration, button) {
  if (!blob) {
    toast('先录一段，或选一段录音', true);
    return;
  }
  const old = button.textContent;
  button.disabled = true;
  button.textContent = '送入中…';
  const type = (blob.type || 'audio/webm').split(';')[0];
  try {
    const qs = new URLSearchParams({ note, duration: String(duration || 0) });
    const data = await request('/api/sense/audio?' + qs.toString(), {
      method: 'POST',
      headers: { 'Content-Type': type },
      body: blob
    });
    toast('已送入：' + data.title);
    vibrate();
    resetRecorded();
    refreshRecent();
  } catch (e) {
    toast(e.message, true);
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
}

function resetRecorded() {
  state.audioBlob = null;
  state.audioDuration = 0;
  const preview = $('#recordPreview');
  if (preview) preview.hidden = true;
  const player = $('#audioPlayer');
  if (player) player.removeAttribute('src');
  const note = $('#audioNote');
  if (note) note.value = '';
  const fallbackPreview = $('#fallbackPreview');
  if (fallbackPreview) fallbackPreview.hidden = true;
  const fallbackPlayer = $('#fallbackPlayer');
  if (fallbackPlayer) fallbackPlayer.removeAttribute('src');
  const fallbackNote = $('#fallbackNote');
  if (fallbackNote) fallbackNote.value = '';
  updateRecordButton(false);
  stopTimer();
}

function setupAudio() {
  if (canRecord()) {
    $('#recorderBox').hidden = false;
    $('#audioFallback').hidden = true;
    $('#recordBtn').addEventListener('click', toggleRecord);
    $('#audioSend').addEventListener('click', () => {
      sendAudio(state.audioBlob, ($('#audioNote').value || '').trim(), state.audioDuration, $('#audioSend'));
    });
    $('#audioReset').addEventListener('click', resetRecorded);
  } else {
    $('#recorderBox').hidden = true;
    $('#audioFallback').hidden = false;
    $('#audioInput').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      if (!/^audio\//.test(file.type)) {
        toast('请选择音频文件', true);
        return;
      }
      state.audioBlob = file;
      state.audioDuration = 0;
      const player = $('#fallbackPlayer');
      if (player) player.src = URL.createObjectURL(file);
      $('#fallbackPreview').hidden = false;
      $('#fallbackPreview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    $('#fallbackSend').addEventListener('click', () => {
      sendAudio(state.audioBlob, ($('#fallbackNote').value || '').trim(), state.audioDuration, $('#fallbackSend'));
    });
  }
}

/* ── text note ── */
async function sendNote() {
  const text = ($('#noteText').value || '').trim();
  if (!text) {
    toast('先写一句', true);
    return;
  }
  const btn = $('#noteSend');
  btn.disabled = true;
  btn.textContent = '送入中…';
  try {
    const data = await request('/api/sense/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    toast('已送入：' + data.title);
    vibrate();
    $('#noteText').value = '';
    refreshRecent();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '送去大脑';
  }
}

/* ── recent ── */
async function refreshRecent() {
  try {
    const data = await request('/api/sense/recent?limit=6');
    const list = $('#recentList');
    if (!list) return;
    if (!data.results || !data.results.length) {
      list.innerHTML = '<div class="empty">还没有手机记忆。</div>';
      return;
    }
    const tokenQuery = state.token ? ('?token=' + encodeURIComponent(state.token)) : '';
    list.innerHTML = data.results.map((item) => {
      let icon = '✎';
      if (item.kind === 'phone-photo' && item.url) {
        icon = '<img src="' + esc(item.url + tokenQuery) + '" alt="">';
      } else if (item.kind === 'phone-audio') {
        icon = '♪';
      }
      const label = item.kind === 'phone-photo' ? '照片' : item.kind === 'phone-audio' ? '录音' : '文字';
      return '<div class="recent-item"><div class="thumb">' + icon + '</div>' +
        '<div class="recent-main"><b>' + esc(item.title) + '</b>' +
        '<span>' + label + ' · ' + fmtTime(item.createdAt) + '</span></div></div>';
    }).join('');
  } catch (e) { /* 未配对时静默 */ }
}

/* ── init ── */
function init() {
  $('#pairBtn').addEventListener('click', pair);
  $('#tokenInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') pair();
  });
  $('#photoInput').addEventListener('change', onPhotoPicked);
  $('#photoSend').addEventListener('click', sendPhoto);
  $('#photoClear').addEventListener('click', resetPhoto);
  $('#noteSend').addEventListener('click', sendNote);
  $('#refreshRecent').addEventListener('click', refreshRecent);
  setupAudio();
  ping().then((ok) => {
    if (ok) refreshRecent();
  });
  window.addEventListener('online', ping);
  window.addEventListener('offline', () => setStatus('网络断开', 'bad'));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
