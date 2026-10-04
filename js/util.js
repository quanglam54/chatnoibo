/* Tiện ích dùng chung */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const Util = {
  escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  linkify(text) {
    return Util.escapeHtml(text).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  },

  isEmojiOnly(text) {
    const t = (text || '').trim();
    if (!t || t.length > 12) {
      return false;
    }
    return /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t) && !/^[\d#*\s]+$/.test(t);
  },

  uuid() {
    if (crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  },

  initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) {
      return '?';
    }
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    return (parts[parts.length - 2][0] + parts[parts.length - 1][0]).toUpperCase();
  },

  pad(n) {
    return String(n).padStart(2, '0');
  },

  formatClock(date) {
    const d = new Date(date);
    return `${Util.pad(d.getHours())}:${Util.pad(d.getMinutes())}`;
  },

  isSameDay(a, b) {
    const x = new Date(a);
    const y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  },

  formatDay(date) {
    const d = new Date(date);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (Util.isSameDay(d, now)) {
      return 'Hôm nay';
    }
    if (Util.isSameDay(d, yesterday)) {
      return 'Hôm qua';
    }
    return `${Util.pad(d.getDate())}/${Util.pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  },

  /** Thời gian ngắn cho danh sách chat: 14:05 / T2 / 03/10 */
  formatShort(date) {
    if (!date) {
      return '';
    }
    const d = new Date(date);
    const now = new Date();
    if (Util.isSameDay(d, now)) {
      return Util.formatClock(d);
    }
    const diffDays = (now - d) / 86400000;
    if (diffDays < 7) {
      return ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][d.getDay()];
    }
    return `${Util.pad(d.getDate())}/${Util.pad(d.getMonth() + 1)}`;
  },

  formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${Util.pad(m)}:${Util.pad(sec)}` : `${Util.pad(m)}:${Util.pad(sec)}`;
  },

  formatSize(bytes) {
    if (!bytes && bytes !== 0) {
      return '';
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  },

  avatarHtml(profile, size = '', online = false) {
    const name = profile?.display_name || '?';
    const color = profile?.color || '#8a8d91';
    const cls = ['avatar', size, online ? 'online' : ''].filter(Boolean).join(' ');
    return `<span class="${cls}" style="background:${Util.escapeHtml(color)}" title="${Util.escapeHtml(name)}">${Util.escapeHtml(Util.initials(name))}</span>`;
  },

  toast(message, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 5000 : 3000);
  },

  debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  },

  /** Thông báo hệ thống khi tab đang ẩn */
  notify(title, body, onClick) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) {
      return null;
    }
    try {
      const n = new Notification(title, { body, icon: $('link[rel=icon]').href, tag: title });
      n.onclick = () => {
        window.focus();
        onClick && onClick();
        n.close();
      };
      return n;
    } catch (e) {
      return null;
    }
  },

  requestNotifyPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  },
};

/** Âm thanh tạo bằng WebAudio (không cần file mp3) */
const Sound = {
  ctx: null,
  loopTimer: null,

  audioContext() {
    if (!Sound.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        return null;
      }
      Sound.ctx = new Ctx();
    }
    if (Sound.ctx.state === 'suspended') {
      Sound.ctx.resume().catch(() => {});
    }
    return Sound.ctx;
  },

  tone(freqs, duration, volume = 0.15, startAt = 0) {
    const ctx = Sound.audioContext();
    if (!ctx) {
      return;
    }
    const t0 = ctx.currentTime + startAt;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume, t0 + 0.02);
    gain.gain.setValueAtTime(volume, t0 + duration - 0.05);
    gain.gain.linearRampToValueAtTime(0, t0 + duration);
    gain.connect(ctx.destination);
    freqs.forEach((f) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start(t0);
      osc.stop(t0 + duration);
    });
  },

  message() {
    Sound.tone([880], 0.09, 0.08);
    Sound.tone([1320], 0.12, 0.08, 0.1);
  },

  /** Chuông cuộc gọi đến */
  startRingtone() {
    Sound.stopLoop();
    const play = () => {
      [0, 0.25, 0.5].forEach((t, i) => Sound.tone([i % 2 ? 784 : 659, i % 2 ? 988 : 830], 0.22, 0.18, t));
    };
    play();
    Sound.loopTimer = setInterval(play, 2000);
  },

  /** Tút tút khi đang chờ người kia nghe */
  startRingback() {
    Sound.stopLoop();
    const play = () => Sound.tone([440, 480], 1.2, 0.07);
    play();
    Sound.loopTimer = setInterval(play, 3500);
  },

  stopLoop() {
    clearInterval(Sound.loopTimer);
    Sound.loopTimer = null;
  },

  hangup() {
    Sound.tone([480, 620], 0.25, 0.1);
    Sound.tone([480, 620], 0.25, 0.1, 0.35);
  },
};
