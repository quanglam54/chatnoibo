/* Chat Nội Bộ — phần nhắn tin */
const PAGE_SIZE = 50;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const BUCKET = 'chat-files';

const App = {
  sb: null,
  me: null,
  profiles: new Map(),
  convs: new Map(),
  activeId: null,
  messages: new Map(), // convId -> { list: [], hasMore: bool }
  members: new Map(), // convId -> Map(userId -> last_read_at)
  online: new Set(),
  typing: new Map(), // convId -> Map(userId -> timeoutId)
  lobby: null,
  lobbyReady: false,
  signalQueue: [],
  dbChannel: null,
  dbSubscribedOnce: false,
  urlCache: new Map(),
  lastTypingSent: 0,
  hiddenAt: 0,
  tabId: Util.uuid(),

  /* ================= Khởi động ================= */
  async init() {
    const cfg = window.APP_CONFIG || {};
    document.title = cfg.APP_NAME || 'Chat Nội Bộ';
    $$('.app-name').forEach((el) => (el.textContent = document.title));

    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase) {
      $('#setup-screen').classList.remove('hidden');
      return;
    }

    App.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      realtime: { params: { eventsPerSecond: 30 } },
    });
    App.bindAuthForm();

    const { data } = await App.sb.auth.getSession();
    if (data.session) {
      await App.start(data.session.user);
    } else {
      $('#auth-screen').classList.remove('hidden');
    }

    App.sb.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        location.reload();
      }
    });
  },

  bindAuthForm() {
    const form = $('#auth-form');
    $$('.tab', form).forEach((tab) => {
      tab.onclick = () => {
        $$('.tab', form).forEach((t) => t.classList.toggle('active', t === tab));
        const isSignup = tab.dataset.mode === 'signup';
        form.classList.toggle('signup', isSignup);
        $('#auth-submit').textContent = isSignup ? 'Tạo tài khoản' : 'Đăng nhập';
        form.password.autocomplete = isSignup ? 'new-password' : 'current-password';
        $('#auth-error').textContent = '';
      };
    });

    form.onsubmit = async (e) => {
      e.preventDefault();
      const isSignup = form.classList.contains('signup');
      const email = form.email.value.trim();
      const password = form.password.value;
      const btn = $('#auth-submit');
      $('#auth-error').textContent = '';
      btn.disabled = true;
      Util.requestNotifyPermission();
      Sound.audioContext();

      try {
        if (isSignup) {
          const displayName = form.display_name.value.trim();
          if (!displayName) {
            throw new Error('Vui lòng nhập tên hiển thị');
          }
          const { data, error } = await App.sb.auth.signUp({
            email,
            password,
            options: { data: { display_name: displayName, invite_code: form.invite_code.value.trim() } },
          });
          if (error) {
            throw error;
          }
          if (!data.session) {
            $('#auth-error').textContent = 'Đã tạo tài khoản. Hãy mở email để xác nhận rồi đăng nhập.';
            return;
          }
          await App.start(data.session.user);
        } else {
          const { data, error } = await App.sb.auth.signInWithPassword({ email, password });
          if (error) {
            throw error;
          }
          await App.start(data.user);
        }
      } catch (err) {
        $('#auth-error').textContent = App.authErrorText(err);
      } finally {
        btn.disabled = false;
      }
    };
  },

  authErrorText(err) {
    const msg = err?.message || String(err);
    if (/Invalid login credentials/i.test(msg)) {
      return 'Sai email hoặc mật khẩu';
    }
    if (/already registered/i.test(msg)) {
      return 'Email này đã được đăng ký';
    }
    if (/Database error saving new user/i.test(msg)) {
      return 'Mã mời không đúng';
    }
    if (/Email not confirmed/i.test(msg)) {
      return 'Email chưa được xác nhận';
    }
    if (/Password should be/i.test(msg)) {
      return 'Mật khẩu tối thiểu 6 ký tự';
    }
    if (/rate limit/i.test(msg)) {
      return 'Thao tác quá nhanh, thử lại sau ít phút';
    }
    return msg;
  },

  async start(user) {
    App.me = user.id;
    $('#auth-screen').classList.add('hidden');
    $('#app').classList.remove('hidden');

    await App.loadProfiles();
    if (!App.profiles.has(App.me)) {
      Util.toast('Không tìm thấy hồ sơ — đã chạy supabase-setup.sql chưa?', 'error');
    }
    App.renderMe();
    App.bindUi();
    await App.loadConversations();
    App.subscribeDb();
    App.joinLobby();
    Call.init();

    // Mở lại đoạn chat gần nhất trên máy tính
    const lastId = localStorage.getItem('lastConv');
    if (lastId && App.convs.has(lastId) && window.innerWidth > 760) {
      App.openConversation(lastId);
    }
  },

  /* ================= Dữ liệu ================= */
  async loadProfiles() {
    const { data, error } = await App.sb.from('profiles').select('*').order('display_name');
    if (error) {
      Util.toast(`Lỗi tải danh bạ: ${error.message}`, 'error');
      return;
    }
    App.profiles = new Map(data.map((p) => [p.id, p]));
  },

  profile(id) {
    return App.profiles.get(id) || { id, display_name: 'Người dùng', color: '#8a8d91' };
  },

  async loadConversations() {
    const { data, error } = await App.sb.rpc('my_conversations');
    if (error) {
      Util.toast(`Lỗi tải đoạn chat: ${error.message}`, 'error');
      return;
    }
    const unknown = new Set();
    App.convs = new Map(
      data.map((c) => {
        (c.member_ids || []).forEach((id) => !App.profiles.has(id) && unknown.add(id));
        return [c.id, { ...c, member_ids: c.member_ids || [] }];
      }),
    );
    if (unknown.size) {
      await App.loadProfiles();
    }
    App.renderConvList();
    App.updateTitle();
    if (App.activeId) {
      if (App.convs.has(App.activeId)) {
        App.renderChatHeader();
      } else {
        App.closeConversation();
      }
    }
  },

  async resync() {
    await App.loadConversations();
    if (App.activeId) {
      App.messages.delete(App.activeId);
      await App.loadMessages(App.activeId);
      await App.loadMembers(App.activeId);
      App.renderMessages({ toBottom: true });
    }
  },

  convTitle(conv) {
    if (!conv) {
      return '';
    }
    if (conv.name) {
      return conv.name;
    }
    const others = conv.member_ids.filter((id) => id !== App.me);
    if (!conv.is_group) {
      return App.profile(others[0]).display_name;
    }
    const names = others.slice(0, 3).map((id) => App.profile(id).display_name.split(' ').pop());
    return names.join(', ') + (others.length > 3 ? ` và ${others.length - 3} người khác` : '') || 'Nhóm';
  },

  otherMember(conv) {
    return conv.member_ids.find((id) => id !== App.me);
  },

  convAvatarHtml(conv, size = '') {
    if (!conv.is_group) {
      const other = App.otherMember(conv);
      return Util.avatarHtml(App.profile(other), size, App.online.has(other));
    }
    const others = conv.member_ids.filter((id) => id !== App.me).slice(0, 2);
    while (others.length < 2) {
      others.push(App.me);
    }
    return `<span class="avatar-group ${size}">${others.map((id) => Util.avatarHtml(App.profile(id))).join('')}</span>`;
  },

  previewText(conv) {
    if (!conv.last_kind) {
      return conv.is_group ? 'Nhóm mới được tạo' : 'Hãy gửi lời chào 👋';
    }
    const mine = conv.last_sender_id === App.me;
    const who = mine ? 'Bạn: ' : conv.is_group ? `${App.profile(conv.last_sender_id).display_name.split(' ').pop()}: ` : '';
    switch (conv.last_kind) {
      case 'file':
        return `${who}📎 ${conv.last_file_name || 'Tệp đính kèm'}`;
      case 'call':
        return `📞 ${App.callLabel(conv.last_body)}`;
      case 'system':
        return conv.last_body || '';
      default:
        return who + (conv.last_body || '');
    }
  },

  /** Nội dung tin nhắn cuộc gọi: { video, caller, status: 'ended'|'missed', duration (ms) } */
  callInfo(m) {
    try {
      return JSON.parse(m.body) || {};
    } catch (e) {
      return {};
    }
  },

  /** Tin nhắn cuộc gọi hiển thị về phía người gọi (người ghi lại có thể là người rời cuối) */
  msgOwner(m) {
    return (m.kind === 'call' && App.callInfo(m).caller) || m.sender_id;
  },

  callLabel(body) {
    const call = App.callInfo({ body });
    if (call.status === 'missed') {
      return call.caller === App.me ? 'Cuộc gọi đi không ai trả lời' : 'Cuộc gọi nhỡ';
    }
    const label = call.video ? 'Cuộc gọi video' : 'Cuộc gọi thoại';
    return call.duration ? `${label} · ${Util.formatCallDuration(call.duration)}` : label;
  },

  /* ================= Realtime ================= */
  subscribeDb() {
    App.dbChannel = App.sb
      .channel('db-changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => App.onMessageInsert(p.new))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversation_members' }, (p) => App.onMemberInsert(p.new))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_members' }, (p) => App.onMemberUpdate(p.new))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'conversation_members' }, (p) => App.onMemberDelete(p.old))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, (p) => App.onConversationUpdate(p.new))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          if (App.dbSubscribedOnce) {
            App.resync();
          }
          App.dbSubscribedOnce = true;
        }
      });
  },

  /** Kênh chung: presence (ai đang online) + broadcast (đang soạn tin, tín hiệu gọi) */
  joinLobby() {
    App.lobby = App.sb.channel('lobby', {
      config: { presence: { key: App.me }, broadcast: { self: false, ack: false } },
    });
    App.lobby
      .on('presence', { event: 'sync' }, () => {
        App.online = new Set(Object.keys(App.lobby.presenceState()));
        App.renderConvList();
        if (App.activeId) {
          App.renderChatHeader();
        }
      })
      .on('broadcast', { event: 'sig' }, ({ payload }) => App.onSignal(payload))
      .subscribe(async (status) => {
        App.lobbyReady = status === 'SUBSCRIBED';
        if (App.lobbyReady) {
          await App.lobby.track({ user_id: App.me, at: Date.now() });
          const queued = App.signalQueue.splice(0);
          queued.forEach((p) => App.signal(p));
        }
      });
  },

  /** Gửi tín hiệu tới các user trong `to` (mảng id) */
  signal(payload) {
    const msg = { ...payload, from: App.me, fromTab: App.tabId };
    if (!App.lobbyReady) {
      App.signalQueue.push(payload);
      return;
    }
    App.lobby.send({ type: 'broadcast', event: 'sig', payload: msg });
  },

  onSignal(p) {
    if (!p || p.fromTab === App.tabId) {
      return;
    }
    if (Array.isArray(p.to) && !p.to.includes(App.me)) {
      return;
    }
    if (p.from === App.me) {
      Call.onSelfSignal(p);
      return;
    }
    if (p.type === 'typing') {
      App.onTyping(p);
      return;
    }
    Call.onSignal(p);
  },

  async onMessageInsert(msg) {
    let conv = App.convs.get(msg.conversation_id);
    if (!conv) {
      await App.loadConversations();
      conv = App.convs.get(msg.conversation_id);
      if (!conv) {
        return;
      }
    }

    const store = App.messages.get(msg.conversation_id);
    if (store) {
      const idx = store.list.findIndex((m) => m.id === msg.id);
      if (idx >= 0) {
        store.list[idx] = msg;
      } else {
        store.list.push(msg);
      }
      store.list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }

    App.applyLastMessage(conv, msg);
    App.clearTyping(msg.conversation_id, msg.sender_id);

    const isActiveVisible = App.activeId === msg.conversation_id && !document.hidden;
    if (msg.sender_id !== App.me && msg.kind !== 'system') {
      if (isActiveVisible) {
        App.markReadSoon(msg.conversation_id);
      } else {
        conv.unread = (conv.unread || 0) + 1;
        if (msg.kind !== 'call') {
          Sound.message();
          Util.notify(App.convTitle(conv), App.notifyBody(conv, msg), () => App.openConversation(conv.id));
        }
      }
    }

    App.renderConvList();
    App.updateTitle();
    if (App.activeId === msg.conversation_id) {
      App.renderMessages();
    }
  },

  notifyBody(conv, msg) {
    const who = conv.is_group ? `${App.profile(msg.sender_id).display_name}: ` : '';
    if (msg.kind === 'file') {
      return `${who}📎 ${msg.file_name}`;
    }
    return who + (msg.body || '');
  },

  applyLastMessage(conv, msg) {
    if (conv.last_message_at && new Date(msg.created_at) < new Date(conv.last_message_at) && conv.last_kind) {
      return;
    }
    conv.last_message_at = msg.created_at;
    conv.last_body = msg.body;
    conv.last_kind = msg.kind;
    conv.last_sender_id = msg.sender_id;
    conv.last_file_name = msg.file_name;
  },

  async onMemberInsert(row) {
    const conv = App.convs.get(row.conversation_id);
    if (row.user_id === App.me || !conv) {
      await App.loadConversations();
      return;
    }
    if (!conv.member_ids.includes(row.user_id)) {
      conv.member_ids.push(row.user_id);
    }
    if (!App.profiles.has(row.user_id)) {
      await App.loadProfiles();
    }
    App.members.get(row.conversation_id)?.set(row.user_id, row.last_read_at);
    App.renderConvList();
    if (App.activeId === row.conversation_id) {
      App.renderChatHeader();
    }
  },

  onMemberUpdate(row) {
    const map = App.members.get(row.conversation_id);
    if (map) {
      map.set(row.user_id, row.last_read_at);
    }
    if (row.user_id === App.me) {
      const conv = App.convs.get(row.conversation_id);
      if (conv) {
        conv.my_last_read_at = row.last_read_at;
      }
    }
    if (App.activeId === row.conversation_id) {
      App.renderSeen();
    }
  },

  onMemberDelete(old) {
    if (!old?.conversation_id) {
      return;
    }
    if (old.user_id === App.me) {
      App.loadConversations();
      return;
    }
    const conv = App.convs.get(old.conversation_id);
    if (conv) {
      conv.member_ids = conv.member_ids.filter((id) => id !== old.user_id);
      App.members.get(old.conversation_id)?.delete(old.user_id);
      App.renderConvList();
      if (App.activeId === old.conversation_id) {
        App.renderChatHeader();
      }
    }
  },

  onConversationUpdate(row) {
    const conv = App.convs.get(row.id);
    if (!conv) {
      return;
    }
    conv.name = row.name;
    App.renderConvList();
    if (App.activeId === row.id) {
      App.renderChatHeader();
    }
  },

  /* ================= Đang soạn tin ================= */
  sendTyping() {
    const conv = App.convs.get(App.activeId);
    if (!conv || Date.now() - App.lastTypingSent < 2500) {
      return;
    }
    App.lastTypingSent = Date.now();
    App.signal({ type: 'typing', convId: conv.id, to: conv.member_ids.filter((id) => id !== App.me) });
  },

  onTyping(p) {
    if (!App.convs.has(p.convId)) {
      return;
    }
    if (!App.typing.has(p.convId)) {
      App.typing.set(p.convId, new Map());
    }
    const map = App.typing.get(p.convId);
    clearTimeout(map.get(p.from));
    map.set(p.from, setTimeout(() => App.clearTyping(p.convId, p.from), 4000));
    App.renderTyping();
  },

  clearTyping(convId, userId) {
    const map = App.typing.get(convId);
    if (map && map.has(userId)) {
      clearTimeout(map.get(userId));
      map.delete(userId);
      App.renderTyping();
    }
  },

  renderTyping() {
    const map = App.typing.get(App.activeId);
    const ids = map ? Array.from(map.keys()) : [];
    $('#typing').classList.toggle('hidden', !ids.length);
    if (ids.length) {
      const conv = App.convs.get(App.activeId);
      $('#typing-text').textContent = conv?.is_group
        ? `${ids.map((id) => App.profile(id).display_name.split(' ').pop()).join(', ')} đang soạn tin...`
        : '';
    }
  },

  /* ================= Giao diện chính ================= */
  bindUi() {
    $('#new-chat-btn').onclick = () => App.openNewChatModal(false);
    $('#new-group-btn').onclick = () => App.openNewChatModal(true);
    $('#me-btn').onclick = () => App.openProfileModal();
    $('#conv-search').oninput = Util.debounce(() => App.renderConvList(), 120);
    $('#back-btn').onclick = () => history.state?.chat ? history.back() : App.closeConversation();
    $('#info-btn').onclick = () => App.openInfoModal();
    $('#chat-title-btn').onclick = () => App.openInfoModal();
    $('#audio-call-btn').onclick = () => Call.start(App.activeId, false);
    $('#video-call-btn').onclick = () => Call.start(App.activeId, true);
    $('#join-audio-btn').onclick = () => App.joinBannerCall(false);
    $('#join-video-btn').onclick = () => App.joinBannerCall(true);
    $('#modal-close').onclick = () => App.closeModal();
    $('#modal').onclick = (e) => e.target.id === 'modal' && App.closeModal();
    $('#lightbox').onclick = () => $('#lightbox').classList.add('hidden');

    const input = $('#msg-input');
    $('#composer').onsubmit = (e) => {
      e.preventDefault();
      App.sendText();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.innerWidth > 760) {
        e.preventDefault();
        App.sendText();
      }
    };
    input.oninput = () => {
      App.autoGrow();
      if (input.value.trim()) {
        App.sendTyping();
      }
    };
    input.onpaste = (e) => {
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length) {
        e.preventDefault();
        App.sendFiles(files);
      }
    };
    $('#attach-btn').onclick = () => $('#file-input').click();
    $('#file-input').onchange = (e) => {
      App.sendFiles(Array.from(e.target.files));
      e.target.value = '';
    };

    // Kéo thả file
    const pane = $('#chat-pane');
    let dragDepth = 0;
    pane.addEventListener('dragenter', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        dragDepth++;
        $('#drop-overlay').classList.remove('hidden');
      }
    });
    pane.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) {
        $('#drop-overlay').classList.add('hidden');
      }
    });
    pane.addEventListener('dragover', (e) => e.preventDefault());
    pane.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      $('#drop-overlay').classList.add('hidden');
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) {
        App.sendFiles(files);
      }
    });

    // Cuộn lên đầu để tải tin cũ
    $('#messages').addEventListener('scroll', (e) => {
      if (e.target.scrollTop < 60) {
        App.loadOlder();
      }
    });

    // Click trong danh sách tin nhắn (ảnh, file)
    $('#messages').addEventListener('click', (e) => {
      const img = e.target.closest('img.msg-img');
      if (img?.src) {
        $('#lightbox img').src = img.src;
        $('#lightbox').classList.remove('hidden');
        return;
      }
      const dl = e.target.closest('[data-download]');
      if (dl) {
        e.preventDefault();
        App.downloadFile(dl.dataset.download, dl.dataset.name);
        return;
      }
      if (e.target.closest('.load-more')) {
        App.loadOlder(true);
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        App.hiddenAt = Date.now();
        return;
      }
      if (App.activeId) {
        App.markReadSoon(App.activeId);
      }
      if (App.hiddenAt && Date.now() - App.hiddenAt > 60000) {
        App.resync();
      }
    });
    document.addEventListener('click', () => Sound.audioContext(), { once: true });

    window.addEventListener('popstate', () => {
      if (!history.state?.chat && App.activeId && window.innerWidth <= 760) {
        App.closeConversation();
      }
    });
  },

  renderMe() {
    $('#me-btn').innerHTML = Util.avatarHtml(App.profile(App.me));
  },

  renderConvList() {
    const q = $('#conv-search').value.trim().toLowerCase();
    const list = $('#conv-list');
    const convs = Array.from(App.convs.values()).sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
    const matches = (s) => App.normalize(s).includes(App.normalize(q));

    let html = '';
    const shown = q ? convs.filter((c) => matches(App.convTitle(c))) : convs;
    html += shown.map((c) => App.convItemHtml(c)).join('');

    if (q) {
      const dmWith = new Set(convs.filter((c) => !c.is_group).map((c) => App.otherMember(c)));
      const people = Array.from(App.profiles.values()).filter(
        (p) => p.id !== App.me && !dmWith.has(p.id) && (matches(p.display_name) || matches(p.email || '')),
      );
      if (people.length) {
        html += '<div class="section-label">Mọi người</div>';
        html += people
          .map(
            (p) => `<button class="conv-item" data-user="${p.id}">${Util.avatarHtml(p, '', App.online.has(p.id))}
              <div class="meta"><div class="name">${Util.escapeHtml(p.display_name)}</div>
              <div class="preview"><span>${Util.escapeHtml(p.email || '')}</span></div></div></button>`,
          )
          .join('');
      }
    }
    if (!html) {
      html = `<div class="empty-note">${q ? 'Không tìm thấy kết quả' : 'Chưa có đoạn chat nào.<br>Bấm ✏️ để nhắn tin cho đồng nghiệp.'}</div>`;
    }
    list.innerHTML = html;

    $$('.conv-item[data-conv]', list).forEach((el) => (el.onclick = () => App.openConversation(el.dataset.conv)));
    $$('.conv-item[data-user]', list).forEach((el) => (el.onclick = () => App.openDirect(el.dataset.user)));
  },

  convItemHtml(c) {
    const unread = c.unread > 0 && c.id !== App.activeId;
    const calling = Call.activeCallFor(c.id) ? ' · 📞 đang gọi' : '';
    return `<button class="conv-item ${c.id === App.activeId ? 'active' : ''} ${unread ? 'unread' : ''}" data-conv="${c.id}">
      ${App.convAvatarHtml(c)}
      <div class="meta">
        <div class="name">${Util.escapeHtml(App.convTitle(c))}</div>
        <div class="preview"><span>${Util.escapeHtml(App.previewText(c))}</span><span>· ${Util.formatShort(c.last_message_at)}${calling}</span></div>
      </div>
      ${unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
    </button>`;
  },

  normalize(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd');
  },

  updateTitle() {
    const total = Array.from(App.convs.values()).filter((c) => c.unread > 0 && c.id !== App.activeId).length;
    const base = window.APP_CONFIG?.APP_NAME || 'Chat Nội Bộ';
    document.title = total ? `(${total}) ${base}` : base;
  },

  /* ================= Mở đoạn chat ================= */
  async openConversation(id) {
    const conv = App.convs.get(id);
    if (!conv) {
      return;
    }
    const wasOpen = !!App.activeId;
    App.activeId = id;
    localStorage.setItem('lastConv', id);
    conv.unread = 0;
    $('#app').classList.add('chat-open');
    if (window.innerWidth <= 760 && !wasOpen) {
      history.pushState({ chat: true }, '');
    }
    $('#chat-empty').classList.add('hidden');
    $('#chat-pane').classList.remove('hidden');
    $('#msg-input').value = '';
    App.autoGrow();
    App.renderChatHeader();
    App.renderConvList();
    App.updateTitle();
    App.renderTyping();

    if (!App.messages.has(id)) {
      $('#messages').innerHTML = '<div class="empty-note">Đang tải...</div>';
      await App.loadMessages(id);
    }
    if (!App.members.has(id)) {
      await App.loadMembers(id);
    }
    if (App.activeId !== id) {
      return;
    }
    App.renderMessages({ toBottom: true });
    App.markReadSoon(id);
    if (window.innerWidth > 760) {
      $('#msg-input').focus();
    }
  },

  closeConversation() {
    App.activeId = null;
    $('#app').classList.remove('chat-open');
    $('#chat-pane').classList.add('hidden');
    $('#chat-empty').classList.remove('hidden');
    App.renderConvList();
  },

  async openDirect(userId) {
    const { data, error } = await App.sb.rpc('create_conversation', { p_member_ids: [userId], p_name: null, p_is_group: false });
    if (error) {
      Util.toast(`Không mở được đoạn chat: ${error.message}`, 'error');
      return;
    }
    $('#conv-search').value = '';
    if (!App.convs.has(data)) {
      await App.loadConversations();
    }
    App.closeModal();
    App.openConversation(data);
  },

  renderChatHeader() {
    const conv = App.convs.get(App.activeId);
    if (!conv) {
      return;
    }
    $('#chat-avatar').innerHTML = App.convAvatarHtml(conv);
    $('#chat-name').textContent = App.convTitle(conv);
    let status;
    if (conv.is_group) {
      const onlineCount = conv.member_ids.filter((id) => id !== App.me && App.online.has(id)).length;
      status = `${conv.member_ids.length} thành viên${onlineCount ? ` · ${onlineCount} đang hoạt động` : ''}`;
    } else {
      status = App.online.has(App.otherMember(conv)) ? 'Đang hoạt động' : 'Không hoạt động';
    }
    $('#chat-status').textContent = status;
    const inCall = !!Call.state;
    $('#audio-call-btn').disabled = inCall;
    $('#video-call-btn').disabled = inCall;
    App.renderCallBanner();
  },

  renderCallBanner() {
    const banner = $('#call-banner');
    const active = App.activeId && Call.activeCallFor(App.activeId);
    if (!active || !active.isGroup || Call.state || active.participants.has(App.me)) {
      banner.classList.add('hidden');
      return;
    }
    const names = Array.from(active.participants)
      .map((id) => App.profile(id).display_name.split(' ').pop())
      .join(', ');
    $('#call-banner-text').textContent = `${active.video ? 'Cuộc gọi video' : 'Cuộc gọi'} đang diễn ra · ${names}`;
    banner.classList.remove('hidden');
  },

  joinBannerCall(video) {
    const active = Call.activeCallFor(App.activeId);
    if (active) {
      Call.joinExisting(active, video);
    }
  },

  async loadMembers(convId) {
    const { data, error } = await App.sb.from('conversation_members').select('user_id,last_read_at').eq('conversation_id', convId);
    if (!error) {
      App.members.set(convId, new Map(data.map((r) => [r.user_id, r.last_read_at])));
    }
  },

  async loadMessages(convId, before = null) {
    let query = App.sb
      .from('messages')
      .select('*')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);
    if (before) {
      query = query.lt('created_at', before);
    }
    const { data, error } = await query;
    if (error) {
      Util.toast(`Lỗi tải tin nhắn: ${error.message}`, 'error');
      return false;
    }
    const rows = data.reverse();
    const store = App.messages.get(convId) || { list: [], hasMore: true };
    if (before) {
      const ids = new Set(store.list.map((m) => m.id));
      store.list = rows.filter((m) => !ids.has(m.id)).concat(store.list);
    } else {
      store.list = rows;
    }
    store.hasMore = data.length === PAGE_SIZE;
    App.messages.set(convId, store);
    return true;
  },

  async loadOlder(force = false) {
    const convId = App.activeId;
    const store = App.messages.get(convId);
    if (!store || !store.hasMore || App.loadingOlder || !store.list.length) {
      return;
    }
    if (!force && $('#messages').scrollTop >= 60) {
      return;
    }
    App.loadingOlder = true;
    const box = $('#messages');
    const fromBottom = box.scrollHeight - box.scrollTop;
    await App.loadMessages(convId, store.list[0].created_at);
    App.loadingOlder = false;
    if (App.activeId === convId) {
      App.renderMessages();
      box.scrollTop = box.scrollHeight - fromBottom;
    }
  },

  /* ================= Hiển thị tin nhắn ================= */
  renderMessages({ toBottom = false } = {}) {
    const box = $('#messages');
    const conv = App.convs.get(App.activeId);
    const store = App.messages.get(App.activeId);
    if (!conv || !store) {
      return;
    }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const list = store.list;
    const parts = [];

    if (store.hasMore) {
      parts.push('<button class="load-more">Xem tin nhắn cũ hơn</button>');
    } else {
      parts.push(`<div class="info-head">${App.convAvatarHtml(conv, 'lg')}<div class="name">${Util.escapeHtml(App.convTitle(conv))}</div>
        <div class="system-msg">${conv.is_group ? 'Nhóm chat nội bộ' : 'Các bạn đã được kết nối trên Chat Nội Bộ'}</div></div>`);
    }
    if (!list.length) {
      parts.push('<div class="empty-note">Chưa có tin nhắn. Hãy gửi lời chào 👋</div>');
    }

    const groupable = (a, b) =>
      a && b && a.kind !== 'system' && b.kind !== 'system' && App.msgOwner(a) === App.msgOwner(b) &&
      new Date(b.created_at) - new Date(a.created_at) < 5 * 60000;

    let lastMineIdx = -1;
    list.forEach((m, i) => {
      if (App.msgOwner(m) === App.me && m.kind !== 'system') {
        lastMineIdx = i;
      }
    });

    list.forEach((m, i) => {
      const prev = list[i - 1];
      const next = list[i + 1];
      if (!prev || !Util.isSameDay(prev.created_at, m.created_at) || new Date(m.created_at) - new Date(prev.created_at) > 30 * 60000) {
        const day = Util.formatDay(m.created_at);
        parts.push(`<div class="day-sep">${day === 'Hôm nay' ? '' : day + ' '}${Util.formatClock(m.created_at)}</div>`);
      }
      if (m.kind === 'system') {
        parts.push(`<div class="system-msg">${Util.escapeHtml(m.body)}</div>`);
        return;
      }
      const sepBefore = !prev || !Util.isSameDay(prev.created_at, m.created_at) || new Date(m.created_at) - new Date(prev.created_at) > 30 * 60000;
      const sepAfter = next && (!Util.isSameDay(m.created_at, next.created_at) || new Date(next.created_at) - new Date(m.created_at) > 30 * 60000);
      const hasPrev = !sepBefore && groupable(prev, m);
      const hasNext = !sepAfter && groupable(m, next);
      const owner = App.msgOwner(m);
      const mine = owner === App.me;
      const pos = !hasPrev ? 'first' : hasNext ? 'mid' : 'last';
      const showAvatar = !mine && !hasNext;
      const showName = !mine && conv.is_group && !hasPrev;

      parts.push(`<div class="msg-row ${mine ? 'mine' : ''} ${pos} ${hasNext ? 'has-next' : ''}" data-id="${m.id}">
        ${mine ? '' : `<div class="avatar-slot">${showAvatar ? Util.avatarHtml(App.profile(owner), 'sm') : ''}</div>`}
        <div class="msg-col">
          ${showName ? `<div class="sender-name">${Util.escapeHtml(App.profile(owner).display_name)}</div>` : ''}
          ${App.messageBodyHtml(m)}
        </div>
      </div>`);
      if (i === lastMineIdx) {
        parts.push('<div class="seen-row" id="seen-row"></div>');
      }
    });

    box.innerHTML = parts.join('');
    App.hydrateFiles(box);
    App.renderSeen();
    App.renderCallBanner();
    if (toBottom || nearBottom) {
      box.scrollTop = box.scrollHeight;
    }
  },

  messageBodyHtml(m) {
    const state = m._failed ? 'failed' : m._pending ? 'pending' : '';
    const time = Util.formatClock(m.created_at);
    if (m.kind === 'file') {
      const type = m.file_type || '';
      const path = Util.escapeHtml(m.file_path);
      const cached = App.urlCache.get(m.file_path)?.url;
      if (type.startsWith('image/')) {
        return `<img class="msg-img" data-path="${path}" ${cached ? `src="${cached}"` : ''} alt="${Util.escapeHtml(m.file_name)}" title="${time}" loading="lazy">`;
      }
      if (type.startsWith('video/')) {
        return `<video class="msg-video" data-path="${path}" ${cached ? `src="${cached}"` : ''} controls preload="metadata" title="${time}"></video>`;
      }
      if (type.startsWith('audio/')) {
        return `<audio data-path="${path}" ${cached ? `src="${cached}"` : ''} controls preload="metadata"></audio>`;
      }
      return `<div class="bubble ${state}" title="${time}"><a class="file-card" href="#" data-download="${path}" data-name="${Util.escapeHtml(m.file_name)}">
        <span class="file-icon"><svg><use href="#i-file"/></svg></span>
        <span><div class="file-name">${Util.escapeHtml(m.file_name)}</div><div class="file-size">${Util.formatSize(m.file_size)}</div></span>
      </a></div>`;
    }
    if (m.kind === 'call') {
      const call = App.callInfo(m);
      const missed = call.status === 'missed';
      const label = missed
        ? call.caller === App.me ? 'Không ai trả lời' : 'Cuộc gọi nhỡ'
        : call.video ? 'Cuộc gọi video' : 'Cuộc gọi thoại';
      const sub = call.duration ? Util.formatCallDuration(call.duration) : time;
      return `<div class="bubble" title="${time}"><div class="call-card ${missed ? 'missed' : ''}">
        <span class="call-icon"><svg><use href="#${call.video ? 'i-video' : 'i-phone'}"/></svg></span>
        <span><div class="call-label">${label}</div><div class="call-time">${sub}</div></span>
      </div></div>`;
    }
    const emoji = Util.isEmojiOnly(m.body) ? 'emoji-only' : '';
    return `<div class="bubble ${emoji} ${state}" title="${time}">${Util.linkify(m.body)}</div>`;
  },

  async hydrateFiles(root) {
    const els = $$('[data-path]:not([src])', root);
    for (const el of els) {
      const url = await App.fileUrl(el.dataset.path);
      if (url) {
        el.src = url;
      }
    }
  },

  async fileUrl(path, downloadName = null) {
    const key = downloadName ? `${path}::dl` : path;
    const hit = App.urlCache.get(key);
    if (hit && hit.expires > Date.now()) {
      return hit.url;
    }
    const { data, error } = await App.sb.storage.from(BUCKET).createSignedUrl(path, 3600, downloadName ? { download: downloadName } : undefined);
    if (error) {
      return null;
    }
    App.urlCache.set(key, { url: data.signedUrl, expires: Date.now() + 50 * 60000 });
    return data.signedUrl;
  },

  async downloadFile(path, name) {
    const url = await App.fileUrl(path, name);
    if (!url) {
      Util.toast('Không tải được file', 'error');
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  renderSeen() {
    const row = $('#seen-row');
    const conv = App.convs.get(App.activeId);
    const store = App.messages.get(App.activeId);
    if (!row || !conv || !store) {
      return;
    }
    const mine = store.list.filter((m) => App.msgOwner(m) === App.me && m.kind !== 'system');
    const last = mine[mine.length - 1];
    if (!last) {
      row.innerHTML = '';
      return;
    }
    if (last._failed) {
      row.innerHTML = '<span class="seen-text" style="color:var(--danger)">Gửi thất bại</span>';
      return;
    }
    if (last._pending) {
      row.innerHTML = '<span class="seen-text">Đang gửi...</span>';
      return;
    }
    const members = App.members.get(App.activeId) || new Map();
    const seenBy = Array.from(members.entries())
      .filter(([id, readAt]) => id !== App.me && readAt && new Date(readAt) >= new Date(last.created_at))
      .map(([id]) => id);
    if (seenBy.length) {
      row.innerHTML = conv.is_group
        ? seenBy.slice(0, 8).map((id) => Util.avatarHtml(App.profile(id), 'xs')).join('') + (seenBy.length > 8 ? `<span class="seen-text">+${seenBy.length - 8}</span>` : '')
        : '<span class="seen-text">Đã xem</span>';
    } else {
      row.innerHTML = '<span class="seen-text">Đã gửi</span>';
    }
  },

  markReadSoon: Util.debounce(async (convId) => {
    if (document.hidden || App.activeId !== convId) {
      return;
    }
    const conv = App.convs.get(convId);
    if (conv) {
      conv.unread = 0;
    }
    App.updateTitle();
    const { data } = await App.sb.rpc('mark_read', { p_conversation_id: convId });
    if (data && conv) {
      conv.my_last_read_at = data;
      App.members.get(convId)?.set(App.me, data);
    }
  }, 400),

  autoGrow() {
    const el = $('#msg-input');
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  },

  /* ================= Gửi tin ================= */
  async sendText() {
    const input = $('#msg-input');
    const body = input.value.trim();
    const convId = App.activeId;
    if (!body || !convId) {
      return;
    }
    input.value = '';
    App.autoGrow();
    await App.insertMessage({ conversation_id: convId, kind: 'text', body });
  },

  async insertMessage(fields) {
    const msg = {
      id: Util.uuid(),
      sender_id: App.me,
      created_at: new Date().toISOString(),
      body: null,
      ...fields,
    };
    const store = App.messages.get(msg.conversation_id);
    if (store) {
      store.list.push({ ...msg, _pending: true });
    }
    const conv = App.convs.get(msg.conversation_id);
    if (conv) {
      App.applyLastMessage(conv, msg);
      App.renderConvList();
    }
    if (App.activeId === msg.conversation_id) {
      App.renderMessages({ toBottom: true });
    }

    const { created_at, ...row } = msg;
    const { data, error } = await App.sb.from('messages').insert(row).select().single();
    const current = store?.list.find((m) => m.id === msg.id);
    if (error) {
      if (current) {
        current._pending = false;
        current._failed = true;
      }
      Util.toast(`Gửi thất bại: ${error.message}`, 'error');
    } else if (store) {
      const idx = store.list.findIndex((m) => m.id === msg.id);
      if (idx >= 0) {
        store.list[idx] = data;
      }
      store.list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
    if (App.activeId === msg.conversation_id) {
      App.renderMessages();
    }
    return error ? null : data;
  },

  safeFileName(name) {
    const clean = App.normalize(name).replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_');
    return clean.slice(-80) || 'file';
  },

  async sendFiles(files) {
    const convId = App.activeId;
    if (!convId || !files.length) {
      return;
    }
    const progress = $('#upload-progress');
    for (const [i, file] of files.entries()) {
      if (file.size > MAX_FILE_SIZE) {
        Util.toast(`"${file.name}" vượt quá 25MB`, 'error');
        continue;
      }
      progress.textContent = `Đang gửi ${files.length > 1 ? `(${i + 1}/${files.length}) ` : ''}${file.name}...`;
      progress.classList.remove('hidden');
      const name = file.name || `anh-${Date.now()}.png`;
      const path = `${convId}/${Util.uuid()}-${App.safeFileName(name)}`;
      const { error } = await App.sb.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || 'application/octet-stream',
        upsert: false,
      });
      if (error) {
        Util.toast(`Tải lên thất bại: ${error.message}`, 'error');
        continue;
      }
      await App.insertMessage({
        conversation_id: convId,
        kind: 'file',
        file_path: path,
        file_name: name,
        file_type: file.type || 'application/octet-stream',
        file_size: file.size,
      });
    }
    progress.classList.add('hidden');
  },

  async sendSystemMessage(convId, text) {
    await App.sb.from('messages').insert({ conversation_id: convId, kind: 'system', body: text });
  },

  /* ================= Modal ================= */
  openModal(title, bodyHtml, footHtml = '') {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal-foot').innerHTML = footHtml;
    $('#modal').classList.remove('hidden');
    return $('#modal-body');
  },

  closeModal() {
    $('#modal').classList.add('hidden');
    $('#modal-body').innerHTML = '';
    $('#modal-foot').innerHTML = '';
  },

  /** Chọn người: dùng cho tin nhắn mới, tạo nhóm, thêm thành viên */
  userPickerHtml(users, multi) {
    if (!users.length) {
      return '<div class="empty-note">Không còn ai để chọn</div>';
    }
    return users
      .map(
        (p) => `<label class="user-pick" data-id="${p.id}" data-search="${Util.escapeHtml(App.normalize(p.display_name + ' ' + (p.email || '')))}">
          ${Util.avatarHtml(p, '', App.online.has(p.id))}
          <div class="meta"><div>${Util.escapeHtml(p.display_name)}</div><div class="sub">${Util.escapeHtml(p.email || '')}</div></div>
          ${multi ? `<input type="checkbox" value="${p.id}">` : ''}
        </label>`,
      )
      .join('');
  },

  bindPickerSearch(body) {
    const search = $('.picker-search', body);
    search.oninput = () => {
      const q = App.normalize(search.value.trim());
      $$('.user-pick', body).forEach((el) => el.classList.toggle('hidden', !!q && !el.dataset.search.includes(q)));
    };
    setTimeout(() => search.focus(), 50);
  },

  async openNewChatModal(isGroup) {
    await App.loadProfiles();
    const users = Array.from(App.profiles.values()).filter((p) => p.id !== App.me);
    const body = App.openModal(
      isGroup ? 'Tạo nhóm mới' : 'Tin nhắn mới',
      `${isGroup ? '<input id="group-name" placeholder="Tên nhóm (không bắt buộc)" maxlength="80">' : ''}
       <input class="picker-search" placeholder="Tìm tên hoặc email">
       ${isGroup ? '<div class="chips" id="picked"></div>' : ''}
       <div class="picker">${App.userPickerHtml(users, isGroup)}</div>`,
      isGroup ? '<button class="btn primary" id="create-group-btn" disabled>Tạo nhóm</button>' : '',
    );
    App.bindPickerSearch(body);

    if (!isGroup) {
      $$('.user-pick', body).forEach((el) => (el.onclick = () => App.openDirect(el.dataset.id)));
      return;
    }
    const update = () => {
      const ids = $$('input[type=checkbox]:checked', body).map((c) => c.value);
      $('#picked').innerHTML = ids.map((id) => `<span class="chip">${Util.escapeHtml(App.profile(id).display_name)}</span>`).join('');
      $('#create-group-btn').disabled = ids.length < 2;
      $('#create-group-btn').textContent = ids.length < 2 ? 'Chọn ít nhất 2 người' : `Tạo nhóm (${ids.length + 1} người)`;
    };
    body.onchange = update;
    update();
    $('#create-group-btn').onclick = async () => {
      const ids = $$('input[type=checkbox]:checked', body).map((c) => c.value);
      const name = $('#group-name').value.trim();
      $('#create-group-btn').disabled = true;
      const { data, error } = await App.sb.rpc('create_conversation', { p_member_ids: ids, p_name: name || null, p_is_group: true });
      if (error) {
        Util.toast(`Tạo nhóm thất bại: ${error.message}`, 'error');
        $('#create-group-btn').disabled = false;
        return;
      }
      await App.sendSystemMessage(data, `${App.profile(App.me).display_name} đã tạo nhóm`);
      await App.loadConversations();
      App.closeModal();
      App.openConversation(data);
    };
  },

  openInfoModal() {
    const conv = App.convs.get(App.activeId);
    if (!conv) {
      return;
    }
    if (!conv.is_group) {
      const p = App.profile(App.otherMember(conv));
      App.openModal(
        'Thông tin',
        `<div class="info-head">${Util.avatarHtml(p, 'xl', App.online.has(p.id))}
          <div class="name">${Util.escapeHtml(p.display_name)}</div>
          <div class="sub" style="color:var(--text-2)">${Util.escapeHtml(p.email || '')}</div>
          <div class="sub" style="color:var(--text-2)">${App.online.has(p.id) ? '🟢 Đang hoạt động' : 'Không hoạt động'}</div>
          <div class="member-actions">
            <button class="btn" id="info-call"><svg><use href="#i-phone"/></svg>Gọi thoại</button>
            <button class="btn" id="info-video"><svg><use href="#i-video"/></svg>Gọi video</button>
          </div></div>`,
      );
      $('#info-call').onclick = () => (App.closeModal(), Call.start(conv.id, false));
      $('#info-video').onclick = () => (App.closeModal(), Call.start(conv.id, true));
      return;
    }

    const members = conv.member_ids
      .map((id) => App.profile(id))
      .sort((a, b) => (a.id === App.me ? -1 : b.id === App.me ? 1 : a.display_name.localeCompare(b.display_name)));
    App.openModal(
      'Thông tin nhóm',
      `<div class="info-head">${App.convAvatarHtml(conv, 'lg')}
        <div class="name">${Util.escapeHtml(App.convTitle(conv))}</div>
        <div class="member-actions">
          <button class="btn small" id="rename-btn"><svg><use href="#i-edit"/></svg>Đổi tên</button>
          <button class="btn small" id="add-member-btn"><svg><use href="#i-person-add"/></svg>Thêm người</button>
          <button class="btn small danger" id="leave-btn">Rời nhóm</button>
        </div></div>
       <div class="section-label">${members.length} thành viên</div>
       ${members
         .map(
           (p) => `<div class="user-pick">${Util.avatarHtml(p, '', App.online.has(p.id))}
             <div class="meta"><div>${Util.escapeHtml(p.display_name)}${p.id === App.me ? ' (Bạn)' : ''}</div>
             <div class="sub">${Util.escapeHtml(p.email || '')}</div></div></div>`,
         )
         .join('')}`,
    );

    $('#rename-btn').onclick = async () => {
      const name = prompt('Tên nhóm mới', conv.name || '');
      if (name === null) {
        return;
      }
      const { error } = await App.sb.from('conversations').update({ name: name.trim() || null }).eq('id', conv.id);
      if (error) {
        Util.toast(error.message, 'error');
        return;
      }
      conv.name = name.trim() || null;
      await App.sendSystemMessage(conv.id, `${App.profile(App.me).display_name} đã đổi tên nhóm thành "${App.convTitle(conv)}"`);
      App.closeModal();
      App.renderChatHeader();
      App.renderConvList();
    };
    $('#add-member-btn').onclick = () => App.openAddMembersModal(conv);
    $('#leave-btn').onclick = async () => {
      if (!confirm('Rời khỏi nhóm này?')) {
        return;
      }
      await App.sendSystemMessage(conv.id, `${App.profile(App.me).display_name} đã rời nhóm`);
      const { error } = await App.sb.from('conversation_members').delete().eq('conversation_id', conv.id).eq('user_id', App.me);
      if (error) {
        Util.toast(error.message, 'error');
        return;
      }
      App.closeModal();
      App.convs.delete(conv.id);
      App.closeConversation();
    };
  },

  async openAddMembersModal(conv) {
    await App.loadProfiles();
    const users = Array.from(App.profiles.values()).filter((p) => !conv.member_ids.includes(p.id));
    const body = App.openModal(
      'Thêm thành viên',
      `<input class="picker-search" placeholder="Tìm tên hoặc email"><div class="picker">${App.userPickerHtml(users, true)}</div>`,
      '<button class="btn primary" id="do-add-btn">Thêm</button>',
    );
    App.bindPickerSearch(body);
    $('#do-add-btn').onclick = async () => {
      const ids = $$('input[type=checkbox]:checked', body).map((c) => c.value);
      if (!ids.length) {
        return;
      }
      const { error } = await App.sb.rpc('add_group_members', { p_conversation_id: conv.id, p_member_ids: ids });
      if (error) {
        Util.toast(error.message, 'error');
        return;
      }
      const names = ids.map((id) => App.profile(id).display_name).join(', ');
      await App.sendSystemMessage(conv.id, `${App.profile(App.me).display_name} đã thêm ${names} vào nhóm`);
      await App.loadConversations();
      App.closeModal();
    };
  },

  openProfileModal() {
    const me = App.profile(App.me);
    const notifState = !('Notification' in window)
      ? 'Trình duyệt không hỗ trợ'
      : Notification.permission === 'granted'
        ? 'Đã bật'
        : Notification.permission === 'denied'
          ? 'Đã chặn (bật lại trong cài đặt trình duyệt)'
          : 'Chưa bật';
    App.openModal(
      'Hồ sơ của tôi',
      `<div class="info-head">${Util.avatarHtml(me, 'xl')}<div class="sub" style="color:var(--text-2)">${Util.escapeHtml(me.email || '')}</div></div>
       <label>Tên hiển thị<input id="my-name" value="${Util.escapeHtml(me.display_name)}" maxlength="60"></label>
       <label>Thông báo tin nhắn / cuộc gọi
         <span style="display:flex;gap:8px;align-items:center;font-weight:400">${notifState}
         ${'Notification' in window && Notification.permission === 'default' ? '<button class="btn small" id="notif-btn">Bật thông báo</button>' : ''}</span>
       </label>`,
      '<button class="btn danger" id="logout-btn"><svg><use href="#i-logout"/></svg>Đăng xuất</button><button class="btn primary" id="save-me-btn">Lưu</button>',
    );
    const notifBtn = $('#notif-btn');
    if (notifBtn) {
      notifBtn.onclick = async () => {
        await Notification.requestPermission();
        App.openProfileModal();
      };
    }
    $('#save-me-btn').onclick = async () => {
      const name = $('#my-name').value.trim();
      if (!name) {
        return;
      }
      const { error } = await App.sb.from('profiles').update({ display_name: name }).eq('id', App.me);
      if (error) {
        Util.toast(error.message, 'error');
        return;
      }
      me.display_name = name;
      App.renderMe();
      App.closeModal();
      Util.toast('Đã lưu');
    };
    $('#logout-btn').onclick = async () => {
      if (Call.state) {
        Call.hangUp();
      }
      await App.sb.auth.signOut();
    };
  },
};

window.addEventListener('DOMContentLoaded', () => App.init());
