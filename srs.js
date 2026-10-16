// 간격반복(라이트너 5단계 + 암기완료) — 저장소·화면과 무관한 순수 함수.
// 카드 상태는 저장하지 않고 풀이 기록(attempts)을 처음부터 재생해서 계산한다.
// → 알고리즘을 바꾸거나(SM-2/FSRS) 다른 앱으로 옮겨도 기록만 있으면 재현된다.

export const BOX_LABEL = ["새 문제", "1단계", "2단계", "3단계", "4단계", "5단계", "암기완료"];
export const INTERVAL = { 1: 1, 2: 3, 3: 7, 4: 14, 5: 30, 6: 90 }; // 단계별 다음 복습까지 일수
// 예상점수 계산용: 단계별로 시험에서 맞힐 확률(경험적 추정치)
export const P_CORRECT = [0.25, 0.4, 0.6, 0.75, 0.85, 0.92, 0.97];

export function dayStr(d = new Date()) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

export function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return dayStr(new Date(y, m - 1, d + n));
}

export function newCard(gid) {
  return { gid, box: 0, due: null, reps: 0, lapses: 0, streak: 0, lastWrong: null, last: null, first: null, wrongQ: {} };
}

// 풀이 1건을 카드에 반영한다.
// - 틀림: 무조건 1단계, 오늘 다시 출제
// - 오늘 틀렸던 카드를 다시 맞힘: 1단계 유지, 내일 복습
// - 복습일 전에 미리 맞힘: 단계 유지(기록만 남김) — 연습 모드에서 단계가 부풀지 않게
// - 맞혔지만 헷갈림: 단계 유지(최소 1), 내일 복습
// - 확실히 맞힘: 한 단계 올림(새 문제는 바로 2단계)
export function apply(c, a) {
  const today = dayStr(new Date(a.ts));
  c.reps++;
  c.last = a.ts;
  if (!c.first) c.first = today;
  if (!a.correct) {
    c.box = 1; c.lapses++; c.streak = 0; c.due = today; c.lastWrong = today;
    c.wrongQ[a.qid] = (c.wrongQ[a.qid] || 0) + 1;
    return c;
  }
  c.streak++;
  if (c.lastWrong === today) { c.box = 1; c.due = addDays(today, 1); return c; }
  const isDue = c.box === 0 || (c.due && c.due <= today);
  if (!isDue) return c;
  if (!a.confident) { c.box = Math.max(c.box, 1); c.due = addDays(today, 1); return c; }
  c.box = c.box === 0 ? 2 : Math.min(c.box + 1, 6);
  c.due = addDays(today, INTERVAL[c.box]);
  return c;
}

// attempts 전체를 재생해 묶음(gid)별 카드 상태를 만든다. gidOf: 문항ID → 묶음ID
export function replay(attempts, gidOf) {
  const cards = new Map();
  const sorted = [...attempts].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
  for (const a of sorted) {
    const gid = gidOf(a.qid);
    if (!gid) continue; // 문제은행에서 사라진 문항
    if (!cards.has(gid)) cards.set(gid, newCard(gid));
    apply(cards.get(gid), a);
  }
  return cards;
}

export function isDueToday(c, today = dayStr()) {
  return c && c.box >= 1 && c.due && c.due <= today;
}
