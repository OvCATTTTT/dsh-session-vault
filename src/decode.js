/**
 * DSH 会话日志解码器。
 *
 * `session.v4.jsonl.zstd` 不是普通 zstd 文件，而是**多帧串联**：
 * 每次追加写都会新增一个独立 zstd frame（实测单个会话最多 7876 帧）。
 *
 * 坑：Node/zlib 的 `zstdDecompressSync` 与 `createZstdDecompress` 都**只解第一帧**
 * （对 8.62 MB 的文件只吐出 195 字节）。所以必须扫描 zstd magic、按相邻 magic
 * 偏移切片、逐帧解压后拼接。
 *
 * 增量：以「字节水位」记录已消费到哪，每次只解新帧。尾部正在写入的帧解压会失败，
 * 此时**停止且不推进水位**，下次再来 —— 这样不会写进半条记录。
 */

import { readFileSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

/** zstd frame 起始 magic（little-endian 0xFD2FB528）。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 找出 buffer 里所有 frame 的起始偏移。
 * @param {Buffer} buf
 * @returns {number[]} 升序偏移
 */
export function frameOffsets(buf) {
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  return offsets;
}

/**
 * 从 `bytesDone` 之后解码所有完整帧。
 *
 * 返回的 `bytesDone` 是「已安全消费到的字节偏移」，调用方应把它持久化。
 * 若末尾帧不完整，会停在它之前，`bytesDone` 不推进。
 *
 * @param {string} file 会话文件绝对路径
 * @param {number} [bytesDone=0] 已消费字节水位
 * @param {object} [opts]
 * @param {number} [opts.maxMergeLookahead=4] 遇到假阳性 magic 时最多与后续几帧合并重试
 * @returns {{ text: string, bytesDone: number, frames: number, truncated: boolean }}
 */
export function decodeFrom(file, bytesDone = 0, opts = {}) {
  const { maxMergeLookahead = 4 } = opts;
  const buf = readFileSync(file);
  const offsets = frameOffsets(buf);

  if (offsets.length === 0) {
    return { text: '', bytesDone: buf.length, frames: 0, truncated: false };
  }

  // 定位起始帧：第一个起点 >= 已消费水位
  let start = 0;
  while (start < offsets.length && offsets[start] < bytesDone) start += 1;

  /** @type {string[]} */
  const chunks = [];
  let consumed = offsets[start] ?? buf.length;
  let k = start;
  let frames = 0;

  while (k < offsets.length) {
    let ok = false;
    let endIdx = k;
    let out = null;

    for (let g = 0; g <= maxMergeLookahead; g += 1) {
      const end = k + 1 + g < offsets.length ? offsets[k + 1 + g] : buf.length;
      try {
        out = zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8');
        ok = true;
        endIdx = k + g;
        break;
      } catch {
        // 可能是假阳性 magic（压缩数据里恰好出现 magic 字节），合并到下一帧再试
      }
    }

    if (!ok) break; // 尾部未写完或损坏：停在这里，水位不推进

    if (out) chunks.push(out);
    frames += 1;
    consumed = endIdx + 1 < offsets.length ? offsets[endIdx + 1] : buf.length;
    k = endIdx + 1;
  }

  return {
    text: chunks.join(''),
    bytesDone: consumed,
    frames,
    truncated: k < offsets.length,
  };
}

/**
 * 把解码出来的文本切成 JSON 记录数组。
 * 单条坏行不会中断整个文件。
 *
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseLines(text) {
  const records = [];
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t));
    } catch {
      // 忽略坏行（理论上不该出现，但绝不因此中断导入）
    }
  }
  return records;
}

/**
 * 文件大小；不存在返回 0。
 * @param {string} file
 * @returns {number}
 */
export function fileSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
