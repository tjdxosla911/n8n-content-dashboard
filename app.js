const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 이미지 업로드 설정
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// DB 초기화
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new Database(path.join(dataDir, 'dashboard.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS contents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    body        TEXT    DEFAULT '',
    hashtags    TEXT    DEFAULT '',
    product     TEXT    DEFAULT '',
    requester   TEXT    DEFAULT '',
    platform    TEXT    DEFAULT '인스타그램',
    status      TEXT    DEFAULT 'pending',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 컬럼 추가 (이미 있으면 무시)
try { db.exec("ALTER TABLE contents ADD COLUMN thread_id TEXT DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE contents ADD COLUMN publish_message TEXT DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE contents ADD COLUMN image_url TEXT DEFAULT NULL"); } catch(e) {}

// ── 유틸 ─────────────────────────────────────────────────────────
function counts() {
  return {
    pending:  db.prepare("SELECT COUNT(*) AS c FROM contents WHERE status='pending'").get().c,
    approved: db.prepare("SELECT COUNT(*) AS c FROM contents WHERE status='approved'").get().c,
    rejected: db.prepare("SELECT COUNT(*) AS c FROM contents WHERE status='rejected'").get().c,
    published: db.prepare("SELECT COUNT(*) AS c FROM contents WHERE status='published'").get().c,
    publish_failed: db.prepare("SELECT COUNT(*) AS c FROM contents WHERE status='publish_failed'").get().c,
  };
}

function formatDt(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

app.locals.formatDt = formatDt;

// ── 페이지 라우트 ─────────────────────────────────────────────────

// GET / - 목록
app.get('/', (req, res) => {
  const status = ['pending','approved','rejected','published','publish_failed'].includes(req.query.status)
    ? req.query.status : 'pending';
  const perPage = [10, 20, 30, 40, 50, 100].includes(Number(req.query.per)) ? Number(req.query.per) : 20;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const total = db.prepare('SELECT COUNT(*) AS c FROM contents WHERE status = ?').get(status).c;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const offset = (page - 1) * perPage;
  const contents = db.prepare(
    'SELECT * FROM contents WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(status, perPage, offset);
  res.render('index', { contents, status, counts: counts(), page, totalPages, perPage, total });
});

// GET /contents/:id - 상세
app.get('/contents/:id', (req, res) => {
  const content = db.prepare('SELECT * FROM contents WHERE id = ?').get(req.params.id);
  if (!content) return res.status(404).send('콘텐츠를 찾을 수 없습니다.');
  res.render('detail', { content, counts: counts() });
});

// POST /contents/:id/save - 본문 수정
app.post('/contents/:id/save', (req, res) => {
  const { title, body, hashtags } = req.body;
  db.prepare(`
    UPDATE contents
    SET title = ?, body = ?, hashtags = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title, body, hashtags, req.params.id);
  res.redirect('/contents/' + req.params.id + '?saved=1');
});

// POST /contents/:id/approve - 승인 → n8n 웹훅 호출
app.post('/contents/:id/approve', async (req, res) => {
  const content = db.prepare('SELECT * FROM contents WHERE id = ?').get(req.params.id);
  if (!content) return res.status(404).send('Not found');

  try {
    const webhookUrl = process.env.N8N_APPROVE_WEBHOOK ||
      'https://n8n.bestrealinfo.com/webhook/content-approve';
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id:        content.id,
        title:     content.title,
        body:      content.body,
        hashtags:  content.hashtags,
        product:   content.product,
        requester: content.requester,
        platform:  content.platform,
        image_url: content.image_url || null,
      }),
    });
    console.log('[approve] content ' + content.id + ' -> n8n webhook OK');
  } catch (err) {
    console.error('[approve] webhook error:', err.message);
  }

  const current = db.prepare('SELECT status FROM contents WHERE id = ?').get(req.params.id);
  if (current && current.status !== 'published') {
    db.prepare("UPDATE contents SET status='approved', updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(req.params.id);
  }

  res.redirect('/?status=approved');
});

// POST /contents/:id/reject - 거절
app.post('/contents/:id/reject', (req, res) => {
  db.prepare("UPDATE contents SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(req.params.id);
  res.redirect('/?status=rejected');
});

// POST /contents/:id/republish - 재발행 (발행실패/승인완료 → 다시 Threads 발행)
app.post('/contents/:id/republish', async (req, res) => {
  const content = db.prepare('SELECT * FROM contents WHERE id = ?').get(req.params.id);
  if (!content) return res.status(404).send('Not found');

  // 상태를 approved로 리셋 (발행 중 상태)
  db.prepare("UPDATE contents SET status='approved', publish_message=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(req.params.id);

  try {
    const webhookUrl = process.env.N8N_APPROVE_WEBHOOK ||
      'https://n8n.bestrealinfo.com/webhook/content-approve';
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id:        content.id,
        title:     content.title,
        body:      content.body,
        hashtags:  content.hashtags,
        product:   content.product,
        requester: content.requester,
        platform:  content.platform,
        image_url: content.image_url || null,
      }),
    });
    console.log('[republish] content ' + content.id + ' -> n8n webhook OK');
  } catch (err) {
    console.error('[republish] webhook error:', err.message);
  }

  res.redirect('/contents/' + req.params.id);
});

// POST /contents/:id/delete - 개별 삭제
app.post('/contents/:id/delete', (req, res) => {
  const content = db.prepare('SELECT * FROM contents WHERE id = ?').get(req.params.id);
  if (!content) return res.status(404).send('Not found');
  const status = content.status;
  db.prepare('DELETE FROM contents WHERE id = ?').run(req.params.id);
  console.log('[delete] content ' + req.params.id + ' deleted');
  res.redirect('/?status=' + status);
});

// POST /contents/bulk-delete - 일괄 삭제
app.post('/contents/bulk-delete', (req, res) => {
  const ids = req.body.ids;
  const status = req.body.status || 'pending';
  if (!ids || !ids.length) return res.redirect('/?status=' + status);
  const placeholders = ids.map(() => '?').join(',');
  const result = db.prepare('DELETE FROM contents WHERE id IN (' + placeholders + ')').run(...ids.map(Number));
  console.log('[bulk-delete] deleted ' + result.changes + ' contents');
  res.redirect('/?status=' + status);
});


// POST /contents/create - 대시보드에서 직접 글 작성
app.post('/contents/create', upload.array('images', 10), (req, res) => {
  const { title, body, hashtags, product, requester, platform } = req.body;
  if (!title || !title.trim()) return res.redirect('/?error=title');

  const baseUrl = process.env.DASHBOARD_URL || 'https://dash.bestrealinfo.com';
  const imageUrls = req.files && req.files.length
    ? req.files.map(f => baseUrl + '/uploads/' + f.filename).join(', ')
    : null;

  const result = db.prepare(`
    INSERT INTO contents (title, body, hashtags, product, requester, platform, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    title.trim(),
    body || '',
    hashtags || '',
    product || '',
    requester || '',
    platform || '인스타그램',
    imageUrls
  );
  console.log('[create] manual content id=' + result.lastInsertRowid + ' images=' + (req.files ? req.files.length : 0));
  res.redirect('/contents/' + result.lastInsertRowid);
});

// POST /contents/:id/image - 이미지 수동 업로드 및 등록
app.post('/contents/:id/image', upload.array('images', 10), (req, res) => {
  const content = db.prepare('SELECT * FROM contents WHERE id = ?').get(req.params.id);
  if (!content) return res.status(404).send('Not found');

  const baseUrl = process.env.DASHBOARD_URL || 'https://dash.bestrealinfo.com';
  const newUrls = req.files.map(f => baseUrl + '/uploads/' + f.filename);

  const existing = content.image_url ? content.image_url.split(',').map(u => u.trim()).filter(Boolean) : [];
  const merged = [...existing, ...newUrls].join(', ');

  db.prepare('UPDATE contents SET image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(merged, req.params.id);

  console.log('[image] id=' + req.params.id + ' added ' + newUrls.length + ' images');
  res.redirect('/contents/' + req.params.id);
});

// ── API 라우트 ────────────────────────────────────────────────────


// POST /contents/:id/image/delete - 이미지 개별 삭제 (DB + 실제 파일)
app.post('/contents/:id/image/delete', (req, res) => {
  const content = db.prepare('SELECT * FROM contents WHERE id = ?').get(req.params.id);
  if (!content) return res.status(404).send('Not found');

  const targetUrl = req.body.url;

  // 실제 파일 삭제
  try {
    const filename = targetUrl.split('/uploads/')[1];
    if (filename) {
      const filePath = path.join(__dirname, 'public', 'uploads', filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log('[image-delete] file removed: ' + filePath);
      }
    }
  } catch (err) {
    console.error('[image-delete] file delete error:', err.message);
  }

  // DB 업데이트
  const remaining = content.image_url
    ? content.image_url.split(',').map(u => u.trim()).filter(u => u && u !== targetUrl)
    : [];

  db.prepare('UPDATE contents SET image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(remaining.length ? remaining.join(', ') : null, req.params.id);

  console.log('[image-delete] id=' + req.params.id + ' removed: ' + targetUrl);
  res.redirect('/contents/' + req.params.id);
});

// POST /api/upload - 이미지 업로드
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '이미지 파일 필요' });

  const baseUrl = process.env.DASHBOARD_URL || 'https://dash.bestrealinfo.com';
  const imageUrl = baseUrl + '/uploads/' + req.file.filename;

  console.log('[upload] ' + req.file.originalname + ' -> ' + imageUrl);
  res.json({ success: true, imageUrl: imageUrl, filename: req.file.filename });
});

// POST /api/contents - n8n에서 콘텐츠 저장
app.post('/api/contents', (req, res) => {
  const { title, body, hashtags, product, requester, platform, image_url } = req.body;

  const hashtagStr = Array.isArray(hashtags)
    ? hashtags.join(' ')
    : (hashtags || '');

  const result = db.prepare(`
    INSERT INTO contents (title, body, hashtags, product, requester, platform, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    title || product || '제목 없음',
    body || '',
    hashtagStr,
    product || '',
    requester || '',
    platform || '인스타그램',
    image_url || null
  );

  console.log('[api] content saved id=' + result.lastInsertRowid + ' product="' + product + '" image=' + (image_url ? 'yes' : 'no'));
  res.json({ success: true, id: result.lastInsertRowid });
});

// POST /api/contents/status - n8n에서 발행 상태 업데이트
app.post('/api/contents/status', (req, res) => {
  const { id, status, threadId, message } = req.body;
  if (!id) return res.status(400).json({ error: 'id 필요' });

  const validStatuses = ['published', 'publish_failed', 'approved', 'pending', 'rejected'];
  const newStatus = validStatuses.includes(status) ? status : 'approved';

  db.prepare(`
    UPDATE contents
    SET status = ?, thread_id = ?, publish_message = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newStatus, threadId || null, message || null, id);

  console.log('[status] id=' + id + ' -> ' + newStatus + ' threadId=' + (threadId || 'none'));
  res.json({ success: true, id: id, status: newStatus });
});

// GET /api/contents - 목록 (JSON)
app.get('/api/contents', (req, res) => {
  const status = req.query.status || 'pending';
  const list = db.prepare('SELECT * FROM contents WHERE status = ? ORDER BY created_at DESC').all(status);
  res.json({ success: true, data: list });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('[Dashboard] Running on port ' + PORT);
});
