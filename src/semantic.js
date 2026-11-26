/**
 * 无模型的「语义」：共现矩阵 + PPMI + 随机化 SVD（也就是潜在语义索引 LSI）。
 *
 * ## 为什么这算「语义」
 *
 * 不依赖任何预训练模型，纯粹从语料自身的共现统计里学：
 * **两个词如果总出现在相似的内容里，它们的向量就相近**。
 *
 * 这叫分布假设（distributional hypothesis），word2vec 的前身就是这个思路。
 * 和 embedding 的区别是：它学到的是"经常一起出现"，不是"意思相同"。
 *
 *   ✅ 「插件」和「扩展」在语料里常一起出现 → 向量相近 → 换个说法也能联想到
 *   ❌ 「快」和「慢」也常一起出现（都在聊速度）→ 会被当成相似，这是错的
 *   ❌ 语料里从没共现过的同义词 → 学不出来
 *
 * ## 为什么用 PPMI
 *
 * 原始频次会被高频词主导（"文件"出现在一半内容里）。PPMI 做两件事：
 *   1. 除以各自的边缘概率 → 高频词的贡献被压下来
 *   2. 负值截断为 0 → 只保留"共现超出偶然"的强信号
 *
 * ## 为什么用随机化 SVD
 *
 * 完整的 SVD 要分解 11997×383 的矩阵，太慢。随机化 SVD 的做法是：
 *   1. 用一个随机矩阵 Ω 把列空间"压"到 k 维（Y = A·Ω）
 *   2. 对 Y 做 QR 得到正交基 Q
 *   3. 真正要分解的只剩 Qᵀ·A，是 k×n 的小矩阵
 * 精度损失很小（Halko et al. 2011），速度快一个数量级。
 *
 * 实测数据：2445 个有边词、383 条不同内容、67060 个非零项。
 */

import { metaSet } from './db.js';

/** 向量维度。128 在 383 条语料上够用，再高就是拟合噪声。 */
export const DEFAULT_DIM = 128;

/** 词的文档频次下限：太低的词共现信号不足，不参与训练。 */
export const DEFAULT_MIN_DF = 2;

/** PPMI 的上下文分布平滑系数，避免 log(0)。 */
const PPMI_EPS = 1e-8;

/**
 * 构造「词 × 内容」稀疏矩阵。
 *
 * 用 body_hash 而不是 summary id 做列 —— 同一段话在多个会话里各存一份，
 * 按内容去重后列数从 514 降到 383，统计才准。
 *
 * @returns {{ terms: number[], cols: number, rows: Array<{ id: number, items: Array<[number, number]> }>, docCount: number }}
 */
export function buildCooccurrence(db, opts = {}) {
  const { minDf = DEFAULT_MIN_DF } = opts;

  // 内容 → 列号（按 body_hash 去重）
  const docs = db
    .prepare('SELECT DISTINCT body_hash FROM summaries WHERE body_hash IS NOT NULL')
    .all()
    .map((r) => r.body_hash);
  const docIndex = new Map(docs.map((h, i) => [h, i]));
  const docCount = docs.length;

  // 词 → 行号。只保留有区分度的词：
  //   · 被 mute 的不要
  //   · df_content 太低的不要（共现信号不足）
  const termRows = db
    .prepare(
      `SELECT id, term, COALESCE(df_content, df) AS df
       FROM terms WHERE muted = 0 AND COALESCE(df_content, df) >= ?
       ORDER BY id`,
    )
    .all(minDf);
  const termIndex = new Map(termRows.map((r, i) => [r.id, i]));

  // 填充稀疏矩阵
  const rows = termRows.map((r) => ({ id: r.id, items: [] }));
  const inv = db
    .prepare(
      `SELECT ti.term AS termId, ti.w AS w, s.body_hash AS hash
       FROM terms_inv ti JOIN summaries s ON s.id = ti.summary
       WHERE s.body_hash IS NOT NULL`,
    )
    .all();
  for (const r of inv) {
    const ri = termIndex.get(r.termId);
    const ci = docIndex.get(r.hash);
    if (ri === undefined || ci === undefined) continue;
    rows[ri].items.push([ci, Number(r.w) || 1]);
  }

  return { terms: termRows.map((r) => r.id), rows, cols: docCount, docCount };
}

/**
 * PPMI 加权。就地修改矩阵值。
 *
 *   pmi(i,j) = log( P(i,j) / (P(i,·)·P(·,j)) )
 *   ppmi     = max(0, pmi)
 *
 * @param {{ rows: Array<{ items: Array<[number, number]> }>, cols: number, docCount: number }} m
 */
export function applyPpmi(m) {
  const { rows, docCount } = m;
  if (docCount === 0) return m;

  // 行和（词的总出现量）、列和（每条内容的词总量）
  const rowSum = new Array(rows.length).fill(0);
  const colSum = new Array(docCount).fill(0);
  let total = 0;
  for (let i = 0; i < rows.length; i += 1) {
    for (const [c, w] of rows[i].items) {
      rowSum[i] += w;
      colSum[c] += w;
      total += w;
    }
  }
  if (total === 0) return m;

  for (let i = 0; i < rows.length; i += 1) {
    const pi = rowSum[i] / total;
    const next = [];
    for (const [c, w] of rows[i].items) {
      const pj = colSum[c] / total;
      const pij = w / total;
      const pmi = Math.log(pij / (pi * pj + PPMI_EPS) + PPMI_EPS);
      if (pmi > 0) next.push([c, pmi]);
    }
    rows[i].items = next;
  }
  return m;
}

/** 高斯随机数（Box-Muller）。 */
function randn() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 稀疏矩阵 × 稠密矩阵：Y = A·B
 * @param {{ rows: Array<{ items: Array<[number,number]> }> }} a
 * @param {Float64Array} b 列优先？这里用行优先 (cols × k)
 * @param {number} cols
 * @param {number} k
 * @returns {Float64Array} 行优先 (rows.length × k)
 */
function sparseTimesDense(a, b, cols, k) {
  const m = a.rows.length;
  const out = new Float64Array(m * k);
  for (let i = 0; i < m; i += 1) {
    const off = i * k;
    for (const [c, w] of a.rows[i].items) {
      const boff = c * k;
      for (let j = 0; j < k; j += 1) out[off + j] += w * b[boff + j];
    }
  }
  return out;
}

/** 稠密矩阵转置乘稀疏：C = Aᵀ·B，A 是 (m×k)，B 是稀疏 (m×n)。 */
function denseTransposedTimesSparse(a, m, k, sparse) {
  const n = sparse.cols;
  const out = new Float64Array(k * n);
  for (let i = 0; i < m; i += 1) {
    for (const [c, w] of sparse.rows[i].items) {
      for (let j = 0; j < k; j += 1) out[j * n + c] += a[i * k + j] * w;
    }
  }
  return out;
}

/**
 * 改进的 Gram-Schmidt QR（只取 Q，R 不用）。
 * 输入 (m × k) 行优先，输出 (m × k) 行优先的正交基。
 */
function qrThinQ(a, m, k) {
  const q = new Float64Array(m * k);
  for (let j = 0; j < k; j += 1) {
    const v = new Float64Array(m);
    for (let i = 0; i < m; i += 1) v[i] = a[i * k + j];
    // 两轮正交化更稳
    for (let pass = 0; pass < 2; pass += 1) {
      for (let jj = 0; jj < j; jj += 1) {
        let dot = 0;
        for (let i = 0; i < m; i += 1) dot += v[i] * q[i * k + jj];
        for (let i = 0; i < m; i += 1) v[i] -= dot * q[i * k + jj];
      }
    }
    let norm = 0;
    for (let i = 0; i < m; i += 1) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    if (norm < 1e-12) {
      // 退化：这一列填 0，后续会靠小 SVD 丢掉
      continue;
    }
    for (let i = 0; i < m; i += 1) q[i * k + j] = v[i] / norm;
  }
  return q;
}

/**
 * 对称矩阵的 Jacobi 特征分解（只取前 k 个最大特征对）。
 * 用于对 B·Bᵀ（k×k，k 很小）求解。
 *
 * @param {Float64Array} a (n×n 行优先，会被就地修改)
 * @param {number} n
 * @returns {{ values: Float64Array, vectors: Float64Array }} vectors 行优先 (n×n)，按特征值降序
 */
function jacobiEigen(a, n) {
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) v[i * n + i] = 1;

  for (let sweep = 0; sweep < 30; sweep += 1) {
    let off = 0;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) off += Math.abs(a[p * n + q]);
    }
    if (off < 1e-10) break;

    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-14) continue;
        const app = a[p * n + p];
        const aqq = a[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let i = 0; i < n; i += 1) {
          const aip = a[i * n + p];
          const aiq = a[i * n + q];
          a[i * n + p] = c * aip - s * aiq;
          a[i * n + q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i += 1) {
          const api = a[p * n + i];
          const aqi = a[q * n + i];
          a[p * n + i] = c * api - s * aqi;
          a[q * n + i] = s * api + c * aqi;
        }
        for (let i = 0; i < n; i += 1) {
          const vip = v[i * n + p];
          const viq = v[i * n + q];
          v[i * n + p] = c * vip - s * viq;
          v[i * n + q] = s * vip + c * viq;
        }
      }
    }
  }

  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) values[i] = a[i * n + i];
  // 按特征值降序排列
  const order = [...Array(n).keys()].sort((x, y) => values[y] - values[x]);
  const sv = new Float64Array(n);
  const vec = new Float64Array(n * n);
  for (let j = 0; j < n; j += 1) {
    sv[j] = values[order[j]];
    for (let i = 0; i < n; i += 1) vec[i * n + j] = v[i * n + order[j]];
  }
  return { values: sv, vectors: vec };
}

/**
 * 随机化 SVD，返回每个词（行）的降维向量。
 *
 * @param {{ rows: Array<{ items: Array<[number,number]> }>, cols: number }} m PPMI 之后的稀疏矩阵
 * @param {number} k 目标维度
 * @param {object} [opts]
 * @returns {{ dim: number, vectors: Float32Array, rows: number, energy: number }}
 */
export function randomizedSvd(m, k = DEFAULT_DIM, opts = {}) {
  const rowCount = m.rows.length;
  const cols = m.cols;
  if (rowCount === 0 || cols === 0) {
    return { dim: 0, vectors: new Float32Array(0), rows: 0, energy: 0 };
  }
  const kk = Math.max(1, Math.min(k, cols, rowCount));
  const oversample = Math.min(opts.oversample ?? 10, Math.max(0, cols - kk));
  const k2 = kk + oversample;

  // ① Ω: cols × k2 随机高斯
  const omega = new Float64Array(cols * k2);
  for (let i = 0; i < omega.length; i += 1) omega[i] = randn();

  // ② Y = A·Ω → rowCount × k2
  const y = sparseTimesDense(m, omega, cols, k2);

  // ③ Q = qr(Y)
  const q = qrThinQ(y, rowCount, k2);

  // ④ B = Qᵀ·A → k2 × cols（注意 A 是稀疏的 rowCount×cols）
  const b = denseTransposedTimesSparse(q, rowCount, k2, m);

  // ⑤ 对 B 做 SVD：B = Ub·Σ·Vᵀ。先算 Bᵀ·B（cols×cols）太大，
  //    改算 B·Bᵀ（k2×k2，很小）拿 Ub 和 Σ，再回推 U = Q·Ub。
  const bbt = new Float64Array(k2 * k2);
  for (let i = 0; i < k2; i += 1) {
    for (let j = i; j < k2; j += 1) {
      let s = 0;
      for (let c = 0; c < cols; c += 1) s += b[i * cols + c] * b[j * cols + c];
      bbt[i * k2 + j] = s;
      bbt[j * k2 + i] = s;
    }
  }
  const eig = jacobiEigen(bbt, k2);

  // ⑥ 词向量 = Q·Ub·Σ^(1/2)，只取前 kk 维
  const dim = kk;
  const vectors = new Float32Array(rowCount * dim);
  let energy = 0;
  let energyAll = 0;
  for (let j = 0; j < k2; j += 1) {
    const lam = Math.max(0, eig.values[j]);
    energyAll += lam;
  }
  for (let j = 0; j < dim; j += 1) {
    const lam = Math.max(0, eig.values[j]);
    energy += lam;
    const scale = Math.sqrt(lam);
    if (scale === 0) continue;
    for (let i = 0; i < rowCount; i += 1) {
      let s = 0;
      for (let jj = 0; jj < k2; jj += 1) s += q[i * k2 + jj] * eig.vectors[jj * k2 + j];
      vectors[i * dim + j] = s * scale;
    }
  }

  return {
    dim,
    vectors,
    rows: rowCount,
    energy: energyAll > 0 ? energy / energyAll : 0,
  };
}

/**
 * 一行端到端：读库 → 共现 → PPMI → SVD → 返回词向量。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ dim?: number, minDf?: number, onProgress?: Function, shouldStop?: Function }} [opts]
 * @returns {Promise<{ termIds: number[], dim: number, vectors: Float32Array, stats: object }>}
 */
export async function trainTermVectors(db, opts = {}) {
  const { dim = DEFAULT_DIM, minDf = DEFAULT_MIN_DF, onProgress, shouldStop } = opts;
  const started = Date.now();

  const m = buildCooccurrence(db, { minDf });
  if (m.rows.length === 0 || m.cols === 0) {
    return { termIds: [], dim: 0, vectors: new Float32Array(0), stats: { terms: 0, docs: m.cols, ms: 0 } };
  }
  onProgress?.({ phase: 'matrix', terms: m.rows.length, docs: m.cols });
  if (shouldStop?.()) return { termIds: [], dim: 0, vectors: new Float32Array(0), stats: { stopped: true } };

  await new Promise((r) => setImmediate(r));
  applyPpmi(m);

  const nnz = m.rows.reduce((a, r) => a + r.items.length, 0);
  onProgress?.({ phase: 'ppmi', nnz });
  await new Promise((r) => setImmediate(r));

  const svd = randomizedSvd(m, dim);
  onProgress?.({ phase: 'svd', dim: svd.dim, energy: svd.energy });

  return {
    termIds: m.terms,
    dim: svd.dim,
    vectors: svd.vectors,
    stats: {
      terms: m.rows.length,
      docs: m.cols,
      nnz,
      dim: svd.dim,
      energy: Number(svd.energy.toFixed(3)),
      ms: Date.now() - started,
    },
  };
}

/** 把词向量写进 term_vectors 表。 */
export function saveTermVectors(db, { termIds, dim, vectors }) {
  const now = Date.now();
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM term_vectors');
    const ins = db.prepare(
      'INSERT OR REPLACE INTO term_vectors(term, dim, vec, updated_at) VALUES (?, ?, ?, ?)',
    );
    for (let i = 0; i < termIds.length; i += 1) {
      const slice = vectors.subarray(i * dim, (i + 1) * dim);
      // 存 Float32 的裸 buffer，比 JSON 小 8 倍且不用解析
      const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
      ins.run(termIds[i], dim, buf, now);
    }
    metaSet(db, 'vectors_dim', String(dim));
    metaSet(db, 'vectors_epoch', String(now));
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw error;
  }
  return termIds.length;
}

/** 余弦相似度（两个 Float32Array）。 */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}
