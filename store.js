// 저장소 어댑터. 화면 코드(app.js)는 이 인터페이스만 사용한다.
//   init()                → 준비 (아티팩트는 db·user 연결)
//   loadBank()            → 문제은행 {questions, groups, subjects, exam}
//   loadAll()             → {attempts, notes, settings, exams}
//   addAttempts(list)     → 풀이 기록 추가 (uid 기준 중복 무시, 실패해도 큐에 남아 다음에 다시 보냄)
//   saveNote(note) · saveSettings(obj) · saveExam(exam) · importDump(dump)
//   exportUrl()           → 백업 다운로드 주소 (없으면 null → downloadBackup() 사용)
//   imageHtml(q)          → 문제 이미지 HTML
//   pending()             → 아직 저장 못 한 기록 수
//   useHash · whereText · failHint
//
// A: LocalServerStore — quiz/server.py + SQLite (이 PC)
// B: ArtifactStore    — claude.ai 아티팩트의 db(개인 전용 경로) + 이미지 스프라이트
// D: BrowserStore     — 정적 웹사이트(GitHub Pages), 기록은 브라우저 IndexedDB

const QUEUE_KEY = "quiz.pendingAttempts";

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch { return []; }
}
function saveQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* 저장 불가 환경 */ }
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function nowIso() {
  const d = new Date();
  const z = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}.${z(d.getMilliseconds(), 3)}`;
}

const escAttr = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 보내는 중에 새 기록이 들어와도 잃지 않도록: 한 번에 하나만 보내고, 보낸 uid만 큐에서 지운다
class QueuedStore {
  pending() { return loadQueue().length; }
  async addAttempts(list) { saveQueue([...loadQueue(), ...list]); await this.flush(); }
  flush() {
    this._flushing = (this._flushing || Promise.resolve()).then(async () => {
      const q = loadQueue();
      if (!q.length) return;
      try {
        await this.sendAttempts(q);
        const sent = new Set(q.map((a) => a.uid));
        saveQueue(loadQueue().filter((a) => !sent.has(a.uid)));
        this.online = true;
      } catch (e) { this.online = false; console.warn("기록 저장 실패, 다음에 다시 보냅니다", e); }
    });
    return this._flushing;
  }
}

// ---------------- A: 로컬 서버 ----------------
async function call(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

export class LocalServerStore extends QueuedStore {
  constructor(base = "") {
    super();
    this.base = base; this.online = true; this.useHash = true;
    this.whereText = "풀이 기록은 quiz/data/study.db에 저장되고, 서버를 켤 때마다 quiz/backups/에 자동으로 사본이 생깁니다(최근 30개).";
    this.failHint = "quiz/server.py가 실행 중인지 확인하세요.";
  }
  async init() {}
  imageHtml(q) { return `<img src="${this.base}/images/${q.id}.png?v=${this.ver || ""}" alt="${escAttr(q.question)}">`; }
  async loadBank() { const b = await call(`${this.base}/api/bank`); this.ver = b.built; return b; }
  async loadAll() { await this.flush(); return call(`${this.base}/api/all`); }
  sendAttempts(q) { return call(`${this.base}/api/attempts`, { attempts: q }); }
  saveNote(n) { return call(`${this.base}/api/notes`, n); }
  saveSettings(s) { return call(`${this.base}/api/settings`, s); }
  saveExam(e) { return call(`${this.base}/api/exams`, e); }
  importDump(d) { return call(`${this.base}/api/import`, d); }
  exportUrl() { return `${this.base}/api/export`; }
}

// ---------------- B: claude.ai 아티팩트 ----------------
// db 구조 (모두 data/users/<내 id>/ 아래 → 다른 사람은 읽을 수 없음)
//   profile                 {kind:"profile", settings:{...}, notes:{qid:{text,star,flag,updated}}}
//   d<YYYY-MM-DD>_<기기>     {kind:"day", day, device, attempts:[...]}   ← 하루·기기별로 묶어 문서 수를 줄임
//   x<모의고사 id>           {kind:"exam", ts, result}
const DEVICE_KEY = "quiz.deviceId";
function deviceId() {
  try {
    let d = localStorage.getItem(DEVICE_KEY);
    if (!d) { d = Math.random().toString(36).slice(2, 10); localStorage.setItem(DEVICE_KEY, d); }
    return d;
  } catch { return "s" + Math.random().toString(36).slice(2, 8); }
}

export class ArtifactStore extends QueuedStore {
  constructor() {
    super();
    this.useHash = false; this.online = true;
    this.whereText = "풀이 기록은 이 아티팩트의 개인 전용 저장소(claude.ai)에 저장됩니다. 같은 계정으로 로그인하면 휴대폰·다른 PC에서도 이어집니다. 다른 사람은 내 기록을 볼 수 없습니다.";
    this.failHint = "claude.ai에 로그인했는지 확인하세요.";
    this.device = deviceId();
    this.days = new Map();     // 문서id → attempts 배열 (이 기기가 쓰는 문서 캐시)
    this.profile = { kind: "profile", settings: {}, notes: {} };
    this._write = Promise.resolve();
  }
  async init() {
    const [db, user, downloads] = await Promise.all([claude.use("db"), claude.use("user"), claude.use("downloads")]);
    this.db = db; this.downloads = downloads;
    this.uid = user ? await user.id() : null;
    if (!db || !this.uid) {
      this.readOnly = true;
      this.whereText = "지금은 저장소에 연결되지 않아 기록이 이 브라우저에만 임시로 남습니다. claude.ai에 로그인한 상태로 열어 주세요.";
    }
  }
  col() { return this.db.collection(`data/users/${this.uid}`); }
  // 같은 문서에 대한 쓰기는 한 번에 하나씩 (db 규칙)
  serial(fn) { this._write = this._write.then(fn, fn); return this._write; }

  imageHtml(q) {
    const s = this.sprites?.[q.id];
    if (!s) return `<div class="muted">이미지 없음</div>`;
    const [sheet, y, w, h, sw, sh] = s;
    // 세로로 쌓은 스프라이트에서 한 문항만 보이게: 폭 기준 백분율로 위치 계산
    const posY = sh === h ? 0 : (y / (sh - h)) * 100;
    return `<div class="sprite" role="img" aria-label="${escAttr(q.question)}" style="aspect-ratio:${w}/${h};width:min(100%,${w}px);`
      + `background-image:url('img/${sheet}');background-size:${(sw / w) * 100}% auto;background-position:0 ${posY}%"></div>`;
  }

  async loadBank() {
    const [bank, sprites] = await Promise.all([fetch("bank.json").then((r) => r.json()), fetch("sprites.json").then((r) => r.json())]);
    this.sprites = sprites;
    return bank;
  }

  async loadAll() {
    const out = { attempts: [], notes: [], settings: {}, exams: [] };
    if (!this.readOnly) {
      await this.flush();
      const p = await this.col().doc("profile").get();
      if (p.exists) this.profile = { kind: "profile", settings: {}, notes: {}, ...structuredClone(p.data()) };
      // 날짜 문서: 1000개씩 끊어서 읽음
      let last = "";
      for (;;) {
        const snap = await this.col().where("kind", "==", "day").where("day", ">", last).orderBy("day").limit(1000).get();
        for (const d of snap.docs) {
          const v = d.data();
          out.attempts.push(...(v.attempts || []));
          if (v.device === this.device) this.days.set(d.id, [...(v.attempts || [])]);
          last = v.day;
        }
        if (snap.size < 1000) break;
      }
      const ex = await this.col().where("kind", "==", "exam").limit(1000).get();
      for (const d of ex.docs) { const v = d.data(); out.exams.push({ id: d.id.slice(1), ts: v.ts, result: v.result }); }
      out.exams.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    }
    out.settings = { ...this.profile.settings };
    out.notes = Object.entries(this.profile.notes || {}).map(([qid, n]) => ({ qid, ...n }));
    // 아직 못 보낸 기록도 화면에는 보이게
    const seen = new Set(out.attempts.map((a) => a.uid));
    for (const a of loadQueue()) if (!seen.has(a.uid)) out.attempts.push(a);
    return out;
  }

  async sendAttempts(list, device = this.device) {
    if (this.readOnly) throw new Error("저장소 연결 안 됨");
    const byDay = new Map();
    for (const a of list) {
      const id = `d${a.ts.slice(0, 10)}_${device}`;
      if (!byDay.has(id)) byDay.set(id, []);
      byDay.get(id).push(a);
    }
    for (const [id, items] of byDay) {
      await this.serial(async () => {
        let cur = this.days.get(id);
        if (!cur) { const s = await this.col().doc(id).get(); cur = s.exists ? [...(s.data().attempts || [])] : []; }
        const have = new Set(cur.map((a) => a.uid));
        const next = cur.concat(items.filter((a) => !have.has(a.uid)));
        await this.col().doc(id).set({ kind: "day", day: id.slice(1, 11), device, attempts: next });
        this.days.set(id, next);
      });
    }
    return { added: list.length };
  }

  saveProfile() {
    if (this.readOnly) return Promise.resolve();
    const body = structuredClone(this.profile);
    return this.serial(() => this.col().doc("profile").set(body));
  }
  saveNote(n) {
    const { qid, ...rest } = n;
    this.profile.notes[qid] = rest;
    clearTimeout(this._noteT);
    return new Promise((ok) => { this._noteT = setTimeout(() => this.saveProfile().then(ok, ok), 600); });
  }
  saveSettings(s) { this.profile.settings = { ...s }; return this.saveProfile(); }
  saveExam(e) {
    if (this.readOnly) return Promise.resolve();
    return this.serial(() => this.col().doc(`x${e.id}`).set({ kind: "exam", ts: e.ts, result: e.result }));
  }
  async importDump(d) {
    const atts = d.attempts || [];
    await this.sendAttempts(atts, "import");
    for (const n of d.notes || []) { const { qid, ...rest } = n; this.profile.notes[qid] = { ...this.profile.notes[qid], ...rest }; }
    Object.assign(this.profile.settings, d.settings || {});
    await this.saveProfile();
    for (const e of d.exams || []) await this.saveExam(e);
    return { added: atts.length };
  }
  exportUrl() { return null; }
  async downloadBackup() {
    if (!this.downloads) throw new Error("이 화면에서는 파일 저장을 쓸 수 없습니다");
    const all = await this.loadAll();
    const dump = { schema: 1, exported: nowIso(), ...all };
    const name = `quiz-backup-${nowIso().slice(0, 16).replace(/[-:T]/g, "")}.json`;
    await this.downloads.save({ filename: name, data: JSON.stringify(dump) });
  }
}

// ---------------- 웹사이트(GitHub Pages): 브라우저 저장 ----------------
// 서버 없이 이 기기 브라우저의 IndexedDB에 저장한다. 기기를 바꿀 때는 JSON 백업으로 옮긴다.
const IDB_NAME = "ham1stgrade-quiz";

function idbOpen() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("attempts", { keyPath: "uid" });
      db.createObjectStore("notes", { keyPath: "qid" });
      db.createObjectStore("exams", { keyPath: "id" });
      db.createObjectStore("kv");
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

function idbTx(db, stores, mode, fn) {
  return new Promise((ok, fail) => {
    const tx = db.transaction(stores, mode);
    const out = fn(tx);
    tx.oncomplete = () => ok(out);
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
  });
}

function idbAll(db, store) {
  return new Promise((ok, fail) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

export class BrowserStore extends QueuedStore {
  constructor() {
    super();
    this.useHash = true; this.online = true;
    this.whereText = "풀이 기록은 이 기기의 이 브라우저에만 저장됩니다(서버로 보내지 않음). 브라우저 데이터를 지우면 기록도 지워지니 가끔 JSON 백업을 내려받아 두세요. 다른 기기로 옮길 때도 백업 파일을 가져오면 됩니다.";
    this.failHint = "브라우저가 사이트 데이터 저장을 막고 있지 않은지(사생활 보호 모드 등) 확인하세요.";
  }
  async init() {
    this.db = await idbOpen();
    // 저장 공간을 브라우저가 임의로 지우지 않도록 요청 (지원하는 브라우저만)
    try { if (navigator.storage?.persist) this.persisted = await navigator.storage.persist(); } catch { /* 무시 */ }
  }
  imageHtml(q) { return `<img src="img/${q.id}.png?v=${this.ver || ""}" alt="${escAttr(q.question)}" loading="lazy">`; }
  async loadBank() { const b = await fetch("bank.json").then((r) => r.json()); this.ver = b.built; return b; }
  async loadAll() {
    await this.flush();
    const [attempts, notes, exams, kv] = await Promise.all(
      ["attempts", "notes", "exams"].map((s) => idbAll(this.db, s)).concat(this.getKv("settings")));
    attempts.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    exams.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    return { attempts, notes, exams, settings: kv || {} };
  }
  getKv(k) {
    return new Promise((ok, fail) => {
      const r = this.db.transaction("kv").objectStore("kv").get(k);
      r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
    });
  }
  sendAttempts(list) {
    // keyPath가 uid라서 같은 기록을 다시 넣어도 하나만 남음
    return idbTx(this.db, ["attempts"], "readwrite", (tx) => { for (const a of list) tx.objectStore("attempts").put(a); return { added: list.length }; });
  }
  saveNote(n) { return idbTx(this.db, ["notes"], "readwrite", (tx) => tx.objectStore("notes").put({ ...n })); }
  saveSettings(s) { return idbTx(this.db, ["kv"], "readwrite", (tx) => tx.objectStore("kv").put({ ...s }, "settings")); }
  saveExam(e) { return idbTx(this.db, ["exams"], "readwrite", (tx) => tx.objectStore("exams").put(e)); }
  async importDump(d) {
    const atts = d.attempts || [];
    const before = (await idbAll(this.db, "attempts")).length;
    await this.sendAttempts(atts);
    await idbTx(this.db, ["notes", "exams"], "readwrite", (tx) => {
      for (const n of d.notes || []) tx.objectStore("notes").put(n);
      for (const e of d.exams || []) tx.objectStore("exams").put(e);
    });
    if (d.settings) await this.saveSettings({ ...((await this.getKv("settings")) || {}), ...d.settings });
    return { added: (await idbAll(this.db, "attempts")).length - before };
  }
  exportUrl() { return null; }
  async downloadBackup() {
    const all = await this.loadAll();
    const blob = new Blob([JSON.stringify({ schema: 1, exported: nowIso(), ...all })], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `quiz-backup-${nowIso().slice(0, 16).replace(/[-:T]/g, "")}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

export function createStore() {
  // claude.ai 아티팩트 안에서는 window.claude.use가 있다
  if (window.claude && typeof window.claude.use === "function") return new ArtifactStore();
  // 웹사이트 빌드는 index.html에서 window.QUIZ_STORE = "browser"를 지정한다
  if (window.QUIZ_STORE === "browser") return new BrowserStore();
  return new LocalServerStore("");
}
