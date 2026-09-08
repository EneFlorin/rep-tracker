const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.txt');
const WORKOUTS_FILE = path.join(DATA_DIR, 'workouts.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(
      USERS_FILE,
      '# One user per line: username,password,role\n' +
      '# role is "admin" (can add/edit/delete workouts) or "member"\n' +
      '# Edit this file directly to add your friends.\n' +
      'admin,changeme,admin\n'
    );
  }
  if (!fs.existsSync(WORKOUTS_FILE)) fs.writeFileSync(WORKOUTS_FILE, '[]');
  if (!fs.existsSync(LOGS_FILE)) fs.writeFileSync(LOGS_FILE, '{}');
  if (!fs.existsSync(TODOS_FILE)) fs.writeFileSync(TODOS_FILE, '{}');
}
ensureDataFiles();

// On a host where you can't easily open a text file (e.g. a deployed server),
// set a USERS_TXT env var with the exact contents you'd otherwise put in
// data/users.txt (one "username,password,role" per line) to manage accounts
// from Render's dashboard instead.
if (process.env.USERS_TXT) {
  fs.writeFileSync(USERS_FILE, process.env.USERS_TXT);
}

function readUsers() {
  const raw = fs.readFileSync(USERS_FILE, 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const parts = l.split(',').map((s) => (s || '').trim());
      return { username: parts[0], password: parts[1], role: parts[2] === 'admin' ? 'admin' : 'member' };
    })
    .filter((u) => u.username);
}
function findUser(username) {
  const u = String(username || '').toLowerCase();
  return readUsers().find((x) => x.username.toLowerCase() === u);
}
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function readWorkouts() { return readJSON(WORKOUTS_FILE) || []; }
function writeWorkouts(list) { writeJSON(WORKOUTS_FILE, list); }
function readLogs() { return readJSON(LOGS_FILE) || {}; }
function writeLogs(obj) { writeJSON(LOGS_FILE, obj); }
function readTodos() { return readJSON(TODOS_FILE) || {}; }
function writeTodos(obj) { writeJSON(TODOS_FILE, obj); }

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function isoWeekday(d) { return ((d.getDay() + 6) % 7) + 1; }
function startOfWeek(d) { const wd = isoWeekday(d); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (wd - 1)); }
function datesBetween(start, end) {
  const out = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cur <= last) { out.push(dateStr(cur)); cur.setDate(cur.getDate() + 1); }
  return out;
}
function dayTotal(userLogs, dstr) {
  let sum = 0;
  Object.keys(userLogs).forEach((workoutId) => {
    const day = userLogs[workoutId][dstr];
    if (day && Array.isArray(day.entries)) sum += day.entries.reduce((a, b) => a + b, 0);
    else if (typeof day === 'number') sum += day;
  });
  return sum;
}
function rangeTotal(userLogs, dates) {
  return dates.reduce((sum, d) => sum + dayTotal(userLogs, d), 0);
}

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'rep-tracker-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'not_admin' });
  next();
}

// --- auth ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = findUser(username);
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  req.session.user = { username: user.username, role: user.role };
  res.json({ username: user.username, role: user.role });
});
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/api/session', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated' });
  res.json(req.session.user);
});

// --- workouts (shared, admin-managed) ---
app.get('/api/workouts', requireAuth, (req, res) => {
  res.json(readWorkouts());
});
app.post('/api/workouts', requireAdmin, (req, res) => {
  const { name, unit } = req.body || {};
  const trimmed = String(name || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'name_required' });
  const list = readWorkouts();
  const w = { id: uid(), name: trimmed, unit: String(unit || '').trim() || 'reps', createdAt: new Date().toISOString() };
  list.push(w);
  writeWorkouts(list);
  res.json(w);
});
app.put('/api/workouts/:id', requireAdmin, (req, res) => {
  const list = readWorkouts();
  const w = list.find((x) => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'not_found' });
  const { name, unit } = req.body || {};
  if (typeof name === 'string' && name.trim()) w.name = name.trim();
  if (typeof unit === 'string') w.unit = unit.trim() || 'reps';
  writeWorkouts(list);
  res.json(w);
});
app.delete('/api/workouts/:id', requireAdmin, (req, res) => {
  const list = readWorkouts().filter((x) => x.id !== req.params.id);
  writeWorkouts(list);
  const logs = readLogs();
  Object.keys(logs).forEach((u) => { delete logs[u][req.params.id]; });
  writeLogs(logs);
  res.json({ ok: true });
});

// --- personal logs ---
app.get('/api/logs', requireAuth, (req, res) => {
  const logs = readLogs();
  res.json(logs[req.session.user.username] || {});
});
app.post('/api/logs/:workoutId/entries', requireAuth, (req, res) => {
  const { date, amount } = req.body || {};
  const amt = Number(amount);
  if (!date || !amt || amt <= 0) return res.status(400).json({ error: 'invalid_amount' });
  const logs = readLogs();
  const u = req.session.user.username;
  logs[u] = logs[u] || {};
  logs[u][req.params.workoutId] = logs[u][req.params.workoutId] || {};
  const day = logs[u][req.params.workoutId][date] || { entries: [] };
  day.entries.push(amt);
  logs[u][req.params.workoutId][date] = day;
  writeLogs(logs);
  res.json(day);
});
app.put('/api/logs/:workoutId/day', requireAuth, (req, res) => {
  const { date, entries } = req.body || {};
  if (!date || !Array.isArray(entries)) return res.status(400).json({ error: 'invalid' });
  const clean = entries.map(Number).filter((n) => n > 0);
  const logs = readLogs();
  const u = req.session.user.username;
  logs[u] = logs[u] || {};
  logs[u][req.params.workoutId] = logs[u][req.params.workoutId] || {};
  if (clean.length === 0) delete logs[u][req.params.workoutId][date];
  else logs[u][req.params.workoutId][date] = { entries: clean };
  writeLogs(logs);
  res.json({ ok: true });
});

// --- personal to-dos ---
app.get('/api/todos', requireAuth, (req, res) => {
  const todos = readTodos();
  res.json(todos[req.session.user.username] || []);
});
app.post('/api/todos', requireAuth, (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text_required' });
  const todos = readTodos();
  const u = req.session.user.username;
  todos[u] = todos[u] || [];
  const t = { id: uid(), text, done: false };
  todos[u].unshift(t);
  writeTodos(todos);
  res.json(t);
});
app.patch('/api/todos/:id', requireAuth, (req, res) => {
  const todos = readTodos();
  const u = req.session.user.username;
  const list = todos[u] || [];
  const t = list.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  if (typeof (req.body || {}).done === 'boolean') t.done = req.body.done;
  writeTodos(todos);
  res.json(t);
});
app.delete('/api/todos/:id', requireAuth, (req, res) => {
  const todos = readTodos();
  const u = req.session.user.username;
  todos[u] = (todos[u] || []).filter((x) => x.id !== req.params.id);
  writeTodos(todos);
  res.json({ ok: true });
});
app.post('/api/todos/:id/move-to-bottom', requireAuth, (req, res) => {
  const todos = readTodos();
  const u = req.session.user.username;
  const list = todos[u] || [];
  const idx = list.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not_found' });
  const item = list[idx];
  if (!item.done) return res.json({ ok: true, skipped: true });
  list.splice(idx, 1);
  list.push(item);
  writeTodos(todos);
  res.json({ ok: true });
});

// --- group leaderboard ---
app.get('/api/leaderboard', requireAuth, (req, res) => {
  const logs = readLogs();
  const users = readUsers().map((u) => u.username);
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const yStr = dateStr(yesterday);
  const monday = startOfWeek(now);
  const weekDates = datesBetween(monday, now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthDates = datesBetween(monthStart, now);

  function rankByDates(dates) {
    return users
      .map((u) => ({ username: u, total: rangeTotal(logs[u] || {}, dates) }))
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 3);
  }

  res.json({
    yesterday: rankByDates([yStr]),
    week: rankByDates(weekDates),
    month: rankByDates(monthDates),
    users
  });
});

// --- static frontend ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Rep Tracker running at http://localhost:' + PORT);
});
