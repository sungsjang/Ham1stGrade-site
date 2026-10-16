// 통계 화면 — 풀이 기록과 카드 상태만으로 계산 (저장소와 무관)
import { BOX_LABEL, P_CORRECT, dayStr, addDays } from "./srs.js";

const BOX_VARS = [0, 1, 2, 3, 4, 5, 6].map((b) => `var(--b${b})`);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 공용 툴팁: data-tip 속성을 가진 요소에 마우스를 올리면 표시
const tip = document.getElementById("tip");
document.addEventListener("mouseover", (e) => {
  const t = e.target.closest("[data-tip]");
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.dataset.tip; tip.hidden = false;
});
document.addEventListener("mousemove", (e) => {
  if (tip.hidden) return;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`; tip.style.top = `${e.clientY + 14}px`;
});

export function streakDays(attempts) {
  const days = new Set(attempts.map((a) => a.ts.slice(0, 10)));
  let d = dayStr();
  if (!days.has(d)) d = addDays(d, -1); // 오늘 아직 안 했으면 어제부터 셈
  let n = 0;
  while (days.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

function boxCounts(ctx, subject) {
  const counts = new Array(7).fill(0);
  for (const g of ctx.usableGroups) {
    if (subject && ctx.qmap.get(g).subject !== subject) continue;
    counts[ctx.cards.get(g)?.box ?? 0]++;
  }
  return counts;
}

function stackBar(counts, label) {
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  return `<div class="stack" role="img" aria-label="${esc(label)} 암기 단계 분포">${counts.map((n, b) => n
    ? `<div style="width:${(n / total) * 100}%;background:${BOX_VARS[b]}" data-tip="<b>${esc(label)}</b><br>${BOX_LABEL[b]}: ${n}개 (${pct(n, total)}%)"></div>` : "").join("")}</div>`;
}

function legend() {
  return `<div class="legend">${BOX_LABEL.map((l, b) => `<span><i style="background:${BOX_VARS[b]}"></i>${l}</span>`).join("")}</div>`;
}

export function renderMiniProgress(el, ctx) {
  el.innerHTML = legend() + ctx.bank.subjects.map((s) => {
    const c = boxCounts(ctx, s), total = c.reduce((a, b) => a + b, 0);
    return `<div class="subjrow"><span>${s}</span>${stackBar(c, s)}<span class="small muted">${total - c[0]}/${total}</span></div>`;
  }).join("");
}

// 과목별 예상 점수: 각 묶음을 '출제 빈도(묶음 크기)'로 가중해 단계별 정답 확률을 평균
function predicted(ctx, subject) {
  let w = 0, p = 0;
  for (const g of ctx.usableGroups) {
    if (ctx.qmap.get(g).subject !== subject) continue;
    const size = ctx.gmap.get(g).length;
    w += size; p += size * P_CORRECT[ctx.cards.get(g)?.box ?? 0];
  }
  return w ? Math.round((p / w) * 100) : null;
}

function weekly(attempts, weeks = 12) {
  const start = addDays(dayStr(), -7 * weeks + 1);
  const out = [];
  for (let i = 0; i < weeks; i++) out.push({ from: addDays(start, i * 7), n: 0, ok: 0 });
  for (const a of attempts) {
    const d = a.ts.slice(0, 10);
    if (d < start) continue;
    const i = Math.floor((Date.parse(d) - Date.parse(start)) / (7 * 864e5));
    if (out[i]) { out[i].n++; out[i].ok += a.correct; }
  }
  return out;
}

// 주별 정답률(선) — 단일 계열이라 범례 없이 제목으로 설명
function lineChart(data) {
  const W = 640, H = 200, L = 36, R = 12, T = 12, B = 28;
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, data.length - 1);
  const y = (v) => T + (1 - v / 100) * (H - T - B);
  const pts = data.map((d, i) => ({ i, v: pct(d.ok, d.n), d })).filter((p) => p.v !== null);
  const grid = [0, 50, 100].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`).join("");
  const xl = data.map((d, i) => (i % 2 === 0 || i === data.length - 1) ? `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === data.length - 1 ? "end" : i === 0 ? "start" : "middle"}">${d.from.slice(5).replace("-", "/")}</text>` : "").join("");
  const path = pts.map((p, k) => `${k ? "L" : "M"}${x(p.i)},${y(p.v)}`).join(" ");
  const dots = pts.map((p) => `<circle cx="${x(p.i)}" cy="${y(p.v)}" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>
    <rect x="${x(p.i) - 16}" y="${T}" width="32" height="${H - T - B}" fill="transparent" data-tip="<b>${p.d.from} 주</b><br>정답률 ${p.v}%<br>풀이 ${p.d.n}건"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="주별 정답률 추이">${grid}${xl}
    ${pts.length > 1 ? `<path d="${path}" fill="none" stroke="var(--series-1)" stroke-width="2"/>` : ""}${dots}</svg>`;
}

function heatmap(attempts, weeks = 20) {
  const per = new Map();
  for (const a of attempts) { const d = a.ts.slice(0, 10); per.set(d, (per.get(d) || 0) + 1); }
  const today = dayStr();
  let start = addDays(today, -(weeks * 7 - 1));
  start = addDays(start, -((new Date(`${start}T00:00`).getDay() + 6) % 7)); // 첫 칸을 월요일로
  const max = Math.max(1, ...per.values());
  const cells = [];
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const n = per.get(d) || 0;
    const lvl = n === 0 ? 0 : Math.min(5, 1 + Math.floor((n / max) * 4.999));
    cells.push(`<div style="background:var(--h${lvl})" data-tip="${d}<br>${n}문제"></div>`);
  }
  return `<div class="heat" role="img" aria-label="최근 ${weeks}주 학습량">${cells.join("")}</div>
    <div class="legend"><span>적음</span>${[0, 1, 2, 3, 4, 5].map((l) => `<i style="background:var(--h${l})"></i>`).join("")}<span>많음</span></div>`;
}

export function renderStats(el, ctx) {
  const { attempts, bank } = ctx;
  const today = dayStr();
  const groups = ctx.usableGroups;
  const seen = groups.filter((g) => ctx.cards.get(g)).length;
  const mastered = groups.filter((g) => ctx.cards.get(g)?.box === 6).length;
  const due = groups.filter((g) => { const c = ctx.cards.get(g); return c && c.box >= 1 && c.due <= today; }).length;
  const ok = attempts.filter((a) => a.correct).length;
  const weekAgo = addDays(today, -6);
  const rule = bank.exam.pass;

  const subjRows = bank.subjects.map((s) => {
    const as = attempts.filter((a) => ctx.qmap.get(a.qid)?.subject === s);
    const recent = as.filter((a) => a.ts.slice(0, 10) >= weekAgo);
    const c = boxCounts(ctx, s), total = c.reduce((a, b) => a + b, 0);
    const pred = predicted(ctx, s);
    return { s, total, seen: total - c[0], acc: pct(as.filter((a) => a.correct).length, as.length),
      rec: pct(recent.filter((a) => a.correct).length, recent.length), pred, n: as.length };
  });
  const predAvg = Math.round(subjRows.reduce((a, r) => a + (r.pred || 0), 0) / subjRows.length);
  const predPass = predAvg >= rule.average_min && subjRows.every((r) => (r.pred || 0) >= rule.subject_min);

  // 많이 틀린 문항 Top 20
  const wrongBy = new Map();
  for (const a of attempts) if (!a.correct) wrongBy.set(a.qid, (wrongBy.get(a.qid) || 0) + 1);
  const top = [...wrongBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  el.innerHTML = `<h1>통계</h1>
  <div class="grid">
    <div class="kpi"><div class="v">${seen} / ${groups.length}</div><div class="l">학습한 묶음</div></div>
    <div class="kpi"><div class="v">${mastered}</div><div class="l">암기완료</div></div>
    <div class="kpi"><div class="v">${due}</div><div class="l">오늘 복습 대기</div></div>
    <div class="kpi"><div class="v">${attempts.length}</div><div class="l">총 풀이 (정답률 ${pct(ok, attempts.length) ?? "-"}%)</div></div>
    <div class="kpi"><div class="v">${streakDays(attempts)}일</div><div class="l">연속 학습</div></div>
  </div>

  <div class="card" style="margin-top:16px"><h2>과목별 현황</h2>
    <div class="tablewrap"><table><thead><tr><th>과목</th><th class="num">묶음</th><th class="num">학습</th><th class="num">풀이</th>
      <th class="num">정답률</th><th class="num">최근 7일</th><th class="num">예상 점수</th></tr></thead><tbody>
    ${subjRows.map((r) => `<tr><td>${r.s}</td><td class="num">${r.total}</td><td class="num">${r.seen}</td><td class="num">${r.n}</td>
      <td class="num">${r.acc ?? "-"}${r.acc !== null ? "%" : ""}</td><td class="num">${r.rec ?? "-"}${r.rec !== null ? "%" : ""}</td>
      <td class="num">${r.pred}점 ${r.pred >= rule.subject_min ? "" : `<span class="fail" title="과락 기준 미달">✖</span>`}</td></tr>`).join("")}
    </tbody></table></div>
    <p>예상 평균 <strong>${predAvg}점</strong> — <span class="${predPass ? "pass" : "fail"}">${predPass ? "✔ 합격권" : "✖ 아직 합격권 아님"}</span>
      <span class="small muted">(기준: 과목별 ${rule.subject_min}점·평균 ${rule.average_min}점. 문제별 암기 단계와 출제 빈도로 추정한 값입니다. 안 본 문제는 찍어서 맞힐 확률 25%로 계산)</span></p>
  </div>

  <div class="card"><h2>과목별 암기 단계</h2>${legend()}
    ${bank.subjects.map((s) => { const c = boxCounts(ctx, s); return `<div class="subjrow"><span>${s}</span>${stackBar(c, s)}<span class="small muted">${c[6]} 완료</span></div>`; }).join("")}
  </div>

  <div class="card"><h2>주별 정답률 (최근 12주)</h2>${attempts.length ? lineChart(weekly(attempts)) : `<p class="muted">기록이 쌓이면 표시됩니다.</p>`}
    <details><summary class="small">표로 보기</summary><table><thead><tr><th>주 시작</th><th class="num">풀이</th><th class="num">정답률</th></tr></thead><tbody>
    ${weekly(attempts).map((w) => `<tr><td>${w.from}</td><td class="num">${w.n}</td><td class="num">${pct(w.ok, w.n) ?? "-"}</td></tr>`).join("")}</tbody></table></details></div>

  <div class="card"><h2>학습 달력 (최근 20주)</h2>${heatmap(attempts)}</div>

  <div class="card"><h2>많이 틀린 문제 Top 20</h2>
    ${top.length ? `<div class="tablewrap"><table><thead><tr><th>문항</th><th>과목</th><th>문제</th><th class="num">틀린 횟수</th><th>현재 단계</th></tr></thead><tbody>
    ${top.map(([qid, n]) => { const q = ctx.qmap.get(qid); return q ? `<tr><td>${qid}</td><td>${q.subject}</td><td>${esc(q.question.slice(0, 70))}</td><td class="num">${n}</td><td>${BOX_LABEL[ctx.cards.get(q.gid)?.box ?? 0]}</td></tr>` : ""; }).join("")}
    </tbody></table></div>` : `<p class="muted">아직 틀린 문제가 없습니다.</p>`}</div>`;
}
