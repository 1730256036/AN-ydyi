// ============================================================
// dsp/smf.mjs —— 标准 MIDI 文件(SMF) 解析与写出，零依赖
//
// parseSMF(arrayBuffer)
//   → { durationMs, tracks: [{ name, isPercussion, notes: [{midi,t0,t1,vel}] }] }
//   - 支持多轨、running status、SysX 跳过、 tempo 变化(分段映射 tick→ms)
//   - t0/t1 单位 ms；通道 10(ch=9) 标记 isPercussion(鼓，无音高)
// writeSMF(notes, {ppq, tempoUspq})
//   - notes: [{midi, t0(ms), t1(ms), vel?}] → Format0 单轨 ArrayBuffer
//   - 供"导出 MIDI"使用(检测分段/MIDI 工程/AI转谱 共用)
// ============================================================

// ---------- 变长数量(VLQ) ----------
function readVLQ(dv, off) {
  let v = 0, o = off;
  for (;;) {
    const b = dv.getUint8(o++);
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return [v, o];
}
function writeVLQ(arr, n) {
  if (n < 0) n = 0;
  const tmp = [n & 0x7f];
  n >>= 7;
  while (n > 0) { tmp.unshift(0x80 | (n & 0x7f)); n >>= 7; }
  for (const b of tmp) arr.push(b);
}

const PC_NAMES = { 0: 'C', 3: 'Ds', 6: 'Fs', 9: 'A' };

// ---------- 解析 ----------
export function parseSMF(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const u8 = new Uint8Array(arrayBuffer);
  let off = 0;
  const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));

  if (str(0, 4) !== 'MThd') throw new Error('不是 MIDI 文件(缺 MThd)');
  const hdLen = dv.getUint32(4);
  const fmt = dv.getUint16(8);
  const ntrks = dv.getUint16(10);
  const division = dv.getUint16(12);
  if (division & 0x8000) throw new Error('不支持 SMPTE 时间格式的 MIDI');
  const ppq = division || 480;
  off = 8 + hdLen;

  const tempoMap = [{ tick: 0, uspq: 500000 }];   // 默认 120bpm
  const tracks = [];

  for (let tr = 0; tr < ntrks && off + 8 <= dv.byteLength; tr++) {
    if (str(off, 4) !== 'MTrk') { off += dv.getUint32(off + 4) + 8; continue; }
    const len = dv.getUint32(off + 4);
    const end = off + 8 + len;
    let p = off + 8;
    let tick = 0, runStatus = 0;
    const track = { name: '', isPercussion: false, notes: [] };
    const open = new Map();                      // "ch:note" -> [{t0tick, vel}]
    while (p < end) {
      let delta;
      [delta, p] = readVLQ(dv, p);
      tick += delta;
      let st = dv.getUint8(p);
      if (st & 0x80) { p++; runStatus = st; } else { st = runStatus; if (!st) throw new Error('MIDI 数据错乱(无状态字节)'); }
      if (st === 0xff) {                         // meta
        const type = dv.getUint8(p++);
        let [mlen, p2] = readVLQ(dv, p);
        if (type === 0x51 && mlen === 3) {       // set tempo
          const uspq = (dv.getUint8(p2) << 16) | (dv.getUint8(p2 + 1) << 8) | dv.getUint8(p2 + 2);
          tempoMap.push({ tick, uspq });
        } else if (type === 0x03) {
          track.name = String.fromCharCode(...u8.subarray(p2, p2 + mlen));
        }
        p = p2 + mlen;
      } else if (st === 0xf0 || st === 0xf7) {   // sysex / escape：跳过
        const [mlen, p2] = readVLQ(dv, p);
        p = p2 + mlen;
      } else {
        const cmd = st & 0xf0, ch = st & 0x0f;
        const n1 = dv.getUint8(p);
        const n2 = cmd === 0xc0 || cmd === 0xd0 ? 0 : dv.getUint8(p + 1);
        p += (cmd === 0xc0 || cmd === 0xd0) ? 1 : 2;
        const key = ch + ':' + n1;
        if (cmd === 0x90 && n2 > 0) {            // note on
          if (ch === 9) track.isPercussion = true;
          if (!open.has(key)) open.set(key, []);
          open.get(key).push({ t0tick: tick, vel: n2 });
        } else if (cmd === 0x80 || (cmd === 0x90 && n2 === 0)) {   // note off
          const stack = open.get(key);
          if (stack && stack.length) {
            const on = stack.pop();
            track.notes.push({ midi: n1, t0tick: on.t0tick, t1tick: tick, vel: on.vel });
          }
        }
        // 其余通道事件(program/aftertouch/pitch bend 等)一期忽略
      }
    }
    // 未闭合的音符：以 track 末尾闭合
    for (const [key, stack] of open) {
      for (const on of stack) track.notes.push({ midi: +key.split(':')[1], t0tick: on.t0tick, t1tick: tick, vel: on.vel });
    }
    tracks.push(track);
    off = end;
  }

  // tempo 分段映射：tick → ms
  tempoMap.sort((a, b) => a.tick - b.tick);
  const msOf = (tk) => {
    let ms = 0, pt = 0, uspq = 500000;
    for (const t of tempoMap) {
      if (t.tick >= tk) break;
      ms += (t.tick - pt) * uspq / ppq / 1000;
      pt = t.tick; uspq = t.uspq;
    }
    return ms + (tk - pt) * uspq / ppq / 1000;
  };

  let durationMs = 0;
  for (const tr of tracks) {
    tr.notes = tr.notes
      .map(n => ({ midi: n.midi, t0: Math.round(msOf(n.t0tick)), t1: Math.round(msOf(n.t1tick)), vel: n.vel / 127 }))
      .filter(n => n.t1 > n.t0)
      .sort((a, b) => a.t0 - b.t0);
    for (const n of tr.notes) if (n.t1 > durationMs) durationMs = n.t1;
  }
  return { format: fmt, ppq, durationMs, tracks };
}

// ---------- 写出(Format0 单轨) ----------
export function writeSMF(notes, { ppq = 480, tempoUspq = 500000 } = {}) {
  const ev = [];
  for (const n of notes) {
    if (!(n.t1 > n.t0)) continue;
    const t0 = Math.max(0, Math.round(n.t0 * ppq / 500));    // 120bpm: 1 拍=500ms
    const t1 = Math.max(t0 + 1, Math.round(n.t1 * ppq / 500));
    const vel = Math.max(1, Math.min(127, Math.round((n.vel ?? 0.8) * 127)));
    ev.push({ tick: t0, off: false, midi: n.midi, vel });
    ev.push({ tick: t1, off: true, midi: n.midi, vel: 0 });
  }
  ev.sort((a, b) => a.tick - b.tick || (a.off ? -1 : 1) - (b.off ? -1 : 1));

  const trk = [];
  // tempo meta
  trk.push(0x00, 0xff, 0x51, 0x03,
    (tempoUspq >> 16) & 0xff, (tempoUspq >> 8) & 0xff, tempoUspq & 0xff);
  let prev = 0;
  for (const e of ev) {
    writeVLQ(trk, e.tick - prev); prev = e.tick;
    trk.push(e.off ? 0x80 : 0x90, e.midi & 0x7f, e.vel);
  }
  trk.push(0x00, 0xff, 0x2f, 0x00);                          // end of track

  const out = [];
  const u32 = (v) => out.push((v >> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
  const u16 = (v) => out.push((v >> 8) & 255, v & 255);
  for (const c of 'MThd') out.push(c.charCodeAt(0));
  u32(6); u16(0); u16(1); u16(ppq);
  for (const c of 'MTrk') out.push(c.charCodeAt(0));
  u32(trk.length);
  for (const b of trk) out.push(b & 255);
  return new Uint8Array(out).buffer;
}
