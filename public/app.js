const state = { topics: [], entries: [], selected: 'all', search: '' };
const pending = [];
const selection = { active: false, ids: new Set(), moveIds: [] };
const expandedNotes = new Set();
let sending = false;
let editingNoteId = null;
let editingDraft = '';
let focusEditor = false;
let knownSignature = '';
let refreshToken = 0;
const MAX_FILE_BYTES = 250 * 1024 * 1024;
let lastCopiedImage = null;
let copyingImage = false;
document.addEventListener('copy', () => { if (!copyingImage) lastCopiedImage = null; }, true);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'xml', 'log', 'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'htm', 'py', 'java', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'sh', 'ps1', 'sql', 'yaml', 'yml', 'toml', 'ini', 'conf']);
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function showToast(message, isError = false) {
  const toast = $('#toast'); toast.textContent = message; toast.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (response.status === 401 && path !== '/api/login') { location.reload(); throw new Error('访问已失效'); }
  if (!response.ok) throw new Error(data?.error || '请求失败');
  return data;
}

function formatSize(size) {
  if (!size) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB']; let value = size; let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(dateString) {
  const date = new Date(dateString); const diff = Date.now() - date.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function entryTimeLabel(entry) {
  if (isTrashed(entry)) return "删除于 " + formatDate(entry.deletedAt);
  if (entry.updatedAt) return "更新于 " + formatDate(entry.updatedAt);
  return formatDate(entry.createdAt);
}


function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}

function selectedTopic() { return state.topics.find((topic) => topic.id === state.selected); }

function isTrashed(entry) { return Boolean(entry && entry.deletedAt); }

function visibleEntries() {
  const query = state.search.trim().toLowerCase();
  const inTrash = state.selected === 'trash';
  return state.entries.filter((entry) => {
    if (inTrash !== isTrashed(entry)) return false;
    if (!inTrash && state.selected !== 'all' && entry.topicId !== state.selected) return false;
    return !query || `${entry.name} ${entry.content || ''} ${entry.topicName}`.toLowerCase().includes(query);
  }).sort((a, b) => entrySortTime(b, inTrash) - entrySortTime(a, inTrash));
}

function entrySortTime(entry, inTrash) {
  const value = inTrash ? entry.deletedAt : (entry.updatedAt || entry.createdAt);
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;

}

function renderTopics() {
  const active = state.entries.filter((entry) => !isTrashed(entry));
  $('#topic-list').innerHTML = `<button class="topic-item ${state.selected === 'all' ? 'active' : ''}" data-topic="all"><span class="topic-icon">◈</span><span>全部记录</span><span class="topic-count">${active.length || ''}</span></button>` + state.topics.map((topic) => `<button class="topic-item ${state.selected === topic.id ? 'active' : ''}" data-topic="${topic.id}"><span class="topic-icon">${topic.system ? '⌂' : '◇'}</span><span>${escapeHtml(topic.name)}</span><span class="topic-count">${active.filter((entry) => entry.topicId === topic.id).length || ''}</span></button>`).join('');
  $$('#topic-list [data-topic]').forEach((button) => button.addEventListener('click', () => selectTopic(button.dataset.topic)));
  const trash = $('#trash-link');
  if (trash) trash.classList.toggle('active', state.selected === 'trash');
  const trashCount = $('#trash-count');
  if (trashCount) trashCount.textContent = state.entries.filter(isTrashed).length || '';
}

function renderHeader() {
  const inTrash = state.selected === 'trash';
  const topic = selectedTopic();
  const title = inTrash ? '废纸篓' : topic ? topic.name : '全部记录';
  const count = visibleEntries().length;
  $('#topic-title').textContent = title; $('#hero-title').textContent = title;
  $('#topic-eyebrow').textContent = inTrash ? 'TRASH' : topic ? 'TOPIC SPACE' : 'ALL RECORDS';
  $('#hero-subtitle').textContent = inTrash ? '删除的记录会留在这里，可以还原。清空后才会真正消失。' : topic ? `${count} 条记录会持续保存在这个分类里。` : '所有分类里的内容都会留在这里。';
  $('#record-count').textContent = `${count} 条`;
  const feedLabel = $('#feed-label');
  if (feedLabel) feedLabel.textContent = inTrash ? '最近删除' : '最近记录';
  const search = $('#search-input');
  if (search) search.placeholder = inTrash ? '搜索废纸篓' : '搜索记录';
  const trashCount = state.entries.filter(isTrashed).length;
  $('#topic-actions').innerHTML = inTrash
    ? (trashCount ? '<button id="empty-trash" class="text-button danger" type="button">清空废纸篓</button>' : '')
    : topic && !topic.system ? '<button id="rename-topic" class="text-button">重命名</button><button id="delete-topic" class="text-button">删除分类</button>' : '';
  $('#rename-topic')?.addEventListener('click', renameTopic);
  $('#delete-topic')?.addEventListener('click', deleteTopic);
  $('#empty-trash')?.addEventListener('click', () => { emptyTrash().catch((error) => showToast(error.message, true)); });
}

function entryIcon(entry) {
  if (entry.type === 'note') return '✎';
  if (entry.mime?.startsWith('image/')) return '<svg class="image-glyph" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7.6 4.7h4.2c.8 0 1.3.5 1.5 1.1l.6 1.3h4.6c1.6 0 2.7 1.2 2.7 2.7v7.6c0 1.6-1.1 2.8-2.7 2.8H5.5c-1.6 0-2.7-1.2-2.7-2.8V9.8c0-1.5 1.1-2.7 2.7-2.7h1.5l.6-1.3c.2-.6.7-1.1 1.5-1.1z"/><circle cx="12" cy="13.3" r="3.55" fill="#fff"/><circle cx="12" cy="13.3" r="1.7" fill="currentColor"/><circle cx="17.5" cy="9.8" r="1" fill="#f0b429"/></svg>';
  if (entry.mime?.includes('pdf')) return '▤';
  if (entry.mime?.includes('zip') || String(entry.name || "").match(/\.(zip|rar|7z)$/i)) return '◫';
  return '▱';
}

function canPreview(entry) {
  const extension = entry.name?.split('.').pop()?.toLowerCase();
  return entry.type === 'file' && (entry.mime?.startsWith('image/') || entry.mime?.startsWith('text/') || entry.mime === 'application/json' || entry.mime === 'application/pdf' || TEXT_EXTENSIONS.has(extension));
}


function noteTitle(content) {
  const line = String(content || '').split('\n').map((item) => item.trim()).find(Boolean) || '文字记录';
  return line.length > 36 ? `${line.slice(0, 36)}…` : line;
}

function noteBody(content) {
  const text = String(content || '').trim();
  if (!text) return '';
  const lines = text.split('\n');
  const rest = lines.slice(1).join('\n').trim();
  if (rest) return rest;
  return lines[0].trim().length > 36 ? text : '';
}

function saveTargetName() {
  if (!state.topics.length) return '未分类';
  return state.topics.find((topic) => topic.id === currentTopicId())?.name || '未分类';
}

function renderUsage() {
  const label = $('#usage-label');
  if (!label) return;
  const active = state.entries.filter((entry) => !isTrashed(entry)).reduce((sum, entry) => sum + (Number(entry.size) || 0), 0);
  const trashed = state.entries.filter(isTrashed).reduce((sum, entry) => sum + (Number(entry.size) || 0), 0);
  label.textContent = trashed ? `内容 ${formatSize(active)} · 废纸篓 ${formatSize(trashed)}` : `内容 ${formatSize(active)}`;
}

function renderEmpty(count) {
  const box = $('#empty-state');
  box.hidden = count !== 0;
  const title = box.querySelector('h3');
  const detail = box.querySelector('p');
  if (state.search.trim()) {
    title.textContent = '没有找到记录';
    detail.textContent = '换个关键词试试。';
  } else if (state.selected === 'trash') {
    title.textContent = '废纸篓是空的';
    detail.textContent = '删除的记录会先放在这里，还原后回到原来的分类。';
  } else {
    title.textContent = state.selected === 'all' ? '还没有记录' : '这个分类还没有记录';
    detail.textContent = '把一段文字或一个文件放进来，它会一直留在你的空间里。';
  }
}

function renderNoteExtra(entry) {
  if (editingNoteId === entry.id) {
    return `<div class="note-editor"><textarea class="note-edit" rows="4">${escapeHtml(editingDraft)}</textarea><div class="note-edit-actions"><button class="text-button note-save" type="button">保存</button><button class="text-button note-cancel" type="button">取消</button></div></div>`;
  }
  const body = noteBody(entry.content);
  if (!body) return '';
  const long = body.length > 160 || body.split('\n').length > 4;
  const open = expandedNotes.has(entry.id);
  return `<p class="entry-content${long && !open ? ' clamped' : ''}">${escapeHtml(body)}</p>${long ? `<button class="text-button note-expand" type="button">${open ? '收起' : '展开'}</button>` : ''}`;
}

function prefersSideDownload() {
  return window.matchMedia("(hover: none), (pointer: coarse)").matches;
}

function entryPlainText(entry) {
  return String(entry.content || "").trim();
}

function sideIsDownload(entry) {
  return entry.type === "file" && !entryPlainText(entry) && prefersSideDownload();
}

function renderFeed() {
  const entries = visibleEntries();
  const feed = $("#feed");
  renderEmpty(entries.length);
  feed.innerHTML = entries.map((entry) => {
    const isNote = entry.type === "note";
    const isImage = Boolean(entry.mime && entry.mime.startsWith("image/"));
    const title = isNote ? noteTitle(entry.content) : entry.name;
    const checked = selection.ids.has(entry.id);
    const downloadSide = sideIsDownload(entry);
    const copyHint = isNote || entryPlainText(entry) ? "复制文字" : isImage ? "复制图片" : "复制内容";
    const side = selection.active
      ? ""
      : downloadSide
        ? `<div class="entry-side"><a class="side-button" href="/api/files/${entry.id}" download="${escapeHtml(entry.name)}" title="下载到设备">下载</a></div>`
        : `<div class="entry-side"><button class="side-button copy-button" type="button" title="${copyHint}">复制</button></div>`;
    const inTrash = isTrashed(entry);
    const edit = isNote && !inTrash ? '<button class="entry-action edit" type="button" title="编辑">编辑</button>' : "";
    const classify = inTrash ? "" : '<button class="entry-action classify" type="button" title="分类">分类</button>';
    const restore = inTrash ? '<button class="entry-action restore" type="button" title="还原">还原</button>' : "";
    const preview = !isNote && canPreview(entry) ? '<button class="entry-action preview" type="button" title="预览">预览</button>' : "";
    const rowDownload = !isNote && !downloadSide ? `<a class="entry-action" href="/api/files/${entry.id}" download title="下载">下载</a>` : "";
    const remove = inTrash ? '<button class="entry-action delete" type="button" title="永久删除">永久删除</button>' : '<button class="entry-action delete" type="button" title="删除">删除</button>';
    return `<article class="entry-card card${selection.active ? " selecting" : ""}${checked ? " selected" : ""}" data-entry="${entry.id}">
      ${selection.active ? `<label class="entry-check"><input type="checkbox" ${checked ? "checked" : ""} aria-label="选择记录" /></label>` : ""}
      <div class="entry-icon ${isNote ? "note" : isImage ? "image" : ""}">${entryIcon(entry)}</div>
      <div class="entry-main"><div class="entry-name">${escapeHtml(title)}</div><div class="entry-meta"><span>${entryTimeLabel(entry)}</span><span>·</span><span>${escapeHtml(entry.topicName)}</span>${!isNote ? `<span>·</span><span>${formatSize(entry.size)}</span>` : ""}</div>
      ${isNote ? renderNoteExtra(entry) : ""}${!isNote && isImage ? `<img class="entry-image" src="/api/files/${entry.id}?inline=1" alt="${escapeHtml(entry.name)}" draggable="false" loading="lazy" />` : ""}</div>
      ${side}
      <div class="entry-actions">${edit}${classify}${restore}${preview}${rowDownload}${remove}</div>
    </article>`;
  }).join("");
  $$(".entry-card").forEach((card) => {
    const entry = state.entries.find((item) => item.id === card.dataset.entry);
    card.querySelector(".delete")?.addEventListener("click", () => { if (isTrashed(entry)) purgeEntries([entry.id]); else deleteEntry(entry); });
    card.querySelector(".restore")?.addEventListener("click", () => { restoreEntries([entry.id]).catch((error) => showToast(error.message, true)); });
    card.querySelector(".copy-button")?.addEventListener("click", () => { copyEntry(entry, card).catch((error) => showToast(error.message || "复制失败", true)); });
    card.querySelector(".edit")?.addEventListener("click", () => beginEdit(entry));
    card.querySelector(".classify")?.addEventListener("click", () => openClassify([entry.id]));
    card.querySelector(".preview")?.addEventListener("click", () => previewEntry(entry));
    card.querySelector(".note-expand")?.addEventListener("click", () => { if (expandedNotes.has(entry.id)) expandedNotes.delete(entry.id); else expandedNotes.add(entry.id); renderFeed(); });
    card.querySelector(".note-edit")?.addEventListener("input", (event) => { editingDraft = event.target.value; });
    card.querySelector(".note-save")?.addEventListener("click", () => { saveNote(entry).catch((error) => showToast(error.message, true)); });
    card.querySelector(".note-cancel")?.addEventListener("click", () => { editingNoteId = null; editingDraft = ""; render(); });
    card.querySelector(".entry-image")?.addEventListener("click", (event) => { if (selection.active) return; event.stopPropagation(); previewEntry(entry); });
    card.querySelector(".entry-check input")?.addEventListener("change", (event) => setSelected(entry.id, event.target.checked));
    card.addEventListener("click", (event) => {
      if (!selection.active || event.target.closest("button, a, input, label, textarea")) return;
      const input = card.querySelector(".entry-check input");
      setSelected(entry.id, !selection.ids.has(entry.id));
      if (input) input.checked = selection.ids.has(entry.id);
    });
  });
  if (focusEditor) {
    const editor = $(".note-edit");
    if (editor) { editor.focus(); const end = editor.value.length; editor.setSelectionRange(end, end); }
    focusEditor = false;
  }
}

function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text;
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;width:1px;height:1px;padding:0;border:0;outline:none;box-shadow:none;font-size:16px';
  document.body.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, area.value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  if (!ok) throw new Error('复制失败');
}

function imageCanvas(img) {
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error("图片还在加载，请稍后再试");
  const maxEdge = 2560;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("图片无法复制，请用下载");
  try { context.drawImage(img, 0, 0, canvas.width, canvas.height); }
  catch { throw new Error("图片无法复制，请用下载"); }
  return canvas;
}

function imageCopyName(name) {
  const base = String(name || "图片").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "").trim() || "图片";
  return base + ".png";
}

function pngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片无法复制，请用下载")), "image/png");
  });
}

function copyImageNode(img) {
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNode(img);
  selection.removeAllRanges();
  selection.addRange(range);
  copyingImage = true;
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  selection.removeAllRanges();
  copyingImage = false;
  return ok;
}

async function copyImageElement(img, name) {
  const canvas = imageCanvas(img);
  const remember = (blob) => { lastCopiedImage = new File([blob], imageCopyName(name), { type: "image/png" }); };
  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
    const blobPromise = pngBlob(canvas);
    copyingImage = true;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })]);
      remember(await blobPromise);
      return "png";
    } catch (error) {
      const blocked = error && (error.name === "NotAllowedError" || error.name === "SecurityError");
      throw new Error(blocked ? "浏览器拦截了图片复制，请再点一次" : "图片没放进剪贴板，请用下载");
    } finally { copyingImage = false; }
  }
  if (!copyImageNode(img)) throw new Error("图片没放进剪贴板，请用下载");
  remember(await pngBlob(canvas));
  return "bitmap";
}

function armCopyButton(button) {
  if (button && button.disabled) return false;
  if (button) {
    button.disabled = true;
    button.textContent = "复制中";
  }
  return true;
}

function finishCopyButton(button, ok) {
  if (!button) return;
  button.disabled = false;
  button.textContent = ok ? "已复制" : "复制";
  clearTimeout(button._flash);
  if (ok) button._flash = setTimeout(() => { button.textContent = "复制"; }, 1200);
}

async function copyEntry(entry, card) {
  const button = card.querySelector(".copy-button");
  if (!armCopyButton(button)) return;
  try {
    if (entry.type === "note" || entryPlainText(entry)) {
      await copyText(entry.type === "note" ? (entry.content || "") : entryPlainText(entry));
      finishCopyButton(button, true);
      showToast("已复制");
      return;
    }
    if (entry.mime && entry.mime.startsWith("image/")) {
      const img = card.querySelector(".entry-image");
      if (!img || !img.complete || !img.naturalWidth) throw new Error("图片还在加载，请稍后再试");
      await copyImageElement(img, entry.name);
      finishCopyButton(button, true);
      showToast("图片已复制");
      return;
    }
    if (canPreview(entry) && entry.mime !== "application/pdf") {
      const response = await fetch("/api/files/" + entry.id + "?inline=1", { credentials: "same-origin" });
      if (!response.ok) throw new Error("复制失败");
      await copyText(await response.text());
      finishCopyButton(button, true);
      showToast("已复制");
      return;
    }
    await copyText(new URL("/api/files/" + entry.id, location.origin).href);
    finishCopyButton(button, true);
    showToast("这个文件不能直接粘贴，已复制下载链接");
  } catch (error) {
    finishCopyButton(button, false);
    throw error;
  }
}

function setSelected(id, selected) {
  if (selected) selection.ids.add(id); else selection.ids.delete(id);
  document.querySelector(`[data-entry="${id}"]`)?.classList.toggle('selected', selected);
  renderSelection();
}

function renderSelection() {
  const bar = $("#selection-bar");
  if (!bar) return;
  bar.hidden = !selection.active;
  const toggle = $("#select-toggle");
  if (toggle) {
    toggle.textContent = selection.active ? "完成" : "选择";
    toggle.classList.toggle("active", selection.active);
    toggle.setAttribute("aria-pressed", selection.active ? "true" : "false");
    toggle.setAttribute("aria-label", selection.active ? "完成选择" : "选择记录");
  }
  const visible = visibleEntries();
  const selectedVisible = visible.filter((entry) => selection.ids.has(entry.id)).length;
  const allSelected = visible.length > 0 && selectedVisible === visible.length;
  const box = $("#select-all-box");
  const label = $("#select-all-label");
  if (box) {
    box.disabled = visible.length === 0;
    box.checked = allSelected;
    box.indeterminate = selectedVisible > 0 && !allSelected;
  }
  if (label) label.textContent = allSelected ? "取消全选" : "全选";
  $("#selection-count").textContent = "已选 " + selection.ids.size + " 条";
  const inTrash = state.selected === "trash";
  $("#selection-classify").hidden = inTrash;
  $("#selection-delete").hidden = inTrash;
  $("#selection-restore").hidden = !inTrash;
  $("#selection-purge").hidden = !inTrash;
  $("#selection-classify").disabled = selection.ids.size === 0;
  $("#selection-delete").disabled = selection.ids.size === 0;
  $("#selection-restore").disabled = selection.ids.size === 0;
  $("#selection-purge").disabled = selection.ids.size === 0;
}

function closeClassify() { $('#classify-modal').hidden = true; $('#classify-options').innerHTML = ''; }

function openClassify(ids) {
  if (!ids.length) { showToast('先选择记录', true); return; }
  selection.moveIds = ids;
  const box = $('#classify-options');
  const current = new Set(ids.map((id) => state.entries.find((entry) => entry.id === id)?.topicId).filter(Boolean)); const marked = current.size === 1 ? [...current][0] : ''; box.innerHTML = state.topics.map((topic) => `<button class="classify-option" type="button" data-topic="${topic.id}"><span>${escapeHtml(topic.name)}</span>${topic.id === marked ? '<small>当前</small>' : ''}</button>`).join('') + '<button class="classify-option" type="button" data-new-topic>＋ 新建分类</button>';
  box.querySelectorAll('[data-topic]').forEach((button) => button.addEventListener('click', () => moveEntries(selection.moveIds, button.dataset.topic).catch((error) => showToast(error.message, true)))); box.querySelector('[data-new-topic]').addEventListener('click', () => createAndMove().catch((error) => showToast(error.message, true)));
  $('#classify-modal').hidden = false;
}


async function createAndMove() {
  const name = window.prompt('给新分类起个名字');
  if (!name?.trim()) return;
  refreshToken += 1;
  const topic = await api('/api/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
  state.topics.push(topic);
  rememberState();
  render();
  await moveEntries(selection.moveIds, topic.id);
}

async function moveEntries(ids, topicId) {
  refreshToken += 1;
  const data = await api('/api/entries/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, topicId }) });
  data.entries.forEach((updated) => { const existing = state.entries.find((entry) => entry.id === updated.id); if (existing) Object.assign(existing, updated); });
  ids.forEach((id) => selection.ids.delete(id));
  closeClassify();
  rememberState();
  render();
  showToast(`已移动 ${data.entries.length} 条`);
}

async function deleteSelected() {
  const ids = [...selection.ids].filter((id) => !isTrashed(state.entries.find((entry) => entry.id === id)));
  if (!ids.length) return;
  try { await moveToTrash(ids); }
  catch (error) { showToast(error.message, true); }
}

async function deleteEntry(entry) {
  if (!entry || isTrashed(entry)) return;
  try { await moveToTrash([entry.id]); }
  catch (error) { showToast(error.message, true); }
}

async function moveToTrash(ids) {
  refreshToken += 1;
  const data = await api('/api/entries/trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
  data.entries.forEach((updated) => { const existing = state.entries.find((entry) => entry.id === updated.id); if (existing) Object.assign(existing, updated); });
  ids.forEach((id) => { selection.ids.delete(id); expandedNotes.delete(id); if (editingNoteId === id) { editingNoteId = null; editingDraft = ""; } });
  rememberState();
  render();
  showToast(data.entries.length === 1 ? "已移到废纸篓" : "已将 " + data.entries.length + " 条移到废纸篓");
}

function entryLabel(entry) {
  return entry.type === "note" ? noteTitle(entry.content) : entry.name;
}

async function restoreEntries(ids) {
  const targets = ids.filter((id) => isTrashed(state.entries.find((entry) => entry.id === id)));
  if (!targets.length) return;
  refreshToken += 1;
  const data = await api('/api/entries/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: targets }) });
  data.entries.forEach((updated) => { const existing = state.entries.find((entry) => entry.id === updated.id); if (existing) Object.assign(existing, updated); });
  targets.forEach((id) => selection.ids.delete(id));
  rememberState();
  render();
  showToast(data.relocated ? "已还原 " + data.entries.length + " 条，原分类不在的已放到未分类" : "已还原 " + data.entries.length + " 条");
}

async function purgeEntries(ids) {
  try {
  const targets = ids.map((id) => state.entries.find((entry) => entry.id === id)).filter((entry) => isTrashed(entry));
  if (!targets.length) return;
  const message = targets.length === 1
    ? "永久删除“" + entryLabel(targets[0]) + "”？删除后无法恢复。"
    : "永久删除选中的 " + targets.length + " 条记录？删除后无法恢复。";
  if (!window.confirm(message)) return;
  refreshToken += 1;
  const data = await api('/api/entries/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: targets.map((entry) => entry.id) }) });
  const removed = new Set(data.ids);
  state.entries = state.entries.filter((entry) => !removed.has(entry.id));
  removed.forEach((id) => { selection.ids.delete(id); expandedNotes.delete(id); });
  rememberState();
  render();
  showToast("已永久删除");
  } catch (error) { showToast(error.message, true); }
}

async function emptyTrash() {
  const targets = state.entries.filter(isTrashed);
  if (!targets.length || !window.confirm("清空废纸篓中的 " + targets.length + " 条记录？清空后无法恢复。")) return;
  refreshToken += 1;
  const data = await api('/api/trash/empty', { method: 'POST' });
  const removed = new Set(data.ids);
  state.entries = state.entries.filter((entry) => !removed.has(entry.id));
  selection.ids.clear();
  rememberState();
  render();
  showToast("废纸篓已清空");
}

let imageViewer = null;

function mountImagePreview(src, alt) {
  const body = $('#preview-body');
  if (imageViewer) { imageViewer.destroy(); imageViewer = null; }
  body.classList.add('preview-image-mode');
  body.innerHTML = '<div class="preview-stage"><img class="preview-image" alt="' + escapeHtml(alt || "") + '" draggable="false"></div><div class="preview-zoom" role="group" aria-label="缩放"><button type="button" data-zoom="out" aria-label="缩小">−</button><button type="button" data-zoom="reset">适应</button><button type="button" data-zoom="in" aria-label="放大">+</button></div>';
  const stage = body.querySelector('.preview-stage');
  const image = stage.querySelector('img');
  imageViewer = createImageViewer(stage, image);
  image.addEventListener('error', () => {
    if (imageViewer) { imageViewer.destroy(); imageViewer = null; }
    body.classList.remove('preview-image-mode');
    body.innerHTML = '<div class="preview-loading">预览加载失败</div>';
  });
  image.src = src;
  body.querySelector('[data-zoom="in"]').addEventListener('click', () => imageViewer && imageViewer.zoomBy(1.35));
  body.querySelector('[data-zoom="out"]').addEventListener('click', () => imageViewer && imageViewer.zoomBy(1 / 1.35));
  body.querySelector('[data-zoom="reset"]').addEventListener('click', () => imageViewer && imageViewer.reset());
}

function createImageViewer(stage, img) {
  let scale = 1;
  let x = 0;
  let y = 0;
  let baseWidth = 0;
  let baseHeight = 0;
  const pointers = new Map();
  let pan = null;
  let pinch = null;
  let tap = null;
  const limit = () => Math.max(4, Math.min(12, baseWidth ? img.naturalWidth / baseWidth : 4));
  const apply = () => {
    img.style.transform = "translate(" + x + "px," + y + "px) scale(" + scale + ")";
    stage.classList.toggle("is-zoomed", scale > 1.02);
  };
  const clamp = () => {
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const width = baseWidth * scale;
    const height = baseHeight * scale;
    x = width <= sw ? (sw - width) / 2 : Math.min(0, Math.max(sw - width, x));
    y = height <= sh ? (sh - height) / 2 : Math.min(0, Math.max(sh - height, y));
  };
  const layout = () => {
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!sw || !sh || !nw || !nh) return;
    const fit = Math.min(sw / nw, sh / nh, 1);
    baseWidth = nw * fit;
    baseHeight = nh * fit;
    img.style.width = baseWidth + "px";
    img.style.height = baseHeight + "px";
    clamp();
    apply();
  };
  const zoomAt = (clientX, clientY, next) => {
    next = Math.min(limit(), Math.max(1, next));
    const rect = stage.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const ratio = next / scale;
    x = px - (px - x) * ratio;
    y = py - (py - y) * ratio;
    scale = next;
    clamp();
    apply();
  };
  const zoomBy = (factor) => {
    const rect = stage.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, scale * factor);
  };
  const reset = () => { scale = 1; layout(); };
  const onWheel = (event) => {
    event.preventDefault();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    zoomAt(event.clientX, event.clientY, scale * Math.exp(-delta * 0.0016));
  };
  const onDown = (event) => {
    if (event.button != null && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (stage.setPointerCapture) stage.setPointerCapture(event.pointerId);
    if (pointers.size === 1) {
      pan = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: x, oy: y, moved: false };
      pinch = null;
    } else if (pointers.size === 2) {
      const points = [...pointers.values()];
      pinch = { dist: Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)), scale };
      pan = null;
    }
  };
  const onMove = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pan && pan.id === event.pointerId && Math.hypot(event.clientX - pan.x, event.clientY - pan.y) > 6) pan.moved = true;
    if (pointers.size >= 2 && pinch) {
      const points = [...pointers.values()];
      const dist = Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y));
      zoomAt((points[0].x + points[1].x) / 2, (points[0].y + points[1].y) / 2, pinch.scale * (dist / pinch.dist));
      return;
    }
    if (!pan || pan.id !== event.pointerId || scale <= 1.02) return;
    x = pan.ox + event.clientX - pan.x;
    y = pan.oy + event.clientY - pan.y;
    clamp();
    apply();
    stage.classList.add("is-panning");
  };
  const onUp = (event) => {
    const info = pan && pan.id === event.pointerId ? pan : null;
    pointers.delete(event.pointerId);
    if (info && !info.moved && pointers.size === 0 && !pinch) {
      const now = Date.now();
      if (tap && now - tap.time < 280 && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 24) {
        if (scale > 1.02) reset();
        else zoomAt(event.clientX, event.clientY, Math.min(2.5, limit()));
        tap = null;
      } else tap = { time: now, x: event.clientX, y: event.clientY };
    }
    if (pan && pan.id === event.pointerId) pan = null;
    if (pointers.size < 2) pinch = null;
    stage.classList.remove("is-panning");
  };
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => layout()) : null;
  if (observer) observer.observe(stage);
  else window.addEventListener("resize", layout);
  img.addEventListener("load", layout);
  if (img.complete && img.naturalWidth) layout();
  return {
    zoomBy, reset, zoomAt,
    destroy() {
      if (observer) observer.disconnect();
      else window.removeEventListener("resize", layout);
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("pointerdown", onDown);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerup", onUp);
      stage.removeEventListener("pointercancel", onUp);
    }
  };
}

async function previewEntry(entry) {
  $('#preview-title').textContent = entry.name;
  const download = $('#preview-download');
  if (download) { download.hidden = false; download.href = '/api/files/' + entry.id; download.setAttribute('download', entry.name); }
  const body = $('#preview-body'); body.innerHTML = '<div class="preview-loading">正在加载预览…</div>';
  $('#preview-modal').hidden = false;
  if (entry.mime?.startsWith('image/')) { mountImagePreview('/api/files/' + entry.id + '?inline=1', entry.name); return; }
  if (entry.mime === 'application/pdf') {
    body.innerHTML = `<iframe class="preview-frame" src="/api/files/${entry.id}?inline=1" title="${escapeHtml(entry.name)}"></iframe>`;
    return;
  }
  try {
    const response = await fetch(`/api/files/${entry.id}?inline=1`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('预览加载失败');
    const text = await response.text();
    body.innerHTML = `<pre class="preview-text">${escapeHtml(text)}</pre>`;
  } catch (error) {
    body.innerHTML = `<div class="preview-loading">${escapeHtml(error.message)}</div>`;
  }
}

function closePreview() {
  if (imageViewer) { imageViewer.destroy(); imageViewer = null; }
  $('#preview-modal').hidden = true;
  const body = $('#preview-body');
  if (body) { body.classList.remove('preview-image-mode'); body.innerHTML = ''; }
  const download = $('#preview-download');
  if (download) download.hidden = true;
}

function render() { renderTopics(); renderHeader(); renderFeed(); renderSelection(); renderUsage(); const composer = $('#composer'); if (composer) composer.hidden = state.selected === 'trash'; const target = $('#save-target'); if (target && state.topics.length) target.textContent = `保存到 ${saveTargetName()}`; }

async function login(event) {
  event.preventDefault(); $('#login-error').textContent = '';
  try { await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#password').value }) }); $('#login-view').hidden = true; $('#app-view').hidden = false; await loadData(); startSync(); maybeShowAbout(); }
  catch (error) { $('#login-error').textContent = error.message === '密码不正确' ? '访问密钥不正确' : error.message; }
}

function dataSignature(data) {
  return JSON.stringify([data.topics.map((topic) => [topic.id, topic.name]), data.entries.map((entry) => [entry.id, entry.topicId, entry.name, entry.size, entry.content || '', entry.deletedAt || '', entry.updatedAt || ''])]);
}

function rememberState() {
  knownSignature = dataSignature({ topics: state.topics, entries: state.entries });
}

async function loadData() {
  const data = await api('/api/bootstrap');
  knownSignature = dataSignature(data);
  state.topics = data.topics;
  state.entries = data.entries;
  if (state.selected !== 'all' && state.selected !== 'trash' && !selectedTopic()) state.selected = 'all';
  render();
  const label = $('#sync-label');
  if (label) { label.textContent = '已同步'; label.classList.remove('stale'); }
}

async function refreshData(manual = false) {
  if (sending || editingNoteId) { if (manual) showToast(editingNoteId ? '先保存或取消编辑' : '正在发送', true); return; }
  const token = ++refreshToken;
  const label = $('#sync-label');
  if (manual && label) label.textContent = '同步中';
  try {
    const data = await api('/api/bootstrap');
    if (token !== refreshToken || sending || editingNoteId) return;
    const signature = dataSignature(data);
    if (signature !== knownSignature) {
      knownSignature = signature;
      state.topics = data.topics;
      state.entries = data.entries;
      const ids = new Set(state.entries.map((entry) => entry.id));
      [...selection.ids].forEach((id) => { if (!ids.has(id)) selection.ids.delete(id); });
      [...expandedNotes].forEach((id) => { if (!ids.has(id)) expandedNotes.delete(id); });
      if (state.selected !== 'all' && state.selected !== 'trash' && !selectedTopic()) state.selected = 'all';
      render();
    }
    if (label) { label.textContent = '已同步'; label.classList.remove('stale'); }
  } catch (error) {
    if (label) { label.textContent = '未同步'; label.classList.add('stale'); }
    if (manual && error.message !== '访问已失效') showToast(error.message, true);
  }
}

function startSync() {
  if (startSync.started) return;
  startSync.started = true;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshData(false); });
  window.addEventListener('focus', () => refreshData(false));
  window.setInterval(() => { if (!document.hidden) refreshData(false); }, 15000);
}

function fitComposer() {
  const input = $('#note-input');
  input.style.height = 'auto';
  input.style.height = Math.min(Math.max(input.scrollHeight, 52), 160) + 'px';
}

function beginEdit(entry) {
  editingNoteId = entry.id;
  editingDraft = entry.content || '';
  focusEditor = true;
  render();
}

async function saveNote(entry) {
  const content = ($('.note-edit')?.value ?? editingDraft).trim();
  if (!content) { showToast('文字不能为空', true); return; }
  if (content.length > 20000) { showToast('文字不能超过 20000 字', true); return; }
  refreshToken += 1;
  const updated = await api('/api/entries/' + entry.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
  const changed = content !== String(entry.content || "").trim();
  Object.assign(entry, updated);
  editingNoteId = null;
  editingDraft = '';
  rememberState();
  render();
  if (changed) document.querySelector('[data-entry="' + entry.id + '"]')?.scrollIntoView({ block: "nearest" });
  showToast('已保存');
}

function keyboardInsetAction(frame) {
  const visible = Math.round(frame.visibleHeight);
  const offset = Math.round(frame.offsetTop || 0);
  const obscured = Math.round(frame.naturalHeight) - visible - offset;
  if (obscured < 48 && offset < 8) return { active: false, height: "", transform: "" };
  return { active: true, height: visible + "px", transform: offset > 0 ? "translateY(" + offset + "px)" : "" };
}

function revealFocusedField(target) {
  const viewport = window.visualViewport;
  if (!viewport || !target || !target.getBoundingClientRect) return;
  const rect = target.getBoundingClientRect();
  if (rect.bottom > viewport.height - 8 || rect.top < 8) target.scrollIntoView({ block: "nearest" });
}

function bindKeyboardInset() {
  const viewport = window.visualViewport;
  const shell = document.querySelector("#app-view");
  if (!viewport || !shell) return;
  let naturalHeight = 0;
  let active = false;
  const update = () => {
    if (shell.hidden) {
      active = false;
      shell.style.height = "";
      shell.style.transform = "";
      return;
    }
    if (!active) naturalHeight = Math.round(shell.getBoundingClientRect().height) || window.innerHeight;
    const action = keyboardInsetAction({ naturalHeight, visibleHeight: viewport.height, offsetTop: viewport.offsetTop });
    active = action.active;
    shell.style.height = action.height;
    shell.style.transform = action.transform;
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  window.addEventListener("orientationchange", () => {
    active = false;
    shell.style.height = "";
    shell.style.transform = "";
    setTimeout(update, 350);
  });
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (!target.closest || !target.closest("#app-view")) return;
    if (!target.matches || !target.matches("textarea, input[type='text'], input[type='search'], input[type='password'], input[type='url']")) return;
    setTimeout(update, 60);
    setTimeout(() => { update(); revealFocusedField(target); }, 320);
  });
  document.addEventListener("focusout", () => setTimeout(update, 180));
}

function currentTopicId() {
  if (state.selected !== 'all' && state.selected !== 'trash') return state.selected;
  return (state.topics.find((topic) => topic.system) || state.topics[0]).id;
}

function renderPending() {
  const box = $('#composer-preview');
  if (!pending.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = pending.map((item) => item.isImage
    ? `<div class="preview-chip image"><img src="${item.url}" alt="${escapeHtml(item.file.name)}" /><button class="chip-remove" type="button" data-remove="${item.id}" aria-label="移除">×</button></div>`
    : `<div class="preview-chip file"><span>${escapeHtml(item.file.name)}</span><small>${formatSize(item.file.size)}</small><button class="chip-remove" type="button" data-remove="${item.id}" aria-label="移除">×</button></div>`).join('');
  box.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => removePending(button.dataset.remove)));
}

function newId() {
  try { if (typeof crypto.randomUUID === 'function') return crypto.randomUUID(); } catch {}
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function addPending(files) {
  let skipped = 0;
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) { skipped += 1; continue; }
    const isImage = (file.type || '').startsWith('image/');
    pending.push({ id: newId(), file, isImage, url: isImage ? URL.createObjectURL(file) : '' });
  }
  renderPending();
  if (skipped) showToast(skipped === 1 ? '文件超过 250 MB，未添加' : skipped + ' 个文件超过 250 MB，未添加', true);
}

function removePending(id) {
  const index = pending.findIndex((item) => item.id === id);
  if (index < 0) return;
  if (pending[index].url) URL.revokeObjectURL(pending[index].url);
  pending.splice(index, 1);
  renderPending();
}

async function selectTopic(topicId) {
  document.querySelector('.sidebar').classList.remove('open');
  $('#sidebar-backdrop')?.classList.remove('show');
  if (topicId === state.selected) return;
  if ((topicId === 'trash') !== (state.selected === 'trash')) {
    selection.active = false;
    selection.ids.clear();
    state.search = '';
    const search = $('#search-input');
    if (search) search.value = '';
  }
  state.selected = topicId;
  render();
}

function clipboardText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').trim();
}

function imageFileName(type, index) {
  const subtype = String(type || '').split('/')[1] || 'png';
  const ext = subtype === 'jpeg' ? 'jpg' : subtype;
  return '粘贴图片' + (index > 1 ? '-' + index : '') + '.' + ext;
}

function isImageFilenameText(text, files) {
  const value = clipboardText(text);
  if (!value) return true;
  const names = new Set((files || []).map((file) => String(file.name || '').toLowerCase()));
  if (lastCopiedImage) names.add(String(lastCopiedImage.name || '').toLowerCase());
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => names.has(line.toLowerCase()) || /^image\.(png|jpe?g|gif|webp|bmp)$/i.test(line));
}

function matchesRememberedImage(text) {
  if (!lastCopiedImage) return false;
  const lines = clipboardText(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return false;
  return lines[0].toLowerCase() === String(lastCopiedImage.name || '').toLowerCase();
}

function fileFromDataUrl(dataUrl, index) {
  const match = /^data:(image\/(?:png|jpeg|gif|webp|bmp));base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || '').trim());
  if (!match) return null;
  const encoded = match[2].replace(/\s/g, '');
  if (!encoded || encoded.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8) return null;
  let binary = '';
  try { binary = atob(encoded); } catch { return null; }
  if (!binary.length || binary.length > MAX_FILE_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset);
  const type = match[1].toLowerCase();
  return new File([bytes], imageFileName(type, index), { type });
}

function clipboardImageSources(html) {
  const dataUrls = [];
  const urls = [];
  if (!html) return { dataUrls, urls };
  let doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch { return { dataUrls, urls }; }
  for (const img of doc.querySelectorAll('img')) {
    const src = (img.getAttribute('src') || '').trim();
    if (!src) continue;
    if (src.startsWith('data:image/')) { dataUrls.push(src); continue; }
    let url;
    try { url = new URL(src, location.href); } catch { continue; }
    if (url.origin !== location.origin || !/^\/api\/files\/[^/?#]+/.test(url.pathname)) continue;
    urls.push(url.href);
  }
  return { dataUrls, urls };
}

async function filesFromImageSources(sources) {
  const files = [];
  for (const dataUrl of sources.dataUrls) {
    const file = fileFromDataUrl(dataUrl, files.length + 1);
    if (file) files.push(file);
  }
  for (const href of sources.urls) {
    try {
      const response = await fetch(href, { credentials: 'same-origin' });
      if (!response.ok) continue;
      const blob = await response.blob();
      const type = (blob.type || '').toLowerCase();
      if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(type) || blob.size <= 0 || blob.size > MAX_FILE_BYTES) continue;
      files.push(new File([blob], imageFileName(type, files.length + 1), { type }));
    } catch {}
  }
  return files;
}

function insertComposerText(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const caret = start + text.length;
  input.selectionStart = input.selectionEnd = caret;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function clipboardFiles(data) {
  const files = [];
  const seen = new Set();
  const add = (file) => {
    if (!file || file.size <= 0) return;
    const type = file.type || (/\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : /\.gif$/i.test(file.name) ? 'image/gif' : /\.webp$/i.test(file.name) ? 'image/webp' : 'application/octet-stream');
    const extension = type.startsWith('image/') ? (type.split('/')[1] === 'jpeg' ? 'jpg' : type.split('/')[1]) : 'bin';
    const name = file.name && file.name.trim() ? file.name : `粘贴图片.${extension}`;
    const named = name === file.name && type === file.type ? file : new File([file], name, { type, lastModified: file.lastModified });
    const key = `${named.name}:${named.size}:${named.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(named);
  };
  for (const file of data.files || []) add(file);
  for (const item of data.items || []) if (item.kind === 'file') add(item.getAsFile());
  return files;
}

function onPaste(event) {
  const data = event.clipboardData;
  if (!data) return;
  const directFiles = clipboardFiles(data);
  const text = data.getData('text/plain') || '';
  const html = directFiles.length ? '' : (data.getData('text/html') || '');
  const sources = directFiles.length ? { dataUrls: [], urls: [] } : clipboardImageSources(html);
  const hasSources = sources.dataUrls.length > 0 || sources.urls.length > 0;
  const canRemember = !directFiles.length && matchesRememberedImage(text);
  if (!directFiles.length && !hasSources && !canRemember) return;
  event.preventDefault();
  const finish = (images) => {
    try {
      const chosen = images && images.length ? images : (canRemember && lastCopiedImage ? [lastCopiedImage] : []);
      if (!chosen.length) {
        if (text) insertComposerText(event.target, text);
        return;
      }
      addPending(chosen);
      if (text && !isImageFilenameText(text, chosen)) insertComposerText(event.target, text);
    } catch {
      if (text && !isImageFilenameText(text, [])) insertComposerText(event.target, text);
      showToast('图片没有放进输入框', true);
    }
  };
  if (directFiles.length || !hasSources) {
    finish(directFiles);
    return;
  }
  filesFromImageSources(sources).then(finish).catch(() => finish([]));
}

function uploadOne(file, topicId, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData(); form.append('file', file);
    const xhr = new XMLHttpRequest(); xhr.open('POST', `/api/topics/${topicId}/files`); xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => { if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total); };
    xhr.onload = () => { try { const data = JSON.parse(xhr.responseText); if (xhr.status >= 400) reject(new Error(data.error || '上传失败')); else resolve(data.files); } catch { reject(new Error('上传响应无效')); } };
    xhr.onerror = () => reject(new Error('网络连接中断')); xhr.send(form);
  });
}

async function sendComposer() {
  if (sending) return;
  const input = $('#note-input');
  const content = input.value.trim();
  if (!content && !pending.length) return;
  if (content.length > 20000) { showToast('文字不能超过 20000 字', true); return; }
  sending = true;
  refreshToken += 1;
  const button = $('#send-button');
  const attach = $('#attach-button');
  button.disabled = true;
  attach.disabled = true;
  button.textContent = '发送中';
  const topicId = currentTopicId();
  try {
    if (content) {
      const created = await api(`/api/topics/${topicId}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
      state.entries.push(created);
      input.value = '';
      fitComposer();
    }
    const total = pending.length;
    let index = 0;
    while (pending.length) {
      index += 1;
      const item = pending[0];
      button.textContent = total > 1 ? `发送 ${index}/${total}` : '发送中';
      const created = await uploadOne(item.file, topicId, (ratio) => { button.textContent = total > 1 ? `${index}/${total} ${Math.round(ratio * 100)}%` : `${Math.round(ratio * 100)}%`; });
      state.entries.push(...created);
      removePending(item.id);
    }
    $('#sync-label').textContent = '已发送';
    render();
    showToast(state.selected === 'all' ? `已发送到 ${saveTargetName()}` : '已发送');
  } catch (error) {
    render();
    showToast(error.message, true);
  } finally {
    sending = false;
    button.disabled = false;
    attach.disabled = false;
    button.textContent = '发送';
    rememberState();
  }
}

async function createTopic() {
  const name = window.prompt('给新分类起个名字，例如「项目资料」或「手机临时传输」'); if (!name?.trim()) return;
  refreshToken += 1;
  try { const topic = await api('/api/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }); state.topics.push(topic); state.selected = topic.id; rememberState(); render(); showToast('分类已创建'); }
  catch (error) { showToast(error.message, true); }
}

async function renameTopic() {
  const topic = selectedTopic(); const name = window.prompt('修改分类名称', topic.name); if (!name?.trim() || name.trim() === topic.name) return;
  refreshToken += 1;
  try { const updated = await api(`/api/topics/${topic.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }); Object.assign(topic, updated); rememberState(); render(); showToast('分类已重命名'); }
  catch (error) { showToast(error.message, true); }
}

async function deleteTopic() {
  const topic = selectedTopic(); if (!topic || !window.confirm(`删除分类“${topic.name}”？其中的记录会移动到“未分类”。`)) return;
  refreshToken += 1;
  try { const data = await api(`/api/topics/${topic.id}`, { method: 'DELETE' }); state.entries.forEach((entry) => { if (entry.topicId === topic.id) { entry.topicId = data.movedTo; entry.topicName = state.topics.find((item) => item.id === data.movedTo)?.name || '未分类'; } }); state.topics = state.topics.filter((item) => item.id !== topic.id); state.selected = 'all'; rememberState(); render(); showToast('分类已删除，记录已保留'); }
  catch (error) { showToast(error.message, true); }
}

function closeAbout() {
  const modal = $('#about-modal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  try { localStorage.setItem('hub-intro-seen-5', '1'); } catch {}
}

function openAbout() {
  const modal = $('#about-modal');
  if (!modal) return;
  modal.hidden = false;
  modal.querySelector('.about-dialog')?.focus();
}

function maybeShowAbout() {
  try { if (localStorage.getItem('hub-intro-seen-5')) return; } catch { return; }
  openAbout();
}

async function init() {
  $('#login-form').addEventListener('submit', login);
  $('#composer').addEventListener('submit', (event) => { event.preventDefault(); sendComposer(); });
  $('#new-topic').addEventListener('click', createTopic);
  $('#attach-button').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', () => { const files = [...$('#file-input').files]; if (files.length) addPending(files); $('#file-input').value = ''; });
  $('#toggle-password').addEventListener('click', () => { const input = $('#password'); const show = input.type === 'password'; input.type = show ? 'text' : 'password'; const button = $('#toggle-password'); button.textContent = show ? '隐藏' : '显示'; button.setAttribute('aria-label', show ? '隐藏访问密钥' : '显示访问密钥'); button.setAttribute('aria-pressed', show ? 'true' : 'false'); });
  $('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.reload(); });
  const noteInput = $('#note-input');
  const desktopEnter = window.matchMedia('(hover: hover) and (pointer: fine)');
  noteInput.addEventListener('keydown', (event) => { if (event.key !== 'Enter' || event.shiftKey || event.isComposing || !desktopEnter.matches) return; event.preventDefault(); sendComposer(); });
  noteInput.addEventListener('input', fitComposer);
  noteInput.addEventListener('paste', onPaste);
  $('#composer').addEventListener('dragover', (event) => { event.preventDefault(); $('#composer').classList.add('dragging'); });
  $('#composer').addEventListener('dragleave', () => $('#composer').classList.remove('dragging'));
  $('#composer').addEventListener('drop', (event) => { event.preventDefault(); $('#composer').classList.remove('dragging'); const files = [...event.dataTransfer.files]; if (files.length) addPending(files); });
  $('#search-input').addEventListener('input', (event) => { state.search = event.target.value; render(); });
  $('#sync-label').addEventListener('click', () => refreshData(true));
  bindKeyboardInset();
  $('#mobile-menu').addEventListener('click', () => { const sidebar = document.querySelector('.sidebar'); sidebar.classList.toggle('open'); $('#sidebar-backdrop').classList.toggle('show', sidebar.classList.contains('open')); });
  $('#sidebar-backdrop').addEventListener('click', () => { document.querySelector('.sidebar').classList.remove('open'); $('#sidebar-backdrop').classList.remove('show'); });
  $('#about-open').addEventListener('click', openAbout);
  $('#about-done').addEventListener('click', closeAbout);
  $$('[data-close-about]').forEach((button) => button.addEventListener('click', closeAbout));
  $$('[data-close-preview]').forEach((button) => button.addEventListener('click', closePreview));
  document.addEventListener("keydown", (event) => {
    if (imageViewer && !$("#preview-modal").hidden && !event.target.closest("input, textarea")) {
      if (event.key === "+" || event.key === "=") { event.preventDefault(); imageViewer.zoomBy(1.35); }
      else if (event.key === "-" || event.key === "_") { event.preventDefault(); imageViewer.zoomBy(1 / 1.35); }
      else if (event.key === "0") { event.preventDefault(); imageViewer.reset(); }
    }
    if (event.key === "Escape") {
      closeAbout();
      closePreview();
      closeClassify();
      if (editingNoteId) { editingNoteId = null; editingDraft = ""; render(); }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && selection.active && !event.target.closest("input, textarea")) {
      event.preventDefault();
      visibleEntries().forEach((entry) => selection.ids.add(entry.id));
      render();
    }
  });
  $("#select-toggle").addEventListener("click", () => { selection.active = !selection.active; if (!selection.active) selection.ids.clear(); render(); });
  $("#selection-cancel").addEventListener("click", () => { selection.active = false; selection.ids.clear(); render(); });
  $("#select-all-box").addEventListener("change", () => {
    const visible = visibleEntries();
    if ($("#select-all-box").checked) visible.forEach((entry) => selection.ids.add(entry.id));
    else selection.ids.clear();
    render();
  });
  const sideMode = window.matchMedia("(hover: none), (pointer: coarse)");
  const onSideMode = () => { if (!$("#app-view").hidden) renderFeed(); };
  if (sideMode.addEventListener) sideMode.addEventListener("change", onSideMode);
  else if (sideMode.addListener) sideMode.addListener(onSideMode);
  $('#trash-link').addEventListener('click', () => selectTopic('trash'));
  $('#selection-classify').addEventListener('click', () => openClassify([...selection.ids]));
  $('#selection-delete').addEventListener('click', () => { deleteSelected().catch((error) => showToast(error.message, true)); });
  $('#selection-restore').addEventListener('click', () => { restoreEntries([...selection.ids]).catch((error) => showToast(error.message, true)); });
  $('#selection-purge').addEventListener('click', () => { purgeEntries([...selection.ids]).catch((error) => showToast(error.message, true)); });
  $$('[data-close-classify]').forEach((button) => button.addEventListener('click', closeClassify));
  try { const session = await api('/api/session'); if (session.authenticated) { $('#login-view').hidden = true; $('#app-view').hidden = false; await loadData(); startSync(); maybeShowAbout(); } else $('#login-view').hidden = false; } catch { $('#login-view').hidden = false; }
}

document.addEventListener('DOMContentLoaded', init);
