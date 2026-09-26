// ============================================================
// proj/webm-duration.mjs —— 给 MediaRecorder 产出的 WebM 补上 Duration（纯函数，零依赖）
//
// 现象：canvas.captureStream() + MediaRecorder 录出来的 .webm，播放器打开总时长 0:00、
//      进度条拖不动；ffprobe 显示 duration=N/A（但流本身完好，簇与音视频轨都在）。
// 根因：MediaRecorder 是"边采边写"的实时流——开写时不知道总长，收尾时也不回头补元数据，
//      于是 Segment > Info 里根本没有 Duration 元素。不是本模块写坏了，是它的固有行为。
// 改法：录制结束把 blob 读成字节，在 Info 里补一个 Duration，再拿新字节去下载。
//      只动 Info 那一段，其余字节原样保留。
//
// 为什么自己写不用库：项目一贯零构建零依赖（见 package.json），且已有手写 SMF(dsp/smf.mjs)
// 与手写 WAV(app.mjs bufferToWav) 的先例；EBML 这边只剩"读 VINT + 拼字节"，不值得引依赖。
//
// ⚠️ 两个 EBML 的坑（都踩过，实测确认）：
//   ① ID 与 size 的 VINT 解码规则不同：size 要去掉标记位取数值；**ID 必须用原始字节值**
//      （ID 的长度信息本身有意义）。两者用同一个函数解会让所有 ID 比较失配，
//      补丁静默不生效（文件净增 0 字节、时长依旧 N/A）。
//   ② Chrome 把每个 Cluster 都写成"未知长度"，所以【无法按顺序遍历 cluster】——
//      不要试图去数最后一个 cluster 的时间码，直接信任调用方给的录制时长。
//
// 实测参照（2026-09-15 Chrome 实录 + ffprobe 复核）：
//   EBML(31B) | Segment[未知长度, 8B size 字段]
//     SeekHead | Info{TimecodeScale=1e6ns, MuxingApp, WritingApp} | Tracks | Cluster…
//   → Info 内容 25 字节；补一个 11 字节的 Duration(0x4489, float64) 变 36 字节，
//     仍装得下 1 字节 size VINT，Segment 未知长度不变 → 净插入 11 字节。
// ============================================================

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
};

const vintLen = (first) => { let n = 1; for (let m = 0x80; !(first & m); m >>= 1) n++; return n; };

// 读 ID：返回【原始字节值】（含标记位），直接与上面的常量比较
export function readId(buf, o) {
  if (o < 0 || o >= buf.length) return null;
  const first = buf[o];
  if (first === 0) return null;                      // 非法：宽度 > 8
  const len = vintLen(first);
  if (o + len > buf.length) return null;
  let val = 0;
  for (let i = 0; i < len; i++) val = val * 256 + buf[o + i];
  return { len, val };
}

// 读 size：去掉标记位取数值；数值位全 1 = "未知长度"
export function readSize(buf, o) {
  if (o < 0 || o >= buf.length) return null;
  const first = buf[o];
  if (first === 0) return null;
  const len = vintLen(first);
  if (o + len > buf.length) return null;
  const mask = 0xff >> len;
  let val = first & mask;
  let unknown = (first & mask) === mask;
  for (let i = 1; i < len; i++) {
    val = val * 256 + buf[o + i];
    if (buf[o + i] !== 0xff) unknown = false;
  }
  return { len, val, unknown };
}

// 整数 → 最短 size VINT（全 1 保留给"未知长度"，上限 2^(7w)-2）
export function encodeVint(n) {
  n = Math.max(0, Math.floor(n));
  let w = 1;
  while (w < 8 && n > Math.pow(2, 7 * w) - 2) w++;
  const out = new Uint8Array(w);
  let v = n;
  for (let i = w - 1; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (w - 1);
  return out;
}

// 读一个元素（ID + size + 数据范围）
export function readElement(buf, o) {
  const id = readId(buf, o);
  if (!id) return null;
  const size = readSize(buf, o + id.len);
  if (!size) return null;
  const dataStart = o + id.len + size.len;
  const dataEnd = size.unknown ? buf.length : Math.min(buf.length, dataStart + size.val);
  return {
    id: id.val, idLen: id.len, sizeLen: size.len, size: size.val,
    unknown: size.unknown, start: o, dataStart, dataEnd,
  };
}

// 在 [from,to) 顺序找子元素；遇到"未知长度"元素即无法继续（它是本层最后一个）
function findChild(buf, from, to, wantId) {
  let o = from;
  while (o < to) {
    const e = readElement(buf, o);
    if (!e) return null;
    if (e.id === wantId) return e;
    if (e.unknown) return null;
    if (e.dataEnd <= o) return null;                 // 防御：不前进就停
    o = e.dataEnd;
  }
  return null;
}

function readUint(buf, e) {
  let v = 0;
  for (let i = 0; i < e.size; i++) v = v * 256 + buf[e.dataStart + i];
  return v;
}

// 定位 EBML / Segment / Info；不是可识别的 MediaRecorder WebM 就返回 null
function locate(buf) {
  const ebml = readElement(buf, 0);
  if (!ebml || ebml.id !== ID.EBML) return null;
  const seg = readElement(buf, ebml.dataEnd);
  if (!seg || seg.id !== ID.Segment) return null;
  const info = findChild(buf, seg.dataStart, seg.dataEnd, ID.Info);
  if (!info || info.unknown) return null;
  return { ebml, seg, info };
}

// Info 里的 TimecodeScale（纳秒；默认 1e6 = 1ms）。Duration 的单位就是它。
export function readTimecodeScale(buf) {
  buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const L = locate(buf);
  if (!L) return 1e6;
  const tc = findChild(buf, L.info.dataStart, L.info.dataEnd, ID.TimecodeScale);
  if (!tc || tc.unknown || tc.size < 1 || tc.size > 8) return 1e6;
  const v = readUint(buf, tc);
  return v > 0 ? v : 1e6;
}

// 主函数：补 Duration。
// durationMs 想要写入的时长（毫秒）。见文件头坑②：这里刻意不去推导"实际内容时长"，
// 由调用方给（录制端用墙钟耗时，就是用户感知的录制长度）。
// 返回新 Uint8Array；输入不是可识别的 WebM 时【原样返回】，绝不把文件改坏。
export function patchWebmDuration(bytes, durationMs) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const L = locate(buf);
  if (!L) return buf;

  const scale = readTimecodeScale(buf);
  const ms = Math.max(0, Number(durationMs) || 0);
  const units = ms * 1e6 / (scale || 1e6);              // Duration 以 TimecodeScale 为单位

  // Duration 元素：ID 0x4489（原始写法）+ size VINT(8) + float64 大端
  const durEl = new Uint8Array(11);
  durEl[0] = 0x44; durEl[1] = 0x89;
  durEl[2] = 0x88;
  new DataView(durEl.buffer).setFloat64(3, units, false);

  // 组装新 Info 内容：已有 Duration 就【就地替换】，没有才追加。
  // 统一走这条路，重复补丁不会让文件越长越大。
  const old = buf.subarray(L.info.dataStart, L.info.dataEnd);
  const durOld = findChild(buf, L.info.dataStart, L.info.dataEnd, ID.Duration);
  let newContent;
  if (durOld) {
    newContent = new Uint8Array((durOld.start - L.info.dataStart) + durEl.length + (L.info.dataEnd - durOld.dataEnd));
    let p = 0;
    for (const part of [buf.subarray(L.info.dataStart, durOld.start), durEl, buf.subarray(durOld.dataEnd, L.info.dataEnd)]) {
      newContent.set(part, p); p += part.length;
    }
  } else {
    newContent = new Uint8Array(old.length + durEl.length);
    newContent.set(old, 0);
    newContent.set(durEl, old.length);
  }

  const newInfoId = buf.subarray(L.info.start, L.info.start + L.info.idLen);
  const newInfoSize = encodeVint(newContent.length);
  const newInfo = new Uint8Array(newInfoId.length + newInfoSize.length + newContent.length);
  newInfo.set(newInfoId, 0);
  newInfo.set(newInfoSize, newInfoId.length);
  newInfo.set(newContent, newInfoId.length + newInfoSize.length);

  // Segment 的长度字段：原来是"未知长度"就保持（MediaRecorder 原生就是 8 字节全 FF），
  // 否则按新数据长度重算。长度字段宽度可能变化，故整段重拼而非就地改写。
  const segId = buf.subarray(L.seg.start, L.seg.start + L.seg.idLen);
  let segSizeBytes;
  if (L.seg.unknown) {
    segSizeBytes = new Uint8Array(8).fill(0xff);
    segSizeBytes[0] = 0x01;
  } else {
    const oldSegDataLen = L.seg.dataEnd - L.seg.dataStart;
    const oldInfoLen = L.info.dataEnd - L.info.start;
    segSizeBytes = encodeVint(oldSegDataLen - oldInfoLen + newInfo.length);
  }

  const parts = [
    buf.subarray(0, L.seg.start),                       // EBML 头
    segId, segSizeBytes,                                // Segment ID + 长度
    buf.subarray(L.seg.dataStart, L.info.start),        // Segment 数据里 Info 之前
    newInfo,                                            // 新 Info
    buf.subarray(L.info.dataEnd),                       // Info 之后（Tracks / Clusters…）
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}
