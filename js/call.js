/*
 * Gọi thoại / video bằng WebRTC (mesh: mỗi người nối trực tiếp với từng người khác).
 * Tín hiệu đi qua Supabase Realtime broadcast (App.signal).
 *
 * Luồng:
 *  - Người gọi gửi `invite` cho thành viên đoạn chat.
 *  - Ai nghe máy gửi `join`; người đang trong cuộc gọi trả lời `present`.
 *  - Với mỗi cặp, người có user id nhỏ hơn tạo offer (tránh 2 bên cùng offer).
 *  - Mỗi 4s người trong cuộc gọi gửi `alive` kèm danh sách người tham gia
 *    → người khác biết cuộc gọi còn diễn ra (hiện nút "Tham gia") và tự nối lại nếu lỡ tín hiệu.
 */
const RING_TIMEOUT = 45000;
const ALIVE_INTERVAL = 4000;
const ALIVE_EXPIRE = 13000;

const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const videoConstraints = (facing) => ({
  facingMode: facing,
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 24, max: 30 },
});

const Call = {
  state: null,
  incoming: null,
  activeCalls: new Map(),
  hasMultipleCameras: false,
  audioCtx: null,

  init() {
    $('#accept-audio-btn').onclick = () => Call.accept(false);
    $('#accept-video-btn').onclick = () => Call.accept(true);
    $('#decline-btn').onclick = () => Call.decline();
    $('#hangup-btn').onclick = () => Call.hangUp();
    $('#mic-btn').onclick = () => Call.toggleMic();
    $('#cam-btn').onclick = () => Call.toggleCam();
    $('#flip-btn').onclick = () => Call.flipCamera();
    $('#screen-btn').onclick = () => Call.toggleScreen();
    $('#add-people-btn').onclick = () => Call.ringMissing();
    $('#call-min-btn').onclick = () => Call.minimize(true);
    $('#call-pill').onclick = () => Call.minimize(false);

    if (!navigator.mediaDevices?.getDisplayMedia) {
      $('#screen-btn').classList.add('hidden');
    }
    navigator.mediaDevices?.enumerateDevices?.().then((devices) => {
      Call.hasMultipleCameras = devices.filter((d) => d.kind === 'videoinput').length > 1;
    }).catch(() => {});

    setInterval(() => Call.sweep(), 3000);
    window.addEventListener('pagehide', () => Call.state && Call.sendToMembers({ type: 'leave' }));
  },

  /* ================= Theo dõi cuộc gọi đang diễn ra ================= */
  trackCall(info, participants, mode) {
    let c = Call.activeCalls.get(info.callId);
    if (!c) {
      if (mode === 'remove') {
        return;
      }
      c = { callId: info.callId, convId: info.convId, video: !!info.video, isGroup: !!info.isGroup, participants: new Set() };
      Call.activeCalls.set(info.callId, c);
    }
    if (info.convId) {
      c.convId = info.convId;
    }
    c.lastSeen = Date.now();
    if (mode === 'set') {
      c.participants = new Set(participants);
    } else if (mode === 'add') {
      participants.forEach((id) => c.participants.add(id));
    } else {
      participants.forEach((id) => c.participants.delete(id));
    }
    if (!c.participants.size) {
      Call.activeCalls.delete(info.callId);
    }
    Call.refreshIndicators();
  },

  activeCallFor(convId) {
    for (const c of Call.activeCalls.values()) {
      if (c.convId === convId && c.participants.size) {
        return c;
      }
    }
    return null;
  },

  sweep() {
    let changed = false;
    for (const [id, c] of Call.activeCalls) {
      if (Call.state?.id === id) {
        continue;
      }
      if (Date.now() - c.lastSeen > ALIVE_EXPIRE) {
        Call.activeCalls.delete(id);
        changed = true;
      }
    }
    if (Call.incoming && !Call.activeCalls.has(Call.incoming.callId)) {
      Call.missed();
    }
    if (changed) {
      Call.refreshIndicators();
    }
  },

  refreshIndicators() {
    if (App.activeId) {
      App.renderCallBanner();
    }
    App.renderConvList();
  },

  /* ================= Tín hiệu ================= */
  send(payload) {
    App.signal({ ...payload, callId: payload.callId || Call.state?.id });
  },

  sendToMembers(payload) {
    if (!Call.state) {
      return;
    }
    Call.send({ ...payload, to: Call.state.members });
  },

  /** Tín hiệu từ chính mình ở tab/thiết bị khác: đã nghe/từ chối ở nơi khác thì tắt chuông */
  onSelfSignal(p) {
    if (Call.incoming && Call.incoming.callId === p.callId && ['join', 'decline'].includes(p.type)) {
      Call.dismissIncoming();
    }
  },

  async onSignal(p) {
    const s = Call.state;
    const inThisCall = s && s.id === p.callId;

    switch (p.type) {
      case 'invite': {
        Call.trackCall(p, [p.from], 'add');
        if (inThisCall) {
          return;
        }
        if (s || (Call.incoming && Call.incoming.callId !== p.callId)) {
          Call.send({ type: 'busy', callId: p.callId, to: [p.from] });
          return;
        }
        if (!Call.incoming) {
          Call.showIncoming(p);
        }
        return;
      }
      case 'join':
        Call.trackCall(p, [p.from], 'add');
        if (inThisCall) {
          Call.send({ type: 'present', to: [p.from] });
          Call.ensurePeer(p.from);
          Call.sendMediaState([p.from]);
        }
        return;
      case 'present':
        Call.trackCall(p, [p.from], 'add');
        if (inThisCall) {
          Call.ensurePeer(p.from);
          Call.sendMediaState([p.from]);
        }
        return;
      case 'alive':
        Call.trackCall(p, p.participants || [p.from], 'set');
        if (inThisCall) {
          (p.participants || []).forEach((id) => id !== App.me && Call.ensurePeer(id));
        }
        return;
      case 'offer':
        return inThisCall && Call.onOffer(p);
      case 'answer':
        return inThisCall && Call.onAnswer(p);
      case 'ice':
        return inThisCall && Call.onIce(p);
      case 'media': {
        const peer = inThisCall && s.peers.get(p.from);
        if (peer) {
          peer.remoteCam = !!p.cam;
          peer.remoteMic = !!p.mic;
          peer.remoteScreen = !!p.screen;
          Call.updateTile(peer);
        }
        return;
      }
      case 'leave':
        Call.trackCall(p, [p.from], 'remove');
        if (inThisCall) {
          Call.removePeer(p.from);
          if (!s.isGroup) {
            Call.end('Cuộc gọi đã kết thúc');
          } else if (s.hadPeers && !s.peers.size) {
            Call.end('Mọi người đã rời cuộc gọi');
          }
        }
        if (Call.incoming && Call.incoming.callId === p.callId && (!Call.incoming.isGroup || !Call.activeCalls.has(p.callId))) {
          Call.missed();
        }
        return;
      case 'decline':
        if (inThisCall) {
          const name = App.profile(p.from).display_name;
          if (!s.isGroup) {
            Call.end(`${name} đã từ chối cuộc gọi`);
          } else {
            Util.toast(`${name} đã từ chối`);
          }
        }
        return;
      case 'busy':
        if (inThisCall) {
          const name = App.profile(p.from).display_name;
          if (!s.isGroup) {
            Call.end(`${name} đang bận`);
          } else {
            Util.toast(`${name} đang bận`);
          }
        }
        return;
      default:
    }
  },

  /* ================= Bắt đầu / nghe / tham gia ================= */
  canCall() {
    if (Call.state) {
      Util.toast('Bạn đang trong một cuộc gọi khác');
      return false;
    }
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
      Util.toast('Trình duyệt không hỗ trợ gọi (cần mở bằng https và trình duyệt mới)', 'error');
      return false;
    }
    return true;
  },

  async start(convId, video) {
    const conv = App.convs.get(convId);
    if (!conv || !Call.canCall()) {
      return;
    }
    const existing = Call.activeCallFor(convId);
    if (existing && existing.isGroup) {
      return Call.joinExisting(existing, video);
    }
    const members = conv.member_ids.filter((id) => id !== App.me);
    if (!members.length) {
      Util.toast('Đoạn chat không còn ai khác');
      return;
    }

    const media = await Call.openMedia(video);
    Call.state = Call.newState({ id: Util.uuid(), convId, isGroup: conv.is_group, video, members, outgoing: true, media });
    Call.showCallUi();
    Sound.startRingback();
    Call.send({ type: 'invite', convId, video, isGroup: conv.is_group, to: conv.member_ids });
    Call.trackCall(Call.state.info(), [App.me], 'add');
    Call.startAlive();
    App.insertMessage({ conversation_id: convId, kind: 'call', body: JSON.stringify({ callId: Call.state.id, video }) });

    const callId = Call.state.id;
    Call.state.ringTimer = setTimeout(() => {
      if (Call.state?.id === callId && !Call.state.hadPeers) {
        Call.hangUp(conv.is_group ? 'Không ai tham gia cuộc gọi' : 'Không trả lời');
      }
    }, RING_TIMEOUT);
  },

  async joinExisting(active, video) {
    const conv = App.convs.get(active.convId);
    if (!conv || !Call.canCall()) {
      return;
    }
    const media = await Call.openMedia(video);
    Call.state = Call.newState({
      id: active.callId,
      convId: active.convId,
      isGroup: conv.is_group,
      video,
      members: conv.member_ids.filter((id) => id !== App.me),
      outgoing: false,
      media,
    });
    Call.showCallUi();
    Call.send({ type: 'join', to: conv.member_ids });
    Call.trackCall(Call.state.info(), [App.me], 'add');
    Call.startAlive();
  },

  async showIncoming(p) {
    let conv = App.convs.get(p.convId);
    if (!conv) {
      await App.loadConversations();
      conv = App.convs.get(p.convId);
      if (!conv) {
        return;
      }
    }
    const caller = App.profile(p.from);
    Call.incoming = { ...p };
    $('#incoming-avatar').innerHTML = conv.is_group ? App.convAvatarHtml(conv, 'lg') : Util.avatarHtml(caller, 'xl');
    $('#incoming-name').textContent = conv.is_group ? App.convTitle(conv) : caller.display_name;
    $('#incoming-sub').textContent = conv.is_group
      ? `${caller.display_name} đang gọi ${p.video ? 'video' : 'thoại'} nhóm...`
      : `Cuộc gọi ${p.video ? 'video' : 'thoại'} đến...`;
    $('#incoming').classList.remove('hidden');
    Sound.startRingtone();
    Call.incoming.notification = Util.notify(
      conv.is_group ? `Cuộc gọi nhóm: ${App.convTitle(conv)}` : `${caller.display_name} đang gọi`,
      p.video ? 'Cuộc gọi video đến' : 'Cuộc gọi thoại đến',
    );
    Call.incoming.timer = setTimeout(() => Call.missed(), RING_TIMEOUT);
  },

  dismissIncoming() {
    if (!Call.incoming) {
      return;
    }
    clearTimeout(Call.incoming.timer);
    Call.incoming.notification?.close?.();
    Call.incoming = null;
    $('#incoming').classList.add('hidden');
    Sound.stopLoop();
  },

  missed() {
    if (!Call.incoming) {
      return;
    }
    const name = App.profile(Call.incoming.from).display_name;
    Call.dismissIncoming();
    Util.toast(`Cuộc gọi nhỡ từ ${name}`);
  },

  decline() {
    const inc = Call.incoming;
    if (!inc) {
      return;
    }
    const conv = App.convs.get(inc.convId);
    Call.send({ type: 'decline', callId: inc.callId, to: conv ? conv.member_ids : [inc.from] });
    Call.dismissIncoming();
  },

  async accept(video) {
    const inc = Call.incoming;
    if (!inc || !Call.canCall()) {
      return;
    }
    Call.dismissIncoming();
    const active = Call.activeCalls.get(inc.callId) || { callId: inc.callId, convId: inc.convId, video: inc.video, isGroup: inc.isGroup };
    await Call.joinExisting(active, video);
    if (App.activeId !== inc.convId && window.innerWidth > 760) {
      App.openConversation(inc.convId);
    }
  },

  /** Mời lại những thành viên nhóm chưa vào cuộc gọi */
  ringMissing() {
    const s = Call.state;
    if (!s) {
      return;
    }
    const missing = s.members.filter((id) => !s.peers.has(id));
    if (!missing.length) {
      Util.toast('Mọi người đều đã ở trong cuộc gọi');
      return;
    }
    Call.send({ type: 'invite', convId: s.convId, video: s.video, isGroup: s.isGroup, to: missing });
    Util.toast(`Đã đổ chuông cho ${missing.length} người`);
  },

  newState({ id, convId, isGroup, video, members, outgoing, media }) {
    const state = {
      id,
      convId,
      isGroup,
      video,
      members,
      outgoing,
      peers: new Map(),
      micTrack: media.micTrack,
      camTrack: media.camTrack,
      screenTrack: null,
      micOn: !!media.micTrack,
      facing: 'user',
      startedAt: null,
      hadPeers: false,
      focusId: null,
      info() {
        return { callId: this.id, convId: this.convId, video: this.video, isGroup: this.isGroup };
      },
    };
    return state;
  },

  /* ================= Media ================= */
  async openMedia(video) {
    const result = { micTrack: null, camTrack: null };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_CONSTRAINTS,
        video: video ? videoConstraints('user') : false,
      });
      result.micTrack = stream.getAudioTracks()[0] || null;
      result.camTrack = stream.getVideoTracks()[0] || null;
    } catch (err) {
      if (video) {
        Util.toast('Không mở được camera, chuyển sang gọi thoại', 'error');
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
          result.micTrack = stream.getAudioTracks()[0] || null;
        } catch (e) {
          Util.toast('Không truy cập được micro — người khác sẽ không nghe thấy bạn', 'error');
        }
      } else {
        Util.toast('Không truy cập được micro — người khác sẽ không nghe thấy bạn', 'error');
      }
    }
    return result;
  },

  currentVideoTrack() {
    const s = Call.state;
    return s ? s.screenTrack || s.camTrack || null : null;
  },

  async replaceVideoForAll() {
    const track = Call.currentVideoTrack();
    for (const peer of Call.state.peers.values()) {
      if (peer.videoTx) {
        await peer.videoTx.sender.replaceTrack(track).catch(() => {});
      }
    }
    Call.updateLocalTile();
    Call.sendMediaState();
  },

  async toggleMic() {
    const s = Call.state;
    if (!s) {
      return;
    }
    if (!s.micTrack) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        s.micTrack = stream.getAudioTracks()[0];
        for (const peer of s.peers.values()) {
          await peer.audioTx?.sender.replaceTrack(s.micTrack).catch(() => {});
        }
        s.micOn = true;
      } catch (e) {
        Util.toast('Không truy cập được micro', 'error');
        return;
      }
    } else {
      s.micOn = !s.micOn;
      s.micTrack.enabled = s.micOn;
    }
    Call.renderControls();
    Call.updateLocalTile();
    Call.sendMediaState();
  },

  async toggleCam() {
    const s = Call.state;
    if (!s) {
      return;
    }
    if (s.camTrack) {
      s.camTrack.stop();
      s.camTrack = null;
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(s.facing) });
        s.camTrack = stream.getVideoTracks()[0];
        s.video = true;
      } catch (e) {
        Util.toast('Không mở được camera', 'error');
        return;
      }
    }
    if (!s.screenTrack) {
      await Call.replaceVideoForAll();
    }
    Call.renderControls();
    Call.updateLocalTile();
  },

  async flipCamera() {
    const s = Call.state;
    if (!s || !s.camTrack) {
      return;
    }
    const facing = s.facing === 'user' ? 'environment' : 'user';
    try {
      s.camTrack.stop();
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(facing) });
      s.camTrack = stream.getVideoTracks()[0];
      s.facing = facing;
      if (!s.screenTrack) {
        await Call.replaceVideoForAll();
      }
    } catch (e) {
      Util.toast('Không đổi được camera', 'error');
    }
    Call.updateLocalTile();
  },

  async toggleScreen() {
    const s = Call.state;
    if (!s) {
      return;
    }
    if (s.screenTrack) {
      Call.stopScreen();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
      s.screenTrack = stream.getVideoTracks()[0];
      s.screenTrack.contentHint = 'detail';
      s.screenTrack.onended = () => Call.stopScreen();
      await Call.replaceVideoForAll();
      Call.renderControls();
    } catch (e) {
      if (e?.name !== 'NotAllowedError') {
        Util.toast('Không chia sẻ được màn hình', 'error');
      }
    }
  },

  async stopScreen() {
    const s = Call.state;
    if (!s || !s.screenTrack) {
      return;
    }
    s.screenTrack.onended = null;
    s.screenTrack.stop();
    s.screenTrack = null;
    await Call.replaceVideoForAll();
    Call.renderControls();
  },

  sendMediaState(to) {
    const s = Call.state;
    if (!s) {
      return;
    }
    Call.send({
      type: 'media',
      cam: !!Call.currentVideoTrack(),
      mic: !!(s.micTrack && s.micOn),
      screen: !!s.screenTrack,
      to: to || s.members,
    });
  },

  /* ================= Kết nối peer ================= */
  ensurePeer(uid) {
    const s = Call.state;
    if (!s || uid === App.me) {
      return null;
    }
    if (s.peers.has(uid)) {
      return s.peers.get(uid);
    }
    if (!s.members.includes(uid)) {
      s.members.push(uid);
    }
    const pc = new RTCPeerConnection({ iceServers: window.APP_CONFIG?.ICE_SERVERS || [] });
    const peer = {
      uid,
      pc,
      stream: new MediaStream(),
      pendingIce: [],
      audioTx: null,
      videoTx: null,
      remoteCam: undefined,
      remoteMic: true,
      remoteScreen: false,
      restarts: 0,
      connected: false,
      tile: null,
    };
    s.peers.set(uid, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        Call.send({ type: 'ice', to: [uid], candidate: e.candidate.toJSON() });
      }
    };
    pc.ontrack = (e) => {
      peer.stream.getTracks().filter((t) => t.kind === e.track.kind).forEach((t) => peer.stream.removeTrack(t));
      peer.stream.addTrack(e.track);
      e.track.onmute = () => Call.updateTile(peer);
      e.track.onunmute = () => Call.updateTile(peer);
      const video = $('video', peer.tile);
      if (video) {
        video.srcObject = peer.stream;
        video.play().catch(() => {});
      }
      if (e.track.kind === 'audio') {
        Call.watchSpeaking(peer);
      }
      Call.updateTile(peer);
    };
    pc.onconnectionstatechange = () => Call.onPeerState(peer);
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        Call.onPeerState(peer, true);
      }
    };

    // Người có id nhỏ hơn chủ động offer
    if (App.me < uid) {
      const s2 = Call.state;
      peer.audioTx = pc.addTransceiver(s2.micTrack || 'audio', { direction: 'sendrecv' });
      peer.videoTx = pc.addTransceiver(Call.currentVideoTrack() || 'video', { direction: 'sendrecv' });
      Call.makeOffer(peer);
    }
    Call.renderTiles();
    return peer;
  },

  async makeOffer(peer, iceRestart = false) {
    try {
      const offer = await peer.pc.createOffer({ iceRestart });
      await peer.pc.setLocalDescription(offer);
      Call.send({ type: 'offer', to: [peer.uid], sdp: peer.pc.localDescription.toJSON() });
    } catch (e) {
      console.error('offer failed', e);
    }
  },

  async onOffer(p) {
    const peer = Call.ensurePeer(p.from);
    if (!peer) {
      return;
    }
    const pc = peer.pc;
    try {
      await pc.setRemoteDescription(p.sdp);
      if (!peer.audioTx || !peer.videoTx) {
        for (const t of pc.getTransceivers()) {
          const kind = t.receiver.track?.kind;
          if (kind === 'audio' && !peer.audioTx) {
            peer.audioTx = t;
            t.direction = 'sendrecv';
            await t.sender.replaceTrack(Call.state.micTrack || null);
          } else if (kind === 'video' && !peer.videoTx) {
            peer.videoTx = t;
            t.direction = 'sendrecv';
            await t.sender.replaceTrack(Call.currentVideoTrack());
          }
        }
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      Call.send({ type: 'answer', to: [p.from], sdp: pc.localDescription.toJSON() });
      await Call.flushIce(peer);
    } catch (e) {
      console.error('answer failed', e);
    }
  },

  async onAnswer(p) {
    const peer = Call.state.peers.get(p.from);
    if (!peer || peer.pc.signalingState !== 'have-local-offer') {
      return;
    }
    try {
      await peer.pc.setRemoteDescription(p.sdp);
      await Call.flushIce(peer);
    } catch (e) {
      console.error('setRemote answer failed', e);
    }
  },

  async onIce(p) {
    const peer = Call.state.peers.get(p.from);
    if (!peer) {
      return;
    }
    if (peer.pc.remoteDescription) {
      await peer.pc.addIceCandidate(p.candidate).catch(() => {});
    } else {
      peer.pendingIce.push(p.candidate);
    }
  },

  async flushIce(peer) {
    const list = peer.pendingIce.splice(0);
    for (const c of list) {
      await peer.pc.addIceCandidate(c).catch(() => {});
    }
  },

  onPeerState(peer, iceFailed = false) {
    const s = Call.state;
    if (!s || s.peers.get(peer.uid) !== peer) {
      return;
    }
    const st = iceFailed ? 'failed' : peer.pc.connectionState;
    if (st === 'connected') {
      peer.connected = true;
      peer.restarts = 0;
      s.hadPeers = true;
      clearTimeout(s.ringTimer);
      Sound.stopLoop();
      if (!s.startedAt) {
        s.startedAt = Date.now();
        s.timer = setInterval(() => Call.renderStatus(), 1000);
      }
      Call.applyBitrates();
    } else if (st === 'failed') {
      if (App.me < peer.uid && peer.restarts < 3) {
        peer.restarts++;
        Call.makeOffer(peer, true);
      } else if (peer.restarts >= 3) {
        Call.removePeer(peer.uid);
      }
    }
    Call.updateTile(peer);
    Call.renderStatus();
  },

  /** Nhóm càng đông càng giảm bitrate để mạng chịu được */
  applyBitrates() {
    const s = Call.state;
    const n = s.peers.size;
    const maxBitrate = n <= 1 ? 1500000 : n <= 3 ? 700000 : 400000;
    for (const peer of s.peers.values()) {
      const sender = peer.videoTx?.sender;
      if (!sender?.getParameters) {
        continue;
      }
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) {
        continue;
      }
      params.encodings[0].maxBitrate = maxBitrate;
      sender.setParameters(params).catch(() => {});
    }
  },

  removePeer(uid) {
    const s = Call.state;
    const peer = s?.peers.get(uid);
    if (!peer) {
      return;
    }
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peer.speakingSource?.disconnect?.();
    peer.tile?.remove();
    s.peers.delete(uid);
    if (s.focusId === uid) {
      s.focusId = null;
    }
    Call.renderTiles();
    Call.renderStatus();
    Call.applyBitrates();
  },

  startAlive() {
    const tick = () => {
      const s = Call.state;
      if (!s) {
        return;
      }
      const participants = [App.me, ...Array.from(s.peers.keys())];
      Call.send({ type: 'alive', convId: s.convId, video: s.video, isGroup: s.isGroup, participants, to: s.members });
      Call.trackCall(s.info(), participants, 'set');
    };
    tick();
    Call.state.aliveTimer = setInterval(tick, ALIVE_INTERVAL);
  },

  hangUp(reason = '') {
    Call.end(reason);
  },

  /** Kết thúc cuộc gọi phía mình (luôn báo `leave` để người khác cập nhật ngay) */
  end(reason = '') {
    const s = Call.state;
    if (!s) {
      return;
    }
    Call.sendToMembers({ type: 'leave' });
    clearTimeout(s.ringTimer);
    clearInterval(s.timer);
    clearInterval(s.aliveTimer);
    clearInterval(s.speakTimer);
    for (const peer of s.peers.values()) {
      peer.pc.onconnectionstatechange = null;
      peer.pc.close();
    }
    [s.micTrack, s.camTrack, s.screenTrack].forEach((t) => t && t.stop());
    Call.trackCall(s.info(), [App.me], 'remove');
    Call.state = null;
    Sound.stopLoop();
    Sound.hangup();
    $('#call').classList.add('hidden');
    $('#call-pill').classList.add('hidden');
    $('#call-grid').innerHTML = '';
    $('#call-grid').className = 'call-grid';
    if (reason) {
      Util.toast(reason);
    }
    if (App.activeId) {
      App.renderChatHeader();
    }
  },

  /* ================= Giao diện cuộc gọi ================= */
  showCallUi() {
    const s = Call.state;
    $('#call-title').textContent = App.convTitle(App.convs.get(s.convId));
    $('#call').classList.remove('hidden');
    $('#call-pill').classList.add('hidden');
    $('#add-people-btn').classList.toggle('hidden', !s.isGroup);
    s.localTile = Call.createTile(App.me, true);
    s.speakTimer = setInterval(() => Call.pollSpeaking(), 250);
    Call.renderTiles();
    Call.renderControls();
    Call.renderStatus();
    Call.updateLocalTile();
    if (App.activeId) {
      App.renderChatHeader();
    }
  },

  minimize(min) {
    if (!Call.state) {
      return;
    }
    $('#call').classList.toggle('hidden', min);
    $('#call-pill').classList.toggle('hidden', !min);
    Call.renderStatus();
  },

  createTile(uid, isLocal) {
    const p = App.profile(uid);
    const tile = document.createElement('div');
    tile.className = `tile ${isLocal ? 'local' : ''}`;
    tile.dataset.uid = uid;
    tile.innerHTML = `
      <video autoplay playsinline ${isLocal ? 'muted' : ''}></video>
      <div class="tile-avatar">${Util.avatarHtml(p, 'xl')}<div class="tile-state"></div></div>
      <div class="tile-name"><svg class="mic-off hidden"><use href="#i-mic-off"/></svg><span>${Util.escapeHtml(isLocal ? 'Bạn' : p.display_name)}</span></div>
      <button class="icon-btn light tile-zoom" title="Phóng to"><svg><use href="#i-expand"/></svg></button>`;
    $('.tile-zoom', tile).onclick = (e) => {
      e.stopPropagation();
      Call.state.focusId = Call.state.focusId === uid ? null : uid;
      Call.renderTiles();
    };
    tile.ondblclick = () => $('.tile-zoom', tile).click();
    return tile;
  },

  renderTiles() {
    const s = Call.state;
    if (!s) {
      return;
    }
    const grid = $('#call-grid');
    const tiles = [];
    for (const peer of s.peers.values()) {
      if (!peer.tile) {
        peer.tile = Call.createTile(peer.uid, false);
        $('video', peer.tile).srcObject = peer.stream;
      }
      tiles.push(peer.tile);
      Call.updateTile(peer);
    }
    tiles.push(s.localTile);

    const remoteCount = s.peers.size;
    const pip = remoteCount === 1 && !s.focusId;
    const focus = !!s.focusId && tiles.some((t) => t.dataset.uid === s.focusId);
    const n = pip || focus ? 1 : tiles.length;
    const wide = window.innerWidth > window.innerHeight;
    const cols = n <= 1 ? 1 : n === 2 ? (wide ? 2 : 1) : n <= 4 ? 2 : n <= 9 ? 3 : 4;

    grid.className = `call-grid ${pip ? 'pip' : ''} ${focus ? 'focus' : ''}`;
    grid.style.setProperty('--cols', cols);
    tiles.forEach((t) => t.classList.toggle('focused', focus && t.dataset.uid === s.focusId));

    const current = Array.from(grid.children);
    if (current.length !== tiles.length || current.some((el, i) => el !== tiles[i])) {
      grid.replaceChildren(...tiles);
      $$('video', grid).forEach((v) => v.play().catch(() => {}));
    }
  },

  updateTile(peer) {
    if (!peer.tile) {
      return;
    }
    const vt = peer.stream.getVideoTracks()[0];
    const hasVideo = !!vt && vt.readyState === 'live' && !vt.muted && peer.remoteCam !== false;
    peer.tile.classList.toggle('has-video', hasVideo);
    peer.tile.classList.toggle('contain', !!peer.remoteScreen);
    $('.mic-off', peer.tile).classList.toggle('hidden', peer.remoteMic !== false);
    const st = peer.pc.connectionState;
    $('.tile-state', peer.tile).textContent =
      st === 'connected' ? '' : st === 'failed' ? 'Mất kết nối' : st === 'disconnected' ? 'Đang kết nối lại...' : 'Đang kết nối...';
  },

  updateLocalTile() {
    const s = Call.state;
    if (!s?.localTile) {
      return;
    }
    const track = Call.currentVideoTrack();
    const video = $('video', s.localTile);
    const currentTrack = video.srcObject?.getVideoTracks?.()[0];
    if (currentTrack !== track) {
      video.srcObject = track ? new MediaStream([track]) : null;
      video.play().catch(() => {});
    }
    s.localTile.classList.toggle('has-video', !!track);
    s.localTile.classList.toggle('mirror', !!track && !s.screenTrack && s.facing === 'user');
    s.localTile.classList.toggle('contain', !!s.screenTrack);
    $('.mic-off', s.localTile).classList.toggle('hidden', !!(s.micTrack && s.micOn));
  },

  renderControls() {
    const s = Call.state;
    if (!s) {
      return;
    }
    const micOn = !!(s.micTrack && s.micOn);
    $('#mic-btn').classList.toggle('off', !micOn);
    $('#mic-btn use').setAttribute('href', micOn ? '#i-mic' : '#i-mic-off');
    $('#cam-btn').classList.toggle('off', !s.camTrack);
    $('#cam-btn use').setAttribute('href', s.camTrack ? '#i-video' : '#i-video-off');
    $('#screen-btn').classList.toggle('on', !!s.screenTrack);
    $('#flip-btn').classList.toggle('hidden', !s.camTrack || !Call.hasMultipleCameras);
  },

  renderStatus() {
    const s = Call.state;
    if (!s) {
      return;
    }
    let text;
    const connected = Array.from(s.peers.values()).filter((p) => p.connected).length;
    if (s.startedAt) {
      text = Util.formatDuration(Date.now() - s.startedAt) + (s.isGroup ? ` · ${connected + 1} người` : '');
    } else if (s.peers.size) {
      text = 'Đang kết nối...';
    } else {
      text = s.outgoing ? 'Đang đổ chuông...' : 'Đang chờ mọi người...';
    }
    $('#call-sub').textContent = text;
    $('#call-pill-text').textContent = `${App.convTitle(App.convs.get(s.convId))} · ${text}`;
  },

  /* ================= Ai đang nói ================= */
  watchSpeaking(peer) {
    try {
      if (!Call.audioCtx) {
        Call.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      Call.audioCtx.resume?.();
      peer.speakingSource?.disconnect?.();
      const source = Call.audioCtx.createMediaStreamSource(new MediaStream(peer.stream.getAudioTracks()));
      const analyser = Call.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      peer.speakingSource = source;
      peer.analyser = analyser;
      peer.levels = new Uint8Array(analyser.frequencyBinCount);
    } catch (e) {
      peer.analyser = null;
    }
  },

  pollSpeaking() {
    const s = Call.state;
    if (!s || s.peers.size < 2) {
      return;
    }
    for (const peer of s.peers.values()) {
      if (!peer.analyser || !peer.tile) {
        continue;
      }
      peer.analyser.getByteFrequencyData(peer.levels);
      const avg = peer.levels.reduce((a, b) => a + b, 0) / peer.levels.length;
      peer.tile.classList.toggle('speaking', avg > 18 && peer.remoteMic !== false);
    }
  },
};
