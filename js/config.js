// Điền thông tin Supabase project (Project Settings > API)
window.APP_CONFIG = {
  SUPABASE_URL: 'https://teeyrdcgvhqjtlahydwn.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlZXlyZGNndmhxanRsYWh5ZHduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExMjE4NzksImV4cCI6MjEwNjY5Nzg3OX0.odxTGnJ39WjT3W7MRMpv_4WCL1O81BJXtrBrchnjFtc',

  // Máy chủ STUN/TURN cho gọi thoại/video.
  // STUN miễn phí đủ cho cùng mạng LAN/wifi. Gọi qua 4G hoặc mạng công ty chặn chặt thì nên thêm TURN
  // (vd. đăng ký free tại metered.ca hoặc Cloudflare Calls rồi dán vào đây):
  // { urls: 'turn:xxx.metered.live:443?transport=tcp', username: '...', credential: '...' }
  ICE_SERVERS: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],

  APP_NAME: 'Chat Nội Bộ',
};
