const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PASSWORD_FILE = path.join(DATA_DIR, '.password-hash');
const INITIAL_PASSWORD_FILE = path.join(DATA_DIR, 'initial-password.txt');

function loadEnvFile() {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile();

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 262144000);
const MAX_BODY_BYTES = MAX_FILE_BYTES + 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.xml', '.log', '.js', '.jsx', '.ts', '.tsx', '.css', '.html', '.htm', '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.rb', '.sh', '.ps1', '.sql', '.yaml', '.yml', '.toml', '.ini', '.conf']);
const sessions = new Map();
const loginAttempts = new Map();
let db = { topics: [], entries: [] };
let writeQueue = Promise.resolve();

function id() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function ensureDirectories() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ topics: [], entries: [] }, null, 2));
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = {
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      entries: Array.isArray(parsed.entries) ? parsed.entries : []
    };
  } catch {
    db = { topics: [], entries: [] };
  }
  if (!db.topics.length) {
    db.topics.push({ id: id(), name: '未分类', createdAt: now(), updatedAt: now(), system: true });
    persist();
  }
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writeQueue = writeQueue
    .then(() => fsp.writeFile(`${DB_FILE}.tmp`, snapshot, 'utf8'))
    .then(() => fsp.rename(`${DB_FILE}.tmp`, DB_FILE))
    .catch((error) => console.error('Failed to persist database:', error));
  return writeQueue;
}

function setupPassword() {
  const configured = process.env.APP_PASSWORD;
  if (configured) {
    const salt = crypto.createHash('sha256').update('personal-transfer-hub-runtime-salt').digest();
    return { salt, hash: crypto.scryptSync(configured, salt, 64) };
  }
  if (fs.existsSync(PASSWORD_FILE)) {
    const [saltHex, hashHex] = fs.readFileSync(PASSWORD_FILE, 'utf8').trim().split(':');
    return { salt: Buffer.from(saltHex, 'hex'), hash: Buffer.from(hashHex, 'hex') };
  }
  const password = crypto.randomBytes(18).toString('base64url');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  fs.writeFileSync(PASSWORD_FILE, `${salt.toString('hex')}:${hash.toString('hex')}\n`);
  fs.writeFileSync(INITIAL_PASSWORD_FILE, `${password}\n`);
  console.log(`\nFirst-run password created. Read ${INITIAL_PASSWORD_FILE} and remove it after saving the password.\n`);
  return { salt, hash };
}

ensureDirectories();
const passwordVerifier = setupPassword();

function verifyPassword(password) {
  if (typeof password !== 'string' || password.length < 8) return false;
  const candidate = crypto.scryptSync(password, passwordVerifier.salt, 64);
  return crypto.timingSafeEqual(candidate, passwordVerifier.hash);
}

function parseCookies(header) {
  return Object.fromEntries((header || '').split(';').map((part) => part.trim().split('=')) .filter(([key, value]) => key && value).map(([key, ...rest]) => [key, decodeURIComponent(rest.join('='))]));
}

function isSecureRequest(req) {
  return process.env.COOKIE_SECURE === '1' || (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https');
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...headers
  });
  res.end(payload);
}

function json(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function error(res, status, message) {
  json(res, status, { error: message });
}

function securityHeaders(req) {
  const headers = {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  if (isSecureRequest(req)) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

function authenticated(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return false;
  const expires = sessions.get(token);
  if (!expires || expires < Date.now()) {
    sessions.delete(token);
    return false;
  }
  sessions.set(token, Date.now() + 1000 * 60 * 60 * 24 * 30);
  return true;
}

function requireAuth(req, res) {
  if (authenticated(req)) return true;
  error(res, 401, '请先输入访问密钥');
  return false;
}

function setSession(res, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + 1000 * 60 * 60 * 24 * 30);
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
}

function clearSession(req, res) {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function collectBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => tooLarge ? reject(Object.assign(new Error('内容过大'), { code: 'LIMIT' })) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buffer) {
  try { return JSON.parse(buffer.toString('utf8')); } catch { return null; }
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new Error('无效的上传格式');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let cursor = 0;
  while (true) {
    const start = buffer.indexOf(boundary, cursor);
    if (start === -1) break;
    const after = start + boundary.length;
    if (buffer.slice(after, after + 2).toString() === '--') break;
    const contentStart = after + 2;
    const next = buffer.indexOf(boundary, contentStart);
    if (next === -1) break;
    const part = buffer.slice(contentStart, next - 2);
    const separator = part.indexOf(Buffer.from('\r\n\r\n'));
    if (separator !== -1) {
      const rawHeaders = part.slice(0, separator).toString('utf8');
      const content = part.slice(separator + 4);
      const disposition = /Content-Disposition:.*?name="([^"]+)"(?:; filename="([^"]*)")?/i.exec(rawHeaders);
      if (disposition) {
        parts.push({ name: disposition[1], filename: disposition[2] || '', contentType: (/Content-Type:\s*([^\r\n]+)/i.exec(rawHeaders) || [])[1] || 'application/octet-stream', content });
      }
    }
    cursor = next;
  }
  return parts;
}

function cleanFileName(name) {
  const cleaned = String(name || '未命名文件').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (cleaned || '未命名文件').slice(0, 180);
}

function isTextLikeEntry(entry) {
  return entry.mime.startsWith('text/') || entry.mime === 'application/json' || TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
}

function findTopic(topicId) {
  return db.topics.find((topic) => topic.id === topicId);
}

function publicEntry(entry) {
  const topic = findTopic(entry.topicId);
  return {
    id: entry.id, topicId: entry.topicId, topicName: topic ? topic.name : '未分类', type: entry.type,
    name: entry.name, mime: entry.mime, size: entry.size, content: entry.content, sha256: entry.sha256, createdAt: entry.createdAt,
    updatedAt: entry.updatedAt || null, deletedAt: entry.deletedAt || null
  };
}

function requestedIds(body) {
  return [...new Set(Array.isArray(body && body.ids) ? body.ids.map(String) : [])].slice(0, 500);
}

function fallbackTopic() {
  return db.topics.find((item) => item.system) || db.topics[0];
}

async function removeStoredFiles(entries) {
  await Promise.all(entries.filter((entry) => entry.storageName).map((entry) => fsp.rm(path.join(UPLOAD_DIR, entry.storageName), { force: true })));
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });

  if (pathname === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    const attempt = loginAttempts.get(ip) || { count: 0, since: Date.now(), blockedUntil: 0 };
    if (attempt.blockedUntil > Date.now()) return error(res, 429, '尝试次数过多，请稍后再试');
    if (Date.now() - attempt.since > 15 * 60 * 1000) { attempt.count = 0; attempt.since = Date.now(); }
    let body;
    try { body = parseJsonBody(await collectBody(req, 1024 * 32)); } catch { return error(res, 400, '请求无效'); }
    if (!body || !verifyPassword(body.password)) {
      attempt.count += 1;
      if (attempt.count >= 5) attempt.blockedUntil = Date.now() + 15 * 60 * 1000;
      loginAttempts.set(ip, attempt);
      return error(res, 401, '访问密钥不正确');
    }
    loginAttempts.delete(ip);
    setSession(res, req);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/session' && req.method === 'GET') return json(res, 200, { authenticated: authenticated(req) });
  if (pathname === '/api/logout' && req.method === 'POST') { clearSession(req, res); return json(res, 200, { ok: true }); }
  if (!requireAuth(req, res)) return;

  if (pathname === '/api/bootstrap' && req.method === 'GET') {
    return json(res, 200, { topics: db.topics, entries: db.entries.map(publicEntry) });
  }

  if (pathname === '/api/topics' && req.method === 'POST') {
    let body;
    try { body = parseJsonBody(await collectBody(req, 1024 * 32)); } catch { return error(res, 400, '请求无效'); }
    const name = String(body && body.name || '').trim().slice(0, 60);
    if (!name) return error(res, 400, '分类名称不能为空');
    if (db.topics.some((topic) => topic.name.toLowerCase() === name.toLowerCase())) return error(res, 409, '分类已存在');
    const topic = { id: id(), name, createdAt: now(), updatedAt: now() };
    db.topics.push(topic); await persist(); return json(res, 201, topic);
  }

  const topicMatch = pathname.match(/^\/api\/topics\/([^/]+)$/);
  if (topicMatch && req.method === 'PATCH') {
    const topic = findTopic(topicMatch[1]);
    if (!topic) return error(res, 404, '分类不存在');
    let body;
    try { body = parseJsonBody(await collectBody(req, 1024 * 32)); } catch { return error(res, 400, '请求无效'); }
    const name = String(body && body.name || '').trim().slice(0, 60);
    if (!name) return error(res, 400, '分类名称不能为空');
    topic.name = name; topic.updatedAt = now(); await persist(); return json(res, 200, topic);
  }

  if (topicMatch && req.method === 'DELETE') {
    const topic = findTopic(topicMatch[1]);
    if (!topic) return error(res, 404, '分类不存在');
    if (topic.system) return error(res, 400, '默认分类不能删除');
    const fallback = db.topics.find((item) => item.system) || db.topics[0];
    db.entries.filter((entry) => entry.topicId === topic.id).forEach((entry) => { entry.topicId = fallback.id; });
    db.topics = db.topics.filter((item) => item.id !== topic.id);
    await persist(); return json(res, 200, { ok: true, movedTo: fallback.id });
  }

  const noteMatch = pathname.match(/^\/api\/topics\/([^/]+)\/notes$/);
  if (noteMatch && req.method === 'POST') {
    if (!findTopic(noteMatch[1])) return error(res, 404, '分类不存在');
    let body;
    try { body = parseJsonBody(await collectBody(req, 1024 * 1024)); } catch { return error(res, 400, '请求无效'); }
    const content = String(body && body.content || '').trim();
    if (!content) return error(res, 400, '文字内容不能为空');
    if (content.length > 20000) return error(res, 400, '文字内容不能超过 20000 字');
    const noteName = (content.split(/\n/).map((line) => line.trim()).find(Boolean) || '文字记录').slice(0, 60);
    const entry = { id: id(), topicId: noteMatch[1], type: 'note', name: noteName, mime: 'text/plain', size: Buffer.byteLength(content), content, createdAt: now() };
    db.entries.push(entry); await persist(); return json(res, 201, publicEntry(entry));
  }

  const fileMatch = pathname.match(/^\/api\/topics\/([^/]+)\/files$/);
  if (fileMatch && req.method === 'POST') {
    if (!findTopic(fileMatch[1])) return error(res, 404, '分类不存在');
    const length = Number(req.headers['content-length'] || 0);
    if (length > MAX_BODY_BYTES) return error(res, 413, `单个文件不能超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`);
    let body;
    try { body = await collectBody(req, MAX_BODY_BYTES); } catch (caught) { return error(res, caught.code === 'LIMIT' ? 413 : 400, caught.message); }
    let parts;
    try { parts = parseMultipart(body, req.headers['content-type']); } catch (caught) { return error(res, 400, caught.message); }
    const files = parts.filter((part) => part.name === 'file' && part.filename);
    if (!files.length) return error(res, 400, '没有找到文件');
    const created = [];
    for (const file of files) {
      if (file.content.length > MAX_FILE_BYTES) return error(res, 413, `${file.filename} 超过大小限制`);
      const entryId = id();
      const storageName = `${entryId}.bin`;
      await fsp.writeFile(path.join(UPLOAD_DIR, storageName), file.content);
      const entry = { id: entryId, topicId: fileMatch[1], type: 'file', name: cleanFileName(file.filename), mime: file.contentType || 'application/octet-stream', size: file.content.length, storageName, sha256: crypto.createHash('sha256').update(file.content).digest('hex'), createdAt: now() };
      db.entries.push(entry); created.push(publicEntry(entry));
    }
    await persist(); return json(res, 201, { files: created });
  }

  if (pathname === '/api/entries/move' && req.method === 'POST') {
    let body;
    try { body = parseJsonBody(await collectBody(req, 1024 * 64)); } catch { return error(res, 400, '请求无效'); }
    const ids = [...new Set(Array.isArray(body && body.ids) ? body.ids.map(String) : [])].slice(0, 500);
    const topic = findTopic(body && body.topicId);
    if (!ids.length) return error(res, 400, '没有选择记录');
    if (!topic) return error(res, 404, '分类不存在');
    const updated = [];
    ids.forEach((entryId) => {
      const entry = db.entries.find((item) => item.id === entryId);
      if (!entry) return;
      entry.topicId = topic.id;
      updated.push(publicEntry(entry));
    });
    if (!updated.length) return error(res, 404, '记录不存在');
    await persist();
    return json(res, 200, { entries: updated });
  }

  if ((pathname === '/api/entries/trash' || pathname === '/api/entries/delete') && req.method === 'POST') {
    let body;
    try { body = parseJsonBody(await collectBody(req, 1024 * 64)); } catch { return error(res, 400, '请求无效'); }
    const ids = requestedIds(body);
    if (!ids.length) return error(res, 400, '没有选择记录');
    const updated = [];
    ids.forEach((entryId) => {
      const entry = db.entries.find((item) => item.id === entryId);
      if (!entry || entry.deletedAt) return;
      entry.deletedAt = now();
      updated.push(publicEntry(entry));
    });
    if (!updated.length) return error(res, 404, '记录不存在');
    await persist();
    return json(res, 200, { entries: updated });
  }

  if (pathname === '/api/entries/restore' && req.method === 'POST') {
    let body;
    try { body = parseJsonBody(await collectBody(req, 1024 * 64)); } catch { return error(res, 400, '请求无效'); }
    const ids = requestedIds(body);
    if (!ids.length) return error(res, 400, '没有选择记录');
    const fallback = fallbackTopic();
    const updated = [];
    let relocated = 0;
    ids.forEach((entryId) => {
      const entry = db.entries.find((item) => item.id === entryId);
      if (!entry || !entry.deletedAt) return;
      if (!findTopic(entry.topicId)) { entry.topicId = fallback.id; relocated += 1; }
      delete entry.deletedAt;
      updated.push(publicEntry(entry));
    });
    if (!updated.length) return error(res, 404, '记录不存在');
    await persist();
    return json(res, 200, { entries: updated, relocated });
  }

  if (pathname === '/api/entries/purge' && req.method === 'POST') {
    let body;
    try { body = parseJsonBody(await collectBody(req, 1024 * 64)); } catch { return error(res, 400, '请求无效'); }
    const ids = new Set(requestedIds(body));
    if (!ids.size) return error(res, 400, '没有选择记录');
    const removed = db.entries.filter((entry) => ids.has(entry.id) && entry.deletedAt);
    if (!removed.length) return error(res, 404, '记录不存在');
    await removeStoredFiles(removed);
    const removedIds = new Set(removed.map((entry) => entry.id));
    db.entries = db.entries.filter((entry) => !removedIds.has(entry.id));
    await persist();
    return json(res, 200, { ids: [...removedIds] });
  }

  if (pathname === '/api/trash/empty' && req.method === 'POST') {
    const removed = db.entries.filter((entry) => entry.deletedAt);
    await removeStoredFiles(removed);
    db.entries = db.entries.filter((entry) => !entry.deletedAt);
    await persist();
    return json(res, 200, { ids: removed.map((entry) => entry.id) });
  }

  const entryMatch = pathname.match(/^\/api\/entries\/([^/]+)$/);
  if (entryMatch && req.method === 'PATCH') {
    const entry = db.entries.find((item) => item.id === entryMatch[1]);
    if (!entry) return error(res, 404, '记录不存在');
    if (entry.deletedAt) return error(res, 400, '废纸篓里的记录不能修改');
    if (entry.type !== 'note') return error(res, 400, '只能修改文字记录');
    let body;
    try { body = parseJsonBody(await collectBody(req, 1024 * 1024)); } catch { return error(res, 400, '请求无效'); }
    const content = String(body && body.content || '').trim();
    if (!content) return error(res, 400, '文字内容不能为空');
    if (content.length > 20000) return error(res, 400, '文字内容不能超过 20000 字');
    if (content === entry.content) return json(res, 200, publicEntry(entry));
    entry.content = content;
    entry.size = Buffer.byteLength(content);
    entry.name = (content.split(/\n/).map((line) => line.trim()).find(Boolean) || '文字记录').slice(0, 60);
    entry.updatedAt = now();
    await persist();
    return json(res, 200, publicEntry(entry));
  }

  if (entryMatch && req.method === 'DELETE') {
    const entry = db.entries.find((item) => item.id === entryMatch[1]);
    if (!entry) return error(res, 404, '记录不存在');
    if (!entry.deletedAt) { entry.deletedAt = now(); await persist(); }
    return json(res, 200, { ok: true, trashed: true });
  }

  const downloadMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (downloadMatch && req.method === 'GET') {
    const entry = db.entries.find((item) => item.id === downloadMatch[1] && item.type === 'file');
    if (!entry) return error(res, 404, '文件不存在');
    const filePath = path.join(UPLOAD_DIR, entry.storageName);
    if (!fs.existsSync(filePath)) return error(res, 410, '文件内容已丢失');
    const inline = url.searchParams.get('inline') === '1' && (/^image\//.test(entry.mime) || isTextLikeEntry(entry) || entry.mime === 'application/pdf');
    const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(entry.name)}`;
    res.writeHead(200, { 'Content-Type': entry.mime || 'application/octet-stream', 'Content-Length': entry.size, 'Content-Disposition': disposition, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', ...securityHeaders(req) });
    return fs.createReadStream(filePath).pipe(res);
  }

  return error(res, 404, '接口不存在');
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon' })[ext] || 'application/octet-stream';
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return error(res, 404, '页面不存在');
  const body = await fsp.readFile(filePath);
  send(res, 200, body, { 'Content-Type': mimeType(filePath), 'Cache-Control': 'no-store', ...securityHeaders(req) });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else if (req.method === 'GET') {
      await serveStatic(req, res, url);
    } else {
      error(res, 405, '方法不允许');
    }
  } catch (caught) {
    console.error(caught);
    if (!res.headersSent) error(res, 500, '服务器内部错误'); else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Personal Transfer Hub listening at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Persistent data directory: ${DATA_DIR}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
