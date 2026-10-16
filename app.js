// 퀴즈 앱 본체 — 화면 라우팅, 학습 세션, 모의고사, 오답노트, 설정.
import { createStore, uid, nowIso } from "./store.js";
import { apply, replay, newCard, dayStr, isDueToday, BOX_LABEL } from "./srs.js";
import { renderStats, renderMiniProgress, streakDays } from "./stats.js";

const DEFAULTS = {
  newPerDay: 30,          // 하루 새 문제(묶음) 수
  includeUncertain: false, // '확인필요' 문항도 학습에 포함
  showText: false,         // 문제 텍스트를 기본으로 펼침
  examMinutes: 90,
  examIncludeMorse: true,  // 모의고사에 무선통신술 포함
  theme: "auto",
};

const store = createStore();
const S = { bank: null, qmap: new Map(), gmap: new Map(), attempts: [], notes: new Map(),
  settings: { ...DEFAULTS }, exams: [], cards: new Map(), session: null, exam: null };
const $app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CIRC = ["", "①", "②", "③", "④"];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- 데이터 ----------
async function load() {
  S.bank = await store.loadBank();
  for (const q of S.bank.questions) S.qmap.set(q.id, q);
  for (const [gid, ids] of Object.entries(S.bank.groups)) S.gmap.set(gid, ids.map((id) => S.qmap.get(id)));
  const all = await store.loadAll();
  S.attempts = all.attempts;
  S.notes = new Map(all.notes.map((n) => [n.qid, n]));
  S.settings = { ...DEFAULTS, ...all.settings };
  S.exams = all.exams;
  S.cards = replay(S.attempts, (qid) => S.qmap.get(qid)?.gid);
  applyTheme();
}

const usable = (q) => q && q.answerable && (S.settings.includeUncertain || !q.uncertain);
const usableMembers = (gid) => (S.gmap.get(gid) || []).filter(usable);
const usableGroups = () => [...S.gmap.keys()].filter((g) => usableMembers(g).length);
const card = (gid) => S.cards.get(gid);
const subjOfGroup = (gid) => S.qmap.get(gid).subject;

function attemptCount(qid) {
  let n = 0; for (const a of S.attempts) if (a.qid === qid) n++; return n;
}

// 묶음에서 이번에 보여 줄 문항: 틀렸던 문항 우선, 다음은 덜 푼 문항
function pickMember(gid, avoid) {
  const ms = usableMembers(gid);
  if (!ms.length) return null;
  const c = card(gid);
  const scored = ms.map((q) => ({ q, w: (c?.wrongQ[q.id] || 0) * 10 - attemptCount(q.id) + Math.random() - (q.id === avoid ? 100 : 0) }));
  scored.sort((a, b) => b.w - a.w);
  return scored[0].q;
}

function record(q, chosen, correct, confident, mode, ms) {
  const a = { uid: uid(), ts: nowIso(), qid: q.id, chosen, correct: correct ? 1 : 0,
    confident: confident === null ? null : confident ? 1 : 0, mode, ms, session_id: S.session?.sid || S.exam?.id || null };
  S.attempts.push(a);
  if (!S.cards.has(q.gid)) S.cards.set(q.gid, newCard(q.gid));
  apply(S.cards.get(q.gid), a);
  store.addAttempts([a]).then(syncBadge);
  syncBadge();
}

function syncBadge() {
  const el = document.getElementById("sync");
  const p = store.pending ? store.pending() : 0;
  el.textContent = p ? `⚠ 저장 대기 ${p}건 (서버 연결 확인)` : `✓ 저장됨 · 기록 ${S.attempts.length}건`;
}

function applyTheme() {
  const t = S.settings.theme;
  const root = document.documentElement;
  if (t === "auto") { if (S.themeSet) { root.removeAttribute("data-theme"); S.themeSet = false; } }
  else { root.setAttribute("data-theme", t); S.themeSet = true; }
}

// ---------- 세션 만들기 ----------
function buildDaily() {
  const today = dayStr();
  const groups = usableGroups();
  const due = groups.filter((g) => isDueToday(card(g), today))
    .sort((a, b) => (card(a).due < card(b).due ? -1 : card(a).due > card(b).due ? 1 : card(b).lapses - card(a).lapses));
  const newToday = [...S.cards.values()].filter((c) => c.first === today && usableMembers(c.gid).length).length;
  const quota = Math.max(0, S.settings.newPerDay - newToday);
  // 새 문제: 자주 출제된 묶음부터, 같은 빈도 안에서는 무작위
  const fresh = shuffle(groups.filter((g) => !card(g) || card(g).box === 0))
    .sort((a, b) => S.gmap.get(b).length - S.gmap.get(a).length).slice(0, quota);
  const items = [];
  let i = 0, j = 0;
  while (i < due.length || j < fresh.length) {
    if (i < due.length) items.push(due[i++]);
    if (i < due.length) items.push(due[i++]);
    if (j < fresh.length) items.push(fresh[j++]);
  }
  return { items: items.map((g) => ({ gid: g, qid: pickMember(g).id })), due: due.length, fresh: fresh.length };
}

function buildWrong(limit = 50) {
  const gs = usableGroups().filter((g) => card(g)?.lapses > 0)
    .sort((a, b) => card(a).box - card(b).box || card(b).lapses - card(a).lapses);
  return gs.slice(0, limit).map((g) => ({ gid: g, qid: pickMember(g).id }));
}

function buildPractice(opt) {
  let qs = S.bank.questions.filter(usable)
    .filter((q) => !opt.subjects.length || opt.subjects.includes(q.subject))
    .filter((q) => !opt.sessions.length || opt.sessions.includes(`${q.year}-${q.session}`));
  if (opt.filter === "unseen") qs = qs.filter((q) => !card(q.gid));
  if (opt.filter === "wrong") qs = qs.filter((q) => card(q.gid)?.wrongQ[q.id]);
  if (opt.filter === "star") qs = qs.filter((q) => S.notes.get(q.id)?.star);
  if (opt.filter === "weak") qs = qs.filter((q) => (card(q.gid)?.box ?? 0) <= 2);
  if (opt.order === "random") shuffle(qs);
  else qs.sort((a, b) => b.year - a.year || b.session - a.session || a.no - b.no);
  return qs.slice(0, opt.count).map((q) => ({ gid: q.gid, qid: q.id }));
}

function startSession(mode, items, title) {
  if (!items.length) { $app.innerHTML = `<div class="card"><h2>${esc(title)}</h2><p>풀 문제가 없습니다. 🎉</p><a class="btn" href="#/">홈으로</a></div>`; return; }
  S.session = { mode, title, items, i: 0, sid: uid(), requeued: new Set(), results: [] };
  renderQuestion();
}

// ---------- 문제 화면 ----------
function questionBlock(q, showText) {
  const c = card(q.gid);
  const grp = S.gmap.get(q.gid) || [];
  const flags = [];
  if (q.uncertain) flags.push(`<span class="badge warn" title="복수정답·원문 오류 등으로 판단 보류">⚠ 확인필요</span>`);
  if (q.verdict === "불일치") flags.push(`<span class="badge bad" title="표기정답이 틀렸다고 판단해 검증정답으로 채점">표기정답 수정됨</span>`);
  if (q.subject === "전파법규") flags.push(`<span class="badge" title="출제 당시 법령 기준">출제 당시 법령</span>`);
  return `
  <div class="qhead">
    <span class="badge">${esc(q.subject)}</span>
    <strong>${q.year}년 ${q.session}회 ${q.no}번</strong>
    ${grp.length > 1 ? `<span class="badge" title="같은 문제가 출제된 횟수">${grp.length}회 출제</span>` : ""}
    <span class="badge" title="이 문제의 암기 단계">${BOX_LABEL[c?.box ?? 0]}</span>
    ${flags.join(" ")}
  </div>
  ${q.hideImg
    // 원본 사진에 응시자 답 표시가 있는 문항: 텍스트로 풀고, 원본은 답을 확인한 뒤 '원본 보기'로만
    ? `${q.figImg ? `<div class="qimg" id="qimg" title="클릭하면 확대">${store.imageHtml(q, q.figImg.replace(/\.png$/, ""))}</div>` : ""}
  <div class="qtext"><p>${esc(q.question)}</p><ol>${q.choices.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>
    <p class="muted small">원본 사진에는 응시자의 답 표시가 있어 답을 확인한 뒤 '원본 보기'로 볼 수 있습니다.</p></div>`
    : `<div class="qimg" id="qimg" title="클릭하면 확대">${store.imageHtml(q)}</div>
  <details class="qtext" ${showText ? "open" : ""}><summary>텍스트로 보기${q.fig ? " (그림·기호는 이미지 참고)" : ""}</summary>
    <p>${esc(q.question)}</p><ol>${q.choices.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>
  </details>`}`;
}

function infoBlock(q) {
  const grp = (S.gmap.get(q.gid) || []).filter((x) => x.id !== q.id);
  const n = S.notes.get(q.id) || { text: "", star: 0, flag: 0 };
  return `<div class="info">
    ${q.printed == null && q.answer ? `<p>공식 정답이 없어 직접 풀어 정한 답입니다: <strong>${CIRC[q.answer]}</strong></p>`
      : q.printed !== q.answer ? `<p>${q.src && q.src !== "정리본" ? `표기정답(${esc(q.src)})` : "정리본 표기정답"}: ${CIRC[q.printed] || "없음"} → 검증정답: <strong>${CIRC[q.answer] || "판단 보류"}</strong></p>` : ""}
    ${q.hideImg ? `<details class="orig"><summary>원본 보기 (응시자 표시가 있는 사진)</summary><div class="qimg">${store.imageHtml(q)}</div></details>` : ""}
    ${q.memo ? `<p>💡 ${esc(q.memo)}</p>` : ""}
    ${q.hint ? `<p>📝 원문 힌트: ${esc(q.hint)}</p>` : ""}
    ${q.history ? `<p>기출이력: ${esc(q.history)}</p>` : ""}
    ${grp.length ? `<p>같은 문제: ${grp.map((x) => `${x.year}년 ${x.session}회 ${x.no}번`).join(", ")}</p>` : ""}
    <div class="note row" style="margin-top:8px">
      <textarea id="note" placeholder="내 메모 (자동 저장)">${esc(n.text)}</textarea>
      <button class="toggle ${n.star ? "on" : ""}" id="star" title="즐겨찾기">⭐ 즐겨찾기</button>
      <button class="toggle ${n.flag ? "on" : ""}" id="flag" title="문제나 정답이 이상하면 표시">🚩 오류 의심</button>
    </div></div>`;
}

function bindNote(q) {
  const get = () => S.notes.get(q.id) || { qid: q.id, text: "", star: 0, flag: 0 };
  const save = (patch) => { const n = { ...get(), ...patch, qid: q.id, updated: nowIso() }; S.notes.set(q.id, n); store.saveNote(n); };
  const t = document.getElementById("note");
  t?.addEventListener("change", () => save({ text: t.value }));
  for (const k of ["star", "flag"]) {
    const b = document.getElementById(k);
    b?.addEventListener("click", () => { const v = get()[k] ? 0 : 1; save({ [k]: v }); b.classList.toggle("on", !!v); });
  }
}

function bindZoom() {
  const box = document.getElementById("qimg");
  box?.addEventListener("click", () => box.classList.toggle("zoom"));
}

function renderQuestion() {
  const s = S.session;
  if (s.i >= s.items.length) return renderSummary();
  const it = s.items[s.i];
  const q = S.qmap.get(it.qid);
  s.cur = { q, start: performance.now(), answered: false };
  $app.innerHTML = `
  <div class="row"><h2 style="margin:0">${esc(s.title)}</h2><span class="spacer"></span>
    <span class="muted small">${s.i + 1} / ${s.items.length}</span>
    <button id="quit">그만하기</button></div>
  <div class="progress" style="margin-top:8px"><div style="width:${(s.i / s.items.length) * 100}%"></div></div>
  <div class="card">
    ${questionBlock(q, S.settings.showText)}
    <div class="choices" id="choices">
      ${[1, 2, 3, 4].map((k) => `<button data-k="${k}">${CIRC[k]}</button>`).join("")}
    </div>
    <div class="row"><button id="dunno">모르겠음 <kbd>0</kbd></button><span class="muted small">키보드: 1~4 선택</span></div>
    <div id="after"></div>
  </div>`;
  bindZoom();
  document.getElementById("quit").onclick = renderSummary;
  document.getElementById("dunno").onclick = () => answer(null);
  for (const b of document.querySelectorAll("#choices button")) b.onclick = () => answer(+b.dataset.k);
}

function answer(k) {
  const s = S.session, cur = s.cur;
  if (cur.answered) return;
  cur.answered = true;
  cur.ms = Math.round(performance.now() - cur.start);
  const q = cur.q, ok = k === q.answer;
  cur.k = k; cur.ok = ok;
  for (const b of document.querySelectorAll("#choices button")) {
    const kk = +b.dataset.k; b.disabled = true;
    if (kk === q.answer) b.classList.add("right");
    if (kk === k && !ok) b.classList.add("wrong");
  }
  document.getElementById("dunno").disabled = true;
  const after = document.getElementById("after");
  if (ok) {
    after.innerHTML = `<p class="verdict ok">⭕ 정답 ${CIRC[q.answer]}</p>
      <div class="row"><button class="primary" id="sure">확실히 알았음 <kbd>Enter</kbd></button>
      <button id="unsure">헷갈렸음/찍었음 <kbd>H</kbd></button></div>${infoBlock(q)}`;
    document.getElementById("sure").onclick = () => finish(true);
    document.getElementById("unsure").onclick = () => finish(false);
  } else {
    record(q, k, false, null, s.mode, cur.ms);
    s.results.push({ qid: q.id, ok: false });
    requeue(q);
    after.innerHTML = `<p class="verdict no">❌ ${k ? `${CIRC[k]} 오답` : "모름"} · 정답 ${CIRC[q.answer]} <span class="muted small">(잠시 뒤 다시 나옵니다)</span></p>
      <div class="row"><button class="primary" id="next">다음 <kbd>Enter</kbd></button></div>${infoBlock(q)}`;
    document.getElementById("next").onclick = next;
  }
  bindNote(q);
}

function finish(confident) {
  const s = S.session, cur = s.cur;
  if (cur.done) return;
  cur.done = true;
  record(cur.q, cur.k, true, confident, s.mode, cur.ms);
  s.results.push({ qid: cur.q.id, ok: true, confident });
  next();
}

function next() { S.session.i++; renderQuestion(); }

// 틀린 문제는 5문제 뒤에 한 번 더(같은 묶음의 다른 회차 문항이 있으면 그것으로)
function requeue(q) {
  const s = S.session;
  if (s.requeued.has(q.gid)) return;
  s.requeued.add(q.gid);
  const alt = pickMember(q.gid, q.id) || q;
  s.items.splice(Math.min(s.i + 6, s.items.length), 0, { gid: q.gid, qid: alt.id });
}

function renderSummary() {
  const s = S.session;
  if (!s) return go("#/");
  const n = s.results.length, ok = s.results.filter((r) => r.ok).length;
  const wrong = [...new Set(s.results.filter((r) => !r.ok).map((r) => r.qid))];
  S.session = null;
  $app.innerHTML = `<div class="card"><h2>${esc(s.title)} 결과</h2>
    <div class="grid">
      <div class="kpi"><div class="v">${n}</div><div class="l">푼 문제</div></div>
      <div class="kpi"><div class="v">${n ? Math.round((ok / n) * 100) : 0}%</div><div class="l">정답률</div></div>
      <div class="kpi"><div class="v">${wrong.length}</div><div class="l">틀린 문제</div></div>
    </div>
    ${wrong.length ? `<h3 style="margin-top:16px">틀린 문제</h3><ul>${wrong.map((id) => { const q = S.qmap.get(id); return `<li>${q.year}년 ${q.session}회 ${q.no}번 · ${esc(q.question.slice(0, 60))}</li>`; }).join("")}</ul>` : ""}
    <div class="row" style="margin-top:12px"><a class="btn primary" href="#/">홈으로</a>
    ${wrong.length ? `<button id="again">틀린 문제만 다시</button>` : ""}</div></div>`;
  const again = document.getElementById("again");
  if (again) again.onclick = () => startSession("wrong", wrong.map((id) => ({ gid: S.qmap.get(id).gid, qid: id })), "틀린 문제 다시");
}

// ---------- 키보드 ----------
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
  if (S.exam && S.route === "#/exam/run") return examKey(e);
  const s = S.session;
  if (!s || !s.cur) return;
  if (!s.cur.answered) {
    if ("1234".includes(e.key)) answer(+e.key);
    else if (e.key === "0") answer(null);
  } else if (e.key === "Enter") {
    if (s.cur.ok) finish(true); else if (!s.cur.navigated) { s.cur.navigated = true; next(); }
  } else if ((e.key === "h" || e.key === "H" || e.key === "ㅗ") && s.cur.ok) finish(false);
});

// ---------- 홈 ----------
function renderHome() {
  const today = dayStr();
  const groups = usableGroups();
  const due = groups.filter((g) => isDueToday(card(g), today)).length;
  const newToday = [...S.cards.values()].filter((c) => c.first === today).length;
  const quota = Math.max(0, S.settings.newPerDay - newToday);
  const unseen = groups.filter((g) => !card(g)).length;
  const wrong = groups.filter((g) => card(g)?.lapses > 0 && card(g).box <= 3).length;
  const todayAttempts = S.attempts.filter((a) => a.ts.startsWith(today));
  const todayOk = todayAttempts.filter((a) => a.correct).length;
  $app.innerHTML = `
  <div class="card">
    <h1>오늘의 학습</h1>
    <p class="muted">복습할 문제 <strong>${due}</strong>개 · 새 문제 <strong>${Math.min(quota, unseen)}</strong>개
      ${quota === 0 ? "(오늘 새 문제 할당량을 채웠습니다)" : ""}</p>
    <div class="row"><a class="btn primary" href="#/study/daily">학습 시작</a>
      <a class="btn" href="#/study/wrong">오답 집중 (${wrong})</a>
      <a class="btn" href="#/exam">모의고사</a></div>
  </div>
  <div class="grid">
    <div class="kpi"><div class="v">${todayAttempts.length}</div><div class="l">오늘 푼 문제 (정답 ${todayOk})</div></div>
    <div class="kpi"><div class="v">${streakDays(S.attempts)}일</div><div class="l">연속 학습</div></div>
    <div class="kpi"><div class="v">${groups.length - unseen} / ${groups.length}</div><div class="l">학습한 문제 (묶음)</div></div>
    <div class="kpi"><div class="v">${groups.filter((g) => card(g)?.box === 6).length}</div><div class="l">암기완료</div></div>
  </div>
  <div class="card" style="margin-top:16px"><h2>과목별 진도</h2><div id="mini"></div>
    <p class="small muted">같은 문제가 여러 회차에 나온 것은 하나의 묶음으로 셉니다(${S.qmap.size.toLocaleString()}문항 → ${S.gmap.size}묶음). <a href="#/stats">자세한 통계 →</a></p></div>`;
  renderMiniProgress(document.getElementById("mini"), ctx());
}

// ---------- 오답노트 ----------
function renderWrongNote() {
  const rows = [];
  for (const q of S.bank.questions) {
    const c = card(q.gid);
    const w = c?.wrongQ[q.id] || 0;
    if (w) rows.push({ q, w, box: c.box });
  }
  rows.sort((a, b) => a.box - b.box || b.w - a.w);
  const stars = S.bank.questions.filter((q) => S.notes.get(q.id)?.star);
  const flags = S.bank.questions.filter((q) => S.notes.get(q.id)?.flag);
  $app.innerHTML = `<div class="card"><div class="row"><h1 style="margin:0">오답노트</h1><span class="spacer"></span>
    <a class="btn primary" href="#/study/wrong">오답 집중 학습</a></div>
    <p class="muted">틀린 적 있는 문항 ${rows.length}개 · 암기 단계가 낮은 것부터</p>
    <div class="tablewrap"><table><thead><tr><th>문항</th><th>과목</th><th>문제</th><th class="num">틀린 횟수</th><th>현재 단계</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${r.q.id}</td><td>${r.q.subject}</td><td>${esc(r.q.question.slice(0, 70))}</td><td class="num">${r.w}</td><td>${BOX_LABEL[r.box]}</td>
      <td><button data-q="${r.q.id}">풀기</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">아직 틀린 문제가 없습니다.</td></tr>`}
    </tbody></table></div></div>
    <div class="card"><h2>⭐ 즐겨찾기 (${stars.length})</h2>${listQs(stars)}</div>
    <div class="card"><h2>🚩 오류 의심 표시 (${flags.length})</h2>${listQs(flags)}
    <p class="small muted">표시한 문항은 data_*.py에서 고친 뒤 build_excel.py, quiz/build_quiz_data.py를 다시 실행하면 반영됩니다.</p></div>`;
  for (const b of $app.querySelectorAll("button[data-q]")) b.onclick = () => {
    const q = S.qmap.get(b.dataset.q); startSession("wrong", [{ gid: q.gid, qid: q.id }], "오답노트");
  };
}

function listQs(qs) {
  if (!qs.length) return `<p class="muted">없음</p>`;
  return `<ul>${qs.map((q) => `<li>${q.id} · ${esc(q.question.slice(0, 70))}${S.notes.get(q.id)?.text ? ` — <em>${esc(S.notes.get(q.id).text)}</em>` : ""}</li>`).join("")}</ul>`;
}

// ---------- 연습 ----------
function renderPractice() {
  const sessions = [...new Set(S.bank.questions.map((q) => `${q.year}-${q.session}`))];
  const chip = (name, v, label) => `<label><input type="checkbox" name="${name}" value="${v}">${label}</label>`;
  $app.innerHTML = `<div class="card"><h1>연습</h1>
    <p class="muted">과목·회차를 골라 풉니다. 풀이는 기록되고 암기 단계에도 반영됩니다(복습일 전에 맞힌 것은 단계를 올리지 않음).</p>
    <label class="field"><span>과목 (선택 안 하면 전체)</span><div class="chips">${S.bank.subjects.map((s) => chip("subj", s, s)).join("")}</div></label>
    <label class="field"><span>회차 (선택 안 하면 전체)</span><div class="chips">${sessions.map((s) => chip("sess", s, s.replace("-", "년 ") + "회")).join("")}</div></label>
    <div class="row">
      <label class="field"><span>대상</span><select id="filter">
        <option value="all">전체</option><option value="unseen">안 푼 문제</option><option value="weak">약한 문제(2단계 이하)</option>
        <option value="wrong">틀린 적 있는 문제</option><option value="star">즐겨찾기</option></select></label>
      <label class="field"><span>순서</span><select id="order"><option value="random">무작위</option><option value="seq">회차·번호 순</option></select></label>
      <label class="field"><span>문항 수</span><input type="number" id="count" value="20" min="1" max="1500"></label>
    </div>
    <button class="primary" id="go">시작</button> <span id="msg" class="muted"></span></div>`;
  document.getElementById("go").onclick = () => {
    const vals = (n) => [...$app.querySelectorAll(`input[name=${n}]:checked`)].map((x) => x.value);
    const items = buildPractice({ subjects: vals("subj"), sessions: vals("sess"), filter: document.getElementById("filter").value,
      order: document.getElementById("order").value, count: +document.getElementById("count").value || 20 });
    if (!items.length) { document.getElementById("msg").textContent = "조건에 맞는 문제가 없습니다."; return; }
    startSession("practice", items, "연습");
  };
}

// ---------- 모의고사 ----------
function renderExamIntro() {
  const comp = S.bank.exam.composition.filter(([s]) => S.settings.examIncludeMorse || s !== "무선통신술");
  const total = comp.reduce((a, [, n]) => a + n, 0);
  const rule = S.bank.exam.pass;
  $app.innerHTML = `<div class="card"><h1>모의고사</h1>
    <p>${comp.map(([s, n]) => `${s} ${n}`).join(" · ")} = <strong>${total}문항</strong>, 제한시간 ${S.settings.examMinutes}분</p>
    <p class="muted">합격 기준(설정값): 과목별 ${rule.subject_min}점 이상, 평균 ${rule.average_min}점 이상. 같은 묶음에서는 한 문항만 나옵니다.
      실제 시험의 과목 구성·기준과 다를 수 있으니 공고를 확인하세요.</p>
    <button class="primary" id="go">시작</button></div>
    ${S.exams.length ? `<div class="card"><h2>지난 모의고사</h2>${examHistory()}</div>` : ""}`;
  document.getElementById("go").onclick = () => startExam(comp);
}

function examHistory() {
  return `<div class="tablewrap"><table><thead><tr><th>일시</th>${S.bank.subjects.map((s) => `<th class="num">${s}</th>`).join("")}<th class="num">평균</th><th>결과</th></tr></thead><tbody>
  ${[...S.exams].reverse().map((e) => { const r = e.result; return `<tr><td>${e.ts.slice(0, 16).replace("T", " ")}</td>
    ${S.bank.subjects.map((s) => { const x = r.subjects.find((y) => y.name === s); return `<td class="num">${x ? x.score : "-"}</td>`; }).join("")}
    <td class="num">${r.avg}</td><td class="${r.pass ? "pass" : "fail"}">${r.pass ? "✔ 합격" : "✖ 불합격"}</td></tr>`; }).join("")}</tbody></table></div>`;
}

function startExam(comp) {
  const items = [];
  for (const [subj, n] of comp) {
    const gs = shuffle(usableGroups().filter((g) => subjOfGroup(g) === subj)).slice(0, n);
    for (const g of gs) items.push(shuffle([...usableMembers(g)])[0]);
  }
  S.exam = { id: uid(), items, answers: new Array(items.length).fill(null), i: 0,
    start: Date.now(), end: Date.now() + S.settings.examMinutes * 60000, comp };
  go("#/exam/run");
}

let examTimer = null;
function renderExamRun() {
  const ex = S.exam;
  if (!ex) return go("#/exam");
  const q = ex.items[ex.i];
  $app.innerHTML = `<div class="row"><h2 style="margin:0">모의고사</h2><span class="spacer"></span>
    <span class="timer" id="timer"></span><button class="primary" id="submit">제출</button></div>
    <div class="card" style="margin-top:10px"><div class="navgrid">${ex.items.map((x, i) => `<button data-i="${i}" class="${ex.answers[i] ? "done" : ""} ${i === ex.i ? "cur" : ""}" title="${x.subject}">${i + 1}</button>`).join("")}</div></div>
    <div class="card"><div class="muted small">${ex.i + 1} / ${ex.items.length}</div>
      ${questionBlock(q, S.settings.showText).replace(/<span class="badge" title="이 문제의 암기 단계">[^<]*<\/span>/, "")}
      <div class="choices" id="choices">${[1, 2, 3, 4].map((k) => `<button data-k="${k}" class="${ex.answers[ex.i] === k ? "right" : ""}">${CIRC[k]}</button>`).join("")}</div>
      <div class="row"><button id="prev">← 이전</button><button id="nxt">다음 →</button><span class="muted small">키보드: 1~4 선택, ←/→ 이동</span></div></div>`;
  bindZoom();
  for (const b of $app.querySelectorAll(".navgrid button")) b.onclick = () => { ex.i = +b.dataset.i; renderExamRun(); };
  for (const b of $app.querySelectorAll("#choices button")) b.onclick = () => examChoose(+b.dataset.k);
  document.getElementById("prev").onclick = () => examMove(-1);
  document.getElementById("nxt").onclick = () => examMove(1);
  document.getElementById("submit").onclick = (e) => {
    const left = ex.answers.filter((x) => !x).length;
    const b = e.currentTarget;
    if (!left || b.dataset.armed) return submitExam();
    b.dataset.armed = "1"; b.textContent = `안 푼 ${left}문제 — 그래도 제출`;
  };
  clearInterval(examTimer);
  const tick = () => {
    const ms = ex.end - Date.now();
    const el = document.getElementById("timer");
    if (!el) return clearInterval(examTimer);
    if (ms <= 0) { clearInterval(examTimer); return submitExam(); }
    el.textContent = `⏱ ${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  };
  tick(); examTimer = setInterval(tick, 1000);
}

function examChoose(k) {
  const ex = S.exam; ex.answers[ex.i] = k;
  if (ex.i < ex.items.length - 1) ex.i++;
  renderExamRun();
}
function examMove(d) { const ex = S.exam; ex.i = Math.max(0, Math.min(ex.items.length - 1, ex.i + d)); renderExamRun(); }
function examKey(e) {
  if ("1234".includes(e.key)) examChoose(+e.key);
  else if (e.key === "ArrowLeft") examMove(-1);
  else if (e.key === "ArrowRight") examMove(1);
}

function submitExam() {
  const ex = S.exam;
  clearInterval(examTimer);
  const rule = S.bank.exam.pass;
  const items = ex.items.map((q, i) => ({ qid: q.id, chosen: ex.answers[i], correct: ex.answers[i] === q.answer }));
  // 풀이 기록에는 실제로 답한 문항만 남긴다(시간이 다 돼 못 푼 문항까지 오답 처리하면 암기 단계가 왜곡됨)
  items.forEach((it, i) => { if (it.chosen) record(ex.items[i], it.chosen, it.correct, it.correct ? true : null, "exam", null); });
  const subjects = ex.comp.map(([name]) => {
    const xs = items.filter((it) => S.qmap.get(it.qid).subject === name);
    const c = xs.filter((x) => x.correct).length;
    return { name, count: xs.length, correct: c, score: xs.length ? Math.round((c / xs.length) * 100) : 0 };
  });
  const avg = Math.round(subjects.reduce((a, s) => a + s.score, 0) / subjects.length);
  const pass = avg >= rule.average_min && subjects.every((s) => s.score >= rule.subject_min);
  const result = { minutes: Math.round((Date.now() - ex.start) / 60000), subjects, avg, pass, items };
  const rec = { id: ex.id, ts: nowIso(), result };
  S.exams.push(rec); store.saveExam(rec);
  S.exam = null;
  S.route = "#/exam/result";
  const wrong = items.filter((x) => !x.correct);
  $app.innerHTML = `<div class="card"><h1>모의고사 결과 <span class="${pass ? "pass" : "fail"}">${pass ? "✔ 합격" : "✖ 불합격"}</span></h1>
    <p>평균 <strong>${avg}점</strong> · 소요 ${result.minutes}분</p>
    <table><thead><tr><th>과목</th><th class="num">맞힌 수</th><th class="num">점수</th><th>과락</th></tr></thead><tbody>
    ${subjects.map((s) => `<tr><td>${s.name}</td><td class="num">${s.correct}/${s.count}</td><td class="num">${s.score}</td>
      <td class="${s.score >= rule.subject_min ? "pass" : "fail"}">${s.score >= rule.subject_min ? "✔ 통과" : "✖ 과락"}</td></tr>`).join("")}</tbody></table>
    <div class="row" style="margin-top:12px"><a class="btn" href="#/exam">모의고사 목록</a>
      ${wrong.length ? `<button class="primary" id="review">틀린 ${wrong.length}문제 복습</button>` : ""}</div></div>`;
  const rv = document.getElementById("review");
  if (rv) rv.onclick = () => startSession("wrong", wrong.map((x) => ({ gid: S.qmap.get(x.qid).gid, qid: x.qid })), "모의고사 오답 복습");
}

// ---------- 설정 ----------
function renderSettings() {
  const st = S.settings;
  $app.innerHTML = `<div class="card"><h1>설정</h1>
    <label class="field"><span>하루 새 문제 수 (묶음 기준)</span><input type="number" id="newPerDay" min="0" max="500" value="${st.newPerDay}"></label>
    <label class="field"><input type="checkbox" id="includeUncertain" ${st.includeUncertain ? "checked" : ""}> '확인필요'(판단 보류) 문항도 학습에 포함</label>
    <label class="field"><input type="checkbox" id="showText" ${st.showText ? "checked" : ""}> 문제 텍스트를 기본으로 펼쳐 보기</label>
    <label class="field"><span>모의고사 제한시간(분)</span><input type="number" id="examMinutes" min="10" max="300" value="${st.examMinutes}"></label>
    <label class="field"><input type="checkbox" id="examIncludeMorse" ${st.examIncludeMorse ? "checked" : ""}> 모의고사에 무선통신술 포함</label>
    <label class="field"><span>화면 테마</span><select id="theme">
      ${[["auto", "시스템 따름"], ["light", "밝게"], ["dark", "어둡게"]].map(([v, l]) => `<option value="${v}" ${st.theme === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <button class="primary" id="save">저장</button> <span id="msg" class="muted"></span></div>
  <div class="card"><h2>백업 · 옮기기</h2>
    <p class="muted">${esc(store.whereText)}
      아래 JSON 백업은 다른 PC나 아티팩트 버전·Anki로 옮길 때 씁니다. 가져오기는 기존 기록에 합쳐집니다(중복 없음).</p>
    <div class="row">${store.exportUrl() ? `<a class="btn" href="${store.exportUrl()}">JSON 백업 내려받기</a>` : `<button id="exp">JSON 백업 내려받기</button>`}
      <label class="btn">JSON 가져오기<input type="file" id="imp" accept=".json" hidden></label><span id="impmsg" class="muted"></span></div></div>`;
  document.getElementById("save").onclick = async () => {
    const v = (id) => document.getElementById(id);
    Object.assign(S.settings, { newPerDay: +v("newPerDay").value, includeUncertain: v("includeUncertain").checked,
      showText: v("showText").checked, examMinutes: +v("examMinutes").value, examIncludeMorse: v("examIncludeMorse").checked, theme: v("theme").value });
    await store.saveSettings(S.settings);
    applyTheme();
    document.getElementById("msg").textContent = "저장했습니다.";
  };
  const exp = document.getElementById("exp");
  if (exp) exp.onclick = async () => {
    try { await store.downloadBackup(); document.getElementById("impmsg").textContent = "백업 파일을 저장했습니다."; }
    catch (err) { document.getElementById("impmsg").textContent = `저장하지 못했습니다 (${err.message || err.code || err}).`; }
  };
  document.getElementById("imp").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = await store.importDump(JSON.parse(await f.text()));
    document.getElementById("impmsg").textContent = `기록 ${r.added}건을 추가했습니다.`;
    await load(); syncBadge();
  };
}

// ---------- 라우팅 ----------
const ctx = () => ({ bank: S.bank, qmap: S.qmap, gmap: S.gmap, attempts: S.attempts, cards: S.cards, exams: S.exams,
  usableGroups: usableGroups(), notes: S.notes });
// 라우팅: A(로컬)는 주소창 해시를 쓰고, B(아티팩트)는 해시를 쓸 수 없어 내부 상태로만 이동한다
function go(h) {
  if (store.useHash) { if (location.hash === h) route(); else location.hash = h; }
  else { S.route = h; route(); }
}
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href^="#/"]');
  if (!a || store.useHash) return;
  e.preventDefault(); go(a.getAttribute("href"));
});

function route() {
  const h = (store.useHash ? location.hash : S.route) || "#/";
  S.route = h;
  if (!h.startsWith("#/exam/run")) clearInterval(examTimer);
  S.session = null; // 다른 화면으로 가면 진행 중이던 학습은 끝냄(이미 푼 문제는 저장됨)
  const top = h.split("/")[1] || "home";
  for (const a of document.querySelectorAll("nav a")) a.classList.toggle("on", a.dataset.nav === (top === "" ? "home" : top));
  window.scrollTo(0, 0);
  if (h === "#/" || h === "#") return renderHome();
  if (h === "#/study/daily") { const d = buildDaily(); return startSession("daily", d.items, `오늘의 학습 (복습 ${d.due} · 새 문제 ${d.fresh})`); }
  if (h === "#/study/wrong") return startSession("wrong", buildWrong(), "오답 집중");
  if (h === "#/wrongnote") return renderWrongNote();
  if (h === "#/practice") return renderPractice();
  if (h === "#/exam") return renderExamIntro();
  if (h === "#/exam/run") return renderExamRun();
  if (h === "#/stats") return renderStats($app, ctx());
  if (h === "#/settings") return renderSettings();
  renderHome();
}

if (store.useHash) window.addEventListener("hashchange", route);
store.init().then(load).then(() => { syncBadge(); route(); }).catch((e) => {
  $app.innerHTML = `<div class="card"><h2>불러오기 실패</h2><p>${esc(e.message)}</p><p class="muted">${esc(store.failHint || "")}</p></div>`;
});
setInterval(() => store.flush && store.flush().then(syncBadge), 30000);
