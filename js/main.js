import { builtinFMBank } from './fmbank.js';
import { parseOP2 } from './op2.js';
import { parseSMF } from './smf.js';
import { demoSong } from './demo.js';
import { GM_NAMES, ERAS } from './gm.js';

const $ = (id) => document.getElementById(id);
const BUILTIN_SF2 = 'soundfonts/GeneralUser-GS.sf2';

let ctx = null, node = null;
const app = { era: 1, mute: new Uint8Array(16), solo: -1, userMute: new Uint8Array(16), liveCh: 0, octave: 4, programs: new Array(16).fill(0), banks: new Array(16).fill(0) };

// ------------------------------------------------------------ boot
const BOOT = [
  'Award Modular BIOS v4.51PG, An Energy Star Ally',
  'Copyright (C) 1984-95, Award Software, Inc.',
  '',
  'Main Processor : PENTIUM-S 133MHz',
  'Memory Testing : 16384K OK',
  '',
  'C:\\> SET BLASTER=A220 I5 D1 H5 P330 T6',
  'C:\\> CD \\BLASTA',
  'C:\\BLASTA> BLASTA.EXE /GM',
];
(function typeBoot() {
  const el = $('bootText');
  let i = 0;
  const step = () => { if (i < BOOT.length) { el.textContent += BOOT[i++] + '\n'; setTimeout(step, i < 3 ? 120 : 160); } };
  step();
})();
const powerOn = async () => {
  window.removeEventListener('keydown', powerOn);
  $('boot').removeEventListener('pointerdown', powerOn);
  $('boot').classList.add('gone');
  await initAudio();
};
window.addEventListener('keydown', powerOn);
$('boot').addEventListener('pointerdown', powerOn);

// ------------------------------------------------------------ audio
async function initAudio() {
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('js/blasta-worklet.js');
  node = new AudioWorkletNode(ctx, 'blasta', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  node.connect(ctx.destination);
  node.port.onmessage = (e) => onStat(e.data);
  if (ctx.state !== 'running') await ctx.resume();
  post({ t: 'fmbank', bank: builtinFMBank() });
  post({ t: 'era', v: app.era });
  post({ t: 'master', v: +$('vol').value });
  setStatus('FM cards ready. Burning wavetable ROMs…');
  player.load(demoSong());
  await restoreSaved();
}
const post = (m, tr) => node && node.port.postMessage(m, tr || []);
const sendNow = (st, d1, d2 = 0) => post({ t: 'now', ev: [[st, d1, d2]] });
const setStatus = (s) => { $('status').textContent = s; };

// ------------------------------------------------------------ sound banks
const worker = new Worker('js/rom-worker.js', { type: 'module' });
let jobId = 0;
const jobs = new Map();
worker.onmessage = (e) => {
  const d = e.data, j = jobs.get(d.id);
  if (!j) return;
  if (d.progress !== undefined) { j.progress && j.progress(d.stage, d.progress); return; }
  jobs.delete(d.id);
  d.ok ? j.res(d) : j.rej(new Error(d.error));
};
function burn(buf, budgets, progress) {
  return new Promise((res, rej) => {
    const id = ++jobId; jobs.set(id, { res, rej, progress });
    worker.postMessage({ id, buf, budgets }, [buf]);
  });
}
const prog = (f) => { $('progBar').style.width = Math.round(f * 100) + '%'; };
const mb = (b) => (b / 1048576).toFixed(b < 1048576 * 10 ? 2 : 1) + ' MB';

async function fetchWithProgress(url, onp) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !total) return r.arrayBuffer();
  const reader = r.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, got); got += value.length; onp(got / total);
  }
  return out.buffer;
}

// ---- banks you load are kept in this browser (IndexedDB) and restored on every visit ----
const store = {
  db: null,
  open() {
    return this.db || (this.db = new Promise((res, rej) => {
      const r = indexedDB.open('blasta', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('banks');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  },
  async op(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const q = fn(db.transaction('banks', mode).objectStore('banks'));
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  },
  get(k) { return this.op('readonly', s => s.get(k)).catch(() => null); },
  put(k, v) { return this.op('readwrite', s => s.put(v, k)); },
  del(k) { return this.op('readwrite', s => s.delete(k)).catch(() => {}); },
};
const PIN = ' · 📌 saved in this browser';
const BUDGET = { 2: 'awe', 3: 'live' };

async function restoreSaved() {
  const [fm, s2, s3] = await Promise.all([store.get('fm'), store.get('sf2'), store.get('sf3')]);
  if (fm) await loadOP2(fm.blob, fm.name, { save: false });
  const need = [];
  for (const [core, saved] of [[2, s2], [3, s3]]) {
    if (saved) { $('budget' + core).checked = saved.budget !== 'raw'; await loadUserSF2(saved.blob, saved.name, core, { save: false, jump: false }); }
    else need.push(BUDGET[core]);
  }
  if (need.length) await loadBuiltinSF2(need);
  else setStatus('All four cards ready (your saved banks).');
}

async function loadBuiltinSF2(budgets = ['awe', 'live']) {
  const cores = budgets.map(b => b === 'awe' ? 2 : 3);
  try {
    for (const c of cores) $('st' + c).textContent = 'downloading GeneralUser GS…';
    const buf = await fetchWithProgress(BUILTIN_SF2, (f) => prog(f * 0.5));
    for (const c of cores) $('st' + c).textContent = 'burning ROM…';
    const r = await burn(buf, budgets, (stage, p) => prog(0.5 + p * 0.5));
    if (r.banks.awe) installSF(2, r.banks.awe, 'GeneralUser GS → AWE-style ROM');
    if (r.banks.live) installSF(3, r.banks.live, 'GeneralUser GS → Live!-style bank');
    prog(1); setTimeout(() => prog(0), 800);
    setStatus('All four cards ready.');
  } catch (err) {
    for (const c of cores) $('st' + c).textContent = 'failed: ' + err.message;
    setStatus('Could not load the wavetable bank — load your own .SF2 below.');
  }
}
function installSF(core, bank, label) {
  const bytes = bank.pool.length * 2;
  post({ t: 'sfbank', core, bank }, [bank.pool.buffer]);
  $('st' + core).textContent = `${label} · ${mb(bytes)} of samples`;
}
async function saveBank(key, rec, statusEl) {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();   // ask the browser not to evict it
    await store.put(key, rec);
    statusEl.textContent += PIN;
  } catch (err) {
    statusEl.textContent += ' · not saved (' + (err.name === 'QuotaExceededError' ? 'browser storage full' : err.message) + ')';
  }
}
async function loadUserSF2(blob, name, core, { save = true, jump = true } = {}) {
  const budget = $('budget' + core).checked ? BUDGET[core] : 'raw';
  $('st' + core).textContent = 'reading ' + name + '…';
  try {
    const r = await burn(await blob.arrayBuffer(), [budget], (s, p) => prog(p));
    installSF(core, r.banks[budget], name + (budget === 'raw' ? '' : budget === 'awe' ? ' → AWE-style' : ' → Live!-style'));
    prog(0);
    if (save) await saveBank('sf' + core, { name, budget, blob }, $('st' + core));
    else $('st' + core).textContent += PIN;
    if (jump) setEra(core);
  } catch (err) { $('st' + core).textContent = 'error: ' + err.message; }
}
async function loadOP2(blob, name, { save = true } = {}) {
  try {
    const bank = parseOP2(await blob.arrayBuffer());
    post({ t: 'fmbank', bank });
    $('stFM').textContent = name;
    if (save) { await saveBank('fm', { name, blob }, $('stFM')); if (app.era > 1.5) setEra(1); }
    else $('stFM').textContent += PIN;
  } catch (err) { $('stFM').textContent = 'error: ' + err.message; }
}
$('fileOP2').onchange = (e) => { const f = e.target.files[0]; if (f) loadOP2(f, f.name); e.target.value = ''; };
for (const [id, core] of [['fileSF2a', 2], ['fileSF2b', 3]]) {
  $(id).onchange = (e) => { const f = e.target.files[0]; if (f) loadUserSF2(f, f.name, core); e.target.value = ''; };
  // flipping the budget box re-burns the saved bank the new way
  $('budget' + core).onchange = async () => {
    const saved = await store.get('sf' + core);
    if (saved && ctx) loadUserSF2(saved.blob, saved.name, core, { save: true, jump: false });
  };
  $('reset' + core).onclick = async () => { await store.del('sf' + core); if (ctx) loadBuiltinSF2([BUDGET[core]]); };
}
$('btnFMReset').onclick = async () => {
  await store.del('fm');
  post({ t: 'fmbank', bank: builtinFMBank() }); $('stFM').textContent = 'Blasta Original FM';
};

// ------------------------------------------------------------ era
const CHIPS = [['YM3812', '', 'SOUND BLASTER 2.0', '#1f6b35'], ['YMF262', 'CT1745', 'SOUND BLASTER 16', '#1f6b35'],
  ['EMU8000', 'YMF262', 'AWE32', '#1d5a2d'], ['EMU10K1', 'AC97', 'SB LIVE!', '#24426b']];
function setEra(v, fromSlider) {
  app.era = Math.max(0, Math.min(3, v));
  if (!fromSlider) $('era').value = app.era;
  post({ t: 'era', v: app.era });
  const i = Math.round(app.era), e = ERAS[i];
  $('eraCard').textContent = e.card;
  $('eraChip').textContent = `${e.chip} · ${e.year}`;
  $('eraSpec').textContent = e.spec;
  const lo = Math.floor(app.era), hi = Math.min(3, lo + 1), f = app.era - lo;
  $('eraMix').textContent = f > 0.02 && f < 0.98 ? `Crossfading ${ERAS[lo].short} ${Math.round((1 - f) * 100)}% ↔ ${ERAS[hi].short} ${Math.round(f * 100)}%` : '';
  const c = CHIPS[i];
  $('chipLabel').textContent = c[0]; $('chip2').textContent = c[1]; $('silk').textContent = c[2];
  document.querySelector('.pcb').style.background = `linear-gradient(${c[3]}, ${shade(c[3])})`;
  document.querySelectorAll('.ticks button').forEach((b, k) => b.classList.toggle('on', Math.abs(app.era - k) < 0.02));
}
const shade = (hex) => '#' + hex.slice(1).match(/../g).map(h => Math.max(0, parseInt(h, 16) - 18).toString(16).padStart(2, '0')).join('');
$('era').oninput = (e) => setEra(+e.target.value, true);
document.querySelectorAll('.ticks button').forEach(b => b.onclick = () => setEra(+b.dataset.era));

// ------------------------------------------------------------ player
class Player {
  constructor() { this.song = null; this.playing = false; this.pos = 0; this.idx = 0; this.timer = 0; }
  load(song) {
    this.stop();
    this.song = song;
    for (const r of chRows) { r.used = false; r.el.classList.add('idle'); }
    $('songTitle').textContent = song.title || 'Untitled';
    this.updateTime();
  }
  play() {
    if (!this.song || !ctx) return;
    if (ctx.state !== 'running') ctx.resume();
    if (this.pos >= this.song.duration) this.pos = 0;
    this.chase(this.pos);
    this.t0 = ctx.currentTime + 0.06 - this.pos;
    const ev = this.song.events;
    this.idx = 0;
    while (this.idx < ev.length && ev[this.idx][0] < this.pos) this.idx++;
    this.playing = true;
    $('btnPlay').innerHTML = '&#10074;&#10074;';
    this.pump();
    this.timer = setInterval(() => this.pump(), 25);
  }
  pump() {
    const ev = this.song.events, sr = ctx.sampleRate, horizon = ctx.currentTime + 0.18;
    const batch = [];
    while (this.idx < ev.length && this.t0 + ev[this.idx][0] <= horizon) {
      const e = ev[this.idx++];
      batch.push([Math.round((this.t0 + e[0]) * sr), e[1], e[2], e[3]]);
    }
    if (batch.length) post({ t: 'ev', ev: batch });
    this.pos = ctx.currentTime - this.t0;
    if (this.idx >= ev.length && this.pos >= this.song.duration) {
      if ($('chkLoop').checked) { this.halt(); this.pos = 0; this.play(); }
      else { this.halt(); this.pos = 0; }
    }
  }
  halt() {
    clearInterval(this.timer); this.timer = 0;
    if (this.playing) {
      post({ t: 'clearq' });
      for (let c = 0; c < 16; c++) { sendNow(0xB0 | c, 123, 0); sendNow(0xB0 | c, 64, 0); }
    }
    this.playing = false;
    $('btnPlay').innerHTML = '&#9654;';
  }
  pause() { if (!this.playing) return; this.pos = ctx.currentTime - this.t0; this.halt(); }
  stop() { this.halt(); this.pos = 0; this.updateTime(); }
  seek(f) {
    if (!this.song) return;
    const was = this.playing;
    this.halt();
    this.pos = f * this.song.duration;
    if (was) this.play(); else this.updateTime();
  }
  chase(pos) {
    // replay program / controller / bend state up to pos
    post({ t: 'now', ev: [[0xFF, 0, 0]] });
    const out = [];
    for (const e of this.song.events) {
      if (e[0] >= pos) break;
      const ty = e[1] & 0xF0;
      if (ty === 0xB0 || ty === 0xC0 || ty === 0xE0 || e[1] >= 0xFE) {
        if (ty === 0xB0 && (e[2] === 64 || e[2] >= 120)) continue;
        out.push([e[1], e[2], e[3]]);
      }
    }
    if (out.length) post({ t: 'now', ev: out });
  }
  updateTime() {
    const d = this.song ? this.song.duration : 0;
    const p = Math.max(0, Math.min(d, this.playing && ctx ? ctx.currentTime - this.t0 : this.pos));
    const f = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    $('songTime').textContent = `${f(p)} / ${f(d)}`;
    if (!seeking) $('seek').value = d ? Math.round(p / d * 1000) : 0;
  }
}
const player = new Player();
let seeking = false;
$('btnPlay').onclick = () => player.playing ? player.pause() : player.play();
$('btnStop').onclick = () => player.stop();
$('btnDemo').onclick = $('menuDemo').onclick = () => { player.load(demoSong()); player.play(); };
$('seek').oninput = () => { seeking = true; };
$('seek').onchange = (e) => { seeking = false; player.seek(+e.target.value / 1000); };
$('menuPanic').onclick = () => { player.halt(); post({ t: 'reset' }); };
$('menuAbout').onclick = () => { $('about').hidden = false; };
$('aboutOK').onclick = () => { $('about').hidden = true; };
$('fileMidi').onchange = async (e) => { const f = e.target.files[0]; if (f) await openMidi(f); e.target.value = ''; };
async function openMidi(file) {
  try {
    const song = parseSMF(await file.arrayBuffer());
    song.title = song.title ? `${file.name} — ${song.title}` : file.name;
    player.load(song); player.play();
  } catch (err) { setStatus('MIDI error: ' + err.message); }
}
$('vol').oninput = (e) => post({ t: 'master', v: +e.target.value });
$('chkAnalog').onchange = (e) => post({ t: 'analog', v: e.target.checked ? 1 : 0 });

// drag & drop
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', async (e) => {
  e.preventDefault(); document.body.classList.remove('dragging');
  if (!ctx) await powerOn();
  for (const f of e.dataTransfer.files) {
    const n = f.name.toLowerCase();
    if (n.endsWith('.sf2')) await loadUserSF2(f, f.name, app.era >= 2.5 ? 3 : 2);
    else if (n.endsWith('.op2')) await loadOP2(f, f.name);
    else await openMidi(f);
  }
});

// ------------------------------------------------------------ mixer
const chRows = [];
(function buildChannels() {
  const box = $('channels');
  for (let c = 0; c < 16; c++) {
    const r = document.createElement('div');
    r.className = 'chrow';
    r.innerHTML = `<span class="num">${c + 1}</span><span class="nm"></span><span class="mt"><i></i></span>`;
    let clickT = 0;
    r.onclick = () => {
      clearTimeout(clickT);
      clickT = setTimeout(() => { app.userMute[c] ^= 1; applyMute(); }, 220);
    };
    r.ondblclick = () => { clearTimeout(clickT); app.solo = app.solo === c ? -1 : c; applyMute(); };
    box.appendChild(r);
    chRows.push({ el: r, nm: r.querySelector('.nm'), bar: r.querySelector('i'), lvl: 0 });
  }
  renderNames();
})();
function applyMute() {
  for (let c = 0; c < 16; c++) {
    app.mute[c] = app.solo >= 0 ? (c !== app.solo) : app.userMute[c];
    chRows[c].el.classList.toggle('muted', !!app.mute[c]);
    chRows[c].el.classList.toggle('solo', app.solo === c);
  }
  post({ t: 'mute', v: app.mute });
}
function renderNames() {
  for (let c = 0; c < 16; c++) {
    const nm = c === 9 ? `Drum Kit ${app.programs[c] + 1}` : (app.banks[c] ? `${GM_NAMES[app.programs[c]]} (var ${app.banks[c]})` : GM_NAMES[app.programs[c]]);
    if (chRows[c].nm.textContent !== nm) chRows[c].nm.textContent = nm;
  }
}

// ------------------------------------------------------------ stats / scope
const scope = $('scope'), sctx = scope.getContext('2d');
let lastScope = null;
function onStat(d) {
  if (d.t !== 'stat') return;
  lastScope = d.scope;
  for (let c = 0; c < 16; c++) {
    const lv = Math.min(1, Math.sqrt(d.meter[c]) * 1.1);
    chRows[c].lvl = Math.max(lv, chRows[c].lvl * 0.82);
    if (lv > 0.01 && !chRows[c].used) { chRows[c].used = true; chRows[c].el.classList.remove('idle'); }
  }
  let changed = false;
  for (let c = 0; c < 16; c++) if (d.programs[c] !== app.programs[c] || d.banks[c] !== app.banks[c]) { app.programs[c] = d.programs[c]; app.banks[c] = d.banks[c]; changed = true; }
  if (changed) renderNames();
  const names = ['OPL2', 'OPL3', 'AWE32', 'Live!'], max = [9, 18, 30, 64];
  $('voices').textContent = d.voices.map((v, i) => v < 0 ? null : `${names[i]} ${String(v).padStart(2)}/${max[i]}`).filter(Boolean).join(' · ') + (d.peak >= 0.999 ? ' · CLIP' : '');
}
function frame() {
  for (const r of chRows) r.bar.style.width = (r.lvl * 100).toFixed(1) + '%';
  const w = scope.width, h = scope.height;
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, w, h);
  sctx.strokeStyle = '#0a3a0a'; sctx.beginPath(); sctx.moveTo(0, h / 2); sctx.lineTo(w, h / 2); sctx.stroke();
  if (lastScope) {
    // trigger on rising zero crossing for a stable trace
    let s0 = 0;
    for (let i = 1; i < 256; i++) if (lastScope[i - 1] < 0 && lastScope[i] >= 0) { s0 = i; break; }
    sctx.strokeStyle = '#4cff6a'; sctx.lineWidth = 1.5; sctx.beginPath();
    for (let x = 0; x < 256; x++) {
      const v = lastScope[s0 + x] || 0;
      const y = h / 2 - v * h * 0.9;
      x ? sctx.lineTo(x * 2, y) : sctx.moveTo(0, y);
    }
    sctx.stroke();
  }
  if (player.song) player.updateTime();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------ live keyboard
(function buildLiveControls() {
  const chs = $('liveCh');
  for (let c = 0; c < 16; c++) chs.add(new Option(String(c + 1) + (c === 9 ? ' (drums)' : ''), c));
  chs.onchange = () => { app.liveCh = +chs.value; $('liveProg').value = app.programs[app.liveCh]; };
  const ps = $('liveProg');
  GM_NAMES.forEach((n, i) => ps.add(new Option(`${String(i + 1).padStart(3, '0')} ${n}`, i)));
  ps.onchange = () => sendNow(0xC0 | app.liveCh, +ps.value);
})();
const held = new Map();
function liveOn(note, vel = 100) {
  if (!ctx) return;
  if (held.has(note)) return;
  held.set(note, app.liveCh);
  sendNow(0x90 | app.liveCh, note, vel);
  keyEl(note, true);
}
function liveOff(note) {
  if (!held.has(note)) return;
  sendNow(0x80 | held.get(note), note, 0);
  held.delete(note);
  keyEl(note, false);
}
const pianoKeys = new Map();
const WIDE = window.innerWidth > 760;
const PIANO_LO = WIDE ? 36 : 48, PIANO_HI = WIDE ? 95 : 83;
(function buildPiano() {
  const p = $('piano');
  const whites = [];
  for (let n = PIANO_LO; n <= PIANO_HI; n++) if (![1, 3, 6, 8, 10].includes(n % 12)) whites.push(n);
  whites.forEach(n => { const d = document.createElement('div'); d.className = 'w'; d.dataset.n = n; p.appendChild(d); pianoKeys.set(n, d); });
  const ww = 100 / whites.length;
  for (let n = PIANO_LO; n <= PIANO_HI; n++) if ([1, 3, 6, 8, 10].includes(n % 12)) {
    const wi = whites.indexOf(n - 1);
    const d = document.createElement('div'); d.className = 'b'; d.dataset.n = n;
    d.style.left = `calc(${(wi + 1) * ww}% - ${ww * 0.3}%)`; d.style.width = `${ww * 0.6}%`;
    p.appendChild(d); pianoKeys.set(n, d);
  }
  const ptr = new Map();
  const noteAt = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); return el && el.dataset && el.dataset.n ? +el.dataset.n : null; };
  p.addEventListener('pointerdown', (e) => { const n = noteAt(e); if (n == null) return; p.setPointerCapture(e.pointerId); ptr.set(e.pointerId, n); liveOn(n, 70 + Math.round(Math.random() * 30)); });
  p.addEventListener('pointermove', (e) => {
    if (!ptr.has(e.pointerId)) return;
    const n = noteAt(e), o = ptr.get(e.pointerId);
    if (n != null && n !== o) { liveOff(o); liveOn(n, 90); ptr.set(e.pointerId, n); }
  });
  const up = (e) => { if (!ptr.has(e.pointerId)) return; liveOff(ptr.get(e.pointerId)); ptr.delete(e.pointerId); };
  p.addEventListener('pointerup', up); p.addEventListener('pointercancel', up);
})();
function keyEl(n, down) { const el = pianoKeys.get(n); if (el) el.classList.toggle('down', down); }
const QW = 'awsedftgyhujkolp;';
window.addEventListener('keydown', (e) => {
  if (!ctx || e.repeat || e.metaKey || e.ctrlKey || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  const k = e.key.toLowerCase();
  if (k === 'z') { app.octave = Math.max(1, app.octave - 1); $('octLabel').textContent = 'Oct ' + app.octave; return; }
  if (k === 'x') { app.octave = Math.min(7, app.octave + 1); $('octLabel').textContent = 'Oct ' + app.octave; return; }
  if (k === ' ') { e.preventDefault(); $('btnPlay').click(); return; }
  const i = QW.indexOf(k);
  if (i >= 0) liveOn(12 * (app.octave + 1) + i, 100);
});
window.addEventListener('keyup', (e) => {
  const i = QW.indexOf(e.key.toLowerCase());
  if (i < 0) return;
  for (let o = 1; o <= 7; o++) liveOff(12 * (o + 1) + i);
});

// ------------------------------------------------------------ Web MIDI input
let midiAccess = null;
$('midiIn').addEventListener('pointerdown', async () => {
  if (midiAccess || !navigator.requestMIDIAccess) {
    if (!navigator.requestMIDIAccess) setStatus('Web MIDI is not available in this browser.');
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess();
    const refresh = () => {
      const sel = $('midiIn'), cur = sel.value;
      sel.innerHTML = '<option value="">(none)</option>';
      for (const inp of midiAccess.inputs.values()) sel.add(new Option(inp.name, inp.id));
      sel.value = cur;
    };
    refresh(); midiAccess.onstatechange = refresh;
  } catch { setStatus('MIDI access was refused.'); }
});
$('midiIn').onchange = (e) => {
  if (!midiAccess) return;
  for (const inp of midiAccess.inputs.values()) inp.onmidimessage = null;
  const inp = midiAccess.inputs.get(e.target.value);
  if (inp) inp.onmidimessage = (m) => {
    const [st, d1 = 0, d2 = 0] = m.data;
    if (st >= 0xF0) return;
    // route the keyboard's channel 1 to the selected live channel
    const s = (st & 0xF0) | ((st & 15) === 0 ? app.liveCh : (st & 15));
    post({ t: 'now', ev: [[s, d1, d2]] });
    if ((st & 0xF0) === 0x90 && d2) keyEl(d1, true); else if ((st & 0xF0) === 0x80 || (st & 0xF0) === 0x90) keyEl(d1, false);
  };
};

setEra(1);
