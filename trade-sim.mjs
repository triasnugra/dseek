// Aturan penilaian trade yang SAMA dipakai jurnal live (scripts/jurnal.mjs)
// dan backtester (scripts/backtest.mjs). Satu sumber kebenaran.
//
// v2: order limit dibatalkan jika tidak terisi dalam 72 jam (3 hari).
// Mencegah "EXPIRED noise" — order yang menggantung 4-7 hari hampir pasti sudah basi.

export const H1 = 36e5;
export const MAX_FILL_H = 72;  // jam. Order limit otomatis dibatalkan setelah ini.
export const mapK = a => ({ ot: a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4], ct: a[6] });

const rules = r => {
  const s = r.arah === 'LONG' ? 1 : -1;
  return {
    s,
    touch: k => (s == 1 ? k.l <= r.entry : k.h >= r.entry),
    open: k => (s == 1 ? k.o <= r.entry : k.o >= r.entry),
    sl: k => (s == 1 ? k.l <= r.sl : k.h >= r.sl),
    tp: k => (s == 1 ? k.h >= r.tp : k.l <= r.tp),
  };
};

function walk(cs, P, st) {
  for (const k of cs) {
    if (!st.fill) {
      const ao = P.open(k);
      if (!ao && !P.touch(k)) continue;
      st.fill = true;
      if (P.sl(k)) return { res: 'SL', t: k.ot };
      if (ao && P.tp(k)) return { res: 'TP', t: k.ot };
      continue;
    }
    if (P.sl(k)) return { res: 'SL', t: k.ot };
    if (P.tp(k)) return { res: 'TP', t: k.ot };
  }
  return null;
}

export async function gradeTrade(r, { h1, m1, now = Date.now() }) {
  const P = rules(r), risk = Math.abs(r.entry - r.sl), st = { fill: false };
  if (!(risk > 0)) return { hasil: 'tidak valid', R: 0, t: r.t };
  const done = w => ({
    hasil: w.res,
    R: w.res === 'SL' ? -1 : (P.s * (r.tp - r.entry)) / risk,
    t: w.t,
  });
  const cs = (await h1()).filter(k => k.ct < now);

  // Aturan 4: candle yang memuat waktu sinyal
  if (cs.length && cs[0].ot < r.t) {
    const k0 = cs.shift();
    if (m1) {
      const ms = (await m1(Math.max(k0.ot, r.t), k0.ct)).filter(m => m.ot >= r.t);
      const w = walk(ms, P, st);
      if (w) return done(w);
    }
  }

  let last = null;
  const cancelAt = r.t + MAX_FILL_H * H1;
  for (const k of cs) {
    if (k.ct > r.due) break;
    // PATCH B: batalkan order yang menggantung > 72 jam
    if (!st.fill && k.ot >= cancelAt) {
      return { hasil: 'tidak terisi', R: 0, t: cancelAt };
    }
    last = k;
    const amb = st.fill ? P.sl(k) && P.tp(k) : (P.touch(k) || P.open(k)) && (P.sl(k) || P.tp(k));
    const w = amb && m1 ? walk(await m1(k.ot, k.ct), P, st) : walk([k], P, st);
    if (w) return done(w);
  }

  if (now < r.due) return null;
  if (!st.fill) return { hasil: 'tidak terisi', R: 0, t: r.due };
  return { hasil: 'kedaluwarsa', R: (P.s * ((last ? last.c : r.entry) - r.entry)) / risk, t: r.due };
}
