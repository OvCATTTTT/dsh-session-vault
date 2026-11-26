/**
 * 词发现：从语料里统计出「真正的词」，而不是固定长度的滑动窗口碎片。
 *
 * ## 为什么要这一层
 *
 * 索引层一直用 bigram（2 字滑动窗口），因为中文分词需要词典、而本项目不想带词典。
 * 代价是关键词榜里一半是碎片：
 *
 *   记忆 文件 助手 关键 键词 用户 现在 人格 一个 规则 格卡 件夹
 *                  ↑ 跨词边界    ↑ 跨词边界  ↑ 跨词边界
 *
 * 直觉上「改成切 3 个字」好像能解决，实测不行 —— 3-gram 只是把碎片换个形状：
 *
 *   关键词 人格卡 文件夹 工作区  训练数 练数据  键词索 词索引
 *                                ↑「训练数据」被切成两半
 *
 * 4-gram 同样有 `什么是人` / `么是人类`。
 *
 * **任何固定 n 都有碎片，因为 n-gram 不知道词边界在哪。**
 *
 * ## 解法：互信息 + 左右熵
 *
 * 这是无监督新词发现的经典做法，只需要统计量，不需要词典：
 *
 * - **PMI（互信息）** 判「内部结合紧不紧」。
 *   `P(关键词) / (P(关键)·P(键词))` 很大 → 这仨字是抱团的。
 *   `的关键` 只有 2.33，`关键词` 有 7.00。
 *
 * - **左右熵** 判「外部自由不自由」。
 *   一个真词左右能接各种不同的字（`关键词` 左邻 67 种）；
 *   一个碎片只能接固定的字（`训练数` 右邻只有「据」，熵 = 0）。
 *
 * 实测这个分界干净得惊人：
 *
 *   | 词 | PMI | 左右熵 |    | 碎片 | PMI | 左右熵 |
 *   |---|---|---|---|---|---|---|
 *   | 关键词 | 7.00 | 4.83 |  | 训练数 | 7.67 | **0.00** |
 *   | 人格卡 | 7.43 | 4.10 |  | 键词索 | 5.94 | **0.00** |
 *   | 文件夹 | 6.70 | 3.71 |  | 运行日 | 6.31 | **0.00** |
 *
 * 所以 `PMI ≥ 5` 且 `左右熵 ≥ 1.5` 能把碎片清干净、同时留住真词
 * （实测 485 条摘要 → 374 个真词）。
 *
 * ## 性能
 *
 * 全库 489 条摘要 / 14 万汉字：n-gram 统计 41ms，PMI+左右熵 527ms。
 * 左右熵要对每个候选全库扫一遍，是唯一的大头，靠 minFreq 先砍掉九成候选。
 * 分批 + `setImmediate` 让出事件循环后，单次停顿 <1ms。
 */

import { terms as tokenize, DEFAULT_STOPWORDS, CJK_FUNC } from './ngram.js';

/** 频次门槛：低于这个数的串不参与熵计算（省掉九成开销）。 */
export const DEFAULT_MIN_FREQ = 25;
/** 互信息门槛：低于它说明是跨词边界的松散组合。 */
export const DEFAULT_MIN_PMI = 5;
/** 左右熵门槛：碎片通常精确为 0（只接一种字），真词普遍 >3。 */
export const DEFAULT_MIN_ENTROPY = 1.5;
/** 最长词长。中文词极少超过 4 字，再长基本是固定短语。 */
export const DEFAULT_MAX_LEN = 4;
/**
 * 样本下限：摘要少于这么多条时结果不可靠。
 *
 * PMI 和左右熵都需要足够样本：新用户刚装、只有几十条摘要时，
 * 统计出来的"词"会非常随机。这种情况直接放弃，保持 bigram 行为。
 */
export const DEFAULT_MIN_SAMPLES = 80;

/**
 * 词里含功能字就算碎片。
 *
 * 实测 3/4 字词里混进的虚词几乎都带功能字：`的时候`、`这个会话`、`说的话`。
 * 而真词（关键词 / 人格卡 / 文件夹 / 工作区 / 训练数据 / 运行日志）一个都不带。
 * 所以这条规则的误伤面很小，比维护一张超长停用词表可靠。
 */
function hasFuncChar(word) {
  for (const ch of word) if (CJK_FUNC.has(ch)) return true;
  return false;
}

/** 额外补的 3 字虚词 —— 它们不含功能字，但同样没有主题意义。 */
const EXTRA_STOPWORDS = new Set([
  '为什么', '要不要', '一句话', '第一次', '跑一次', '重启后', '接下来', '这时候',
  '是不是', '有没有', '能不能', '会不会', '可以先', '一样的', '同样的',
]);

/** 这个词值不值得进词表。 */
function isWorthKeeping(word, stopwords) {
  if (stopwords.has(word)) return false;
  if (EXTRA_STOPWORDS.has(word)) return false;
  if (hasFuncChar(word)) return false;
  return true;
}

/** 把一段文本切成「纯汉字段」，非汉字一律当分隔符。 */
function cjkRuns(text) {
  return String(text ?? '')
    .split(/[^\u4e00-\u9fa5]+/)
    .filter((r) => r.length >= 2);
}

/**
 * 纯统计部分（同步、可单测）。
 *
 * @param {string[]} texts 语料（摘要正文）
 * @param {object} [opts]
 * @returns {{ words: Array<{word: string, freq: number, pmi: number, entropy: number}>,
 *   stats: { chars: number, runs: number, candidates: number, total: number } }}
 */
export function discoverFromTexts(texts, opts = {}) {
  const {
    minFreq = DEFAULT_MIN_FREQ,
    minPMI = DEFAULT_MIN_PMI,
    minEntropy = DEFAULT_MIN_ENTROPY,
    maxLen = DEFAULT_MAX_LEN,
    stopwords = DEFAULT_STOPWORDS,
  } = opts;

  const runs = [];
  for (const t of texts) runs.push(...cjkRuns(t));
  const totalChars = runs.reduce((a, r) => a + r.length, 0);

  if (totalChars === 0) {
    return { words: [], stats: { chars: 0, runs: 0, candidates: 0, total: 0 } };
  }

  // ① 统计 1..maxLen 的 n-gram 频次
  const freq = [null];
  for (let n = 1; n <= maxLen; n += 1) freq.push(new Map());
  for (const run of runs) {
    for (let n = 1; n <= maxLen; n += 1) {
      const m = freq[n];
      for (let i = 0; i + n <= run.length; i += 1) {
        const g = run.slice(i, i + n);
        m.set(g, (m.get(g) ?? 0) + 1);
      }
    }
  }

  const prob = (g) => (freq[g.length]?.get(g) ?? 0) / totalChars;

  /** 最小切分互信息：把候选拆成左右两半，取最松的那一处。 */
  const minPMIOf = (g) => {
    let best = Infinity;
    for (let k = 1; k < g.length; k += 1) {
      const a = g.slice(0, k);
      const b = g.slice(k);
      const pa = prob(a);
      const pb = prob(b);
      if (pa <= 0 || pb <= 0) continue;
      best = Math.min(best, Math.log2(prob(g) / (pa * pb)));
    }
    return best;
  };

  /** 左右熵取较小的一侧：只有两边都自由，才说明它是个完整的词。 */
  const entropyOf = (g) => {
    const left = new Map();
    const right = new Map();
    const n = g.length;
    for (const run of runs) {
      let i = run.indexOf(g);
      while (i >= 0) {
        if (i > 0) {
          const c = run[i - 1];
          left.set(c, (left.get(c) ?? 0) + 1);
        }
        if (i + n < run.length) {
          const c = run[i + n];
          right.set(c, (right.get(c) ?? 0) + 1);
        }
        i = run.indexOf(g, i + 1);
      }
    }
    const H = (m) => {
      let t = 0;
      for (const c of m.values()) t += c;
      if (!t) return 0;
      let h = 0;
      for (const c of m.values()) {
        const p = c / t;
        h -= p * Math.log2(p);
      }
      return h;
    };
    return Math.min(H(left), H(right));
  };

  // ② 先用频次门槛砍候选（熵计算是 O(候选 × 语料)，必须先砍）
  const candidates = [];
  for (let n = 2; n <= maxLen; n += 1) {
    for (const [g, c] of freq[n]) {
      if (c >= minFreq) candidates.push({ g, c, n });
    }
  }

  // ③ 逐个判词
  const words = [];
  for (const { g, c } of candidates) {
    if (!isWorthKeeping(g, stopwords)) continue;
    const pmi = minPMIOf(g);
    if (pmi < minPMI) continue;
    const entropy = entropyOf(g);
    if (entropy < minEntropy) continue;
    words.push({ word: g, freq: c, pmi, entropy });
  }

  words.sort((a, b) => b.freq - a.freq || b.entropy - a.entropy);
  return {
    words,
    stats: { chars: totalChars, runs: runs.length, candidates: candidates.length, total: words.length },
  };
}

/**
 * 异步版：分批处理 + 让出事件循环。
 *
 * 之所以要分批：不分批时整段 PMI+熵计算是 507ms 的连续占用，
 * 会再加一次半秒的界面卡顿。分成小块后实测最大停顿 1ms。
 *
 * @param {string[]} texts
 * @param {object} [opts] 额外支持 onProgress(处理到的文本数, 总数)
 */
export async function discoverWordsAsync(texts, opts = {}) {
  const { onProgress, shouldStop, chunk = 60, ...rest } = opts;

  // 语料切段 + n-gram 统计（这部分很快，40ms 量级，不必分批）
  const runs = [];
  for (const t of texts) runs.push(...cjkRuns(t));
  const totalChars = runs.reduce((a, r) => a + r.length, 0);
  if (totalChars === 0) {
    return { words: [], stats: { chars: 0, runs: 0, candidates: 0, total: 0 } };
  }

  const maxLen = rest.maxLen ?? DEFAULT_MAX_LEN;
  const freq = [null];
  for (let n = 1; n <= maxLen; n += 1) freq.push(new Map());
  for (const run of runs) {
    for (let n = 1; n <= maxLen; n += 1) {
      const m = freq[n];
      for (let i = 0; i + n <= run.length; i += 1) {
        const g = run.slice(i, i + n);
        m.set(g, (m.get(g) ?? 0) + 1);
      }
    }
  }

  const prob = (g) => (freq[g.length]?.get(g) ?? 0) / totalChars;
  const minFreq = rest.minFreq ?? DEFAULT_MIN_FREQ;
  const candidates = [];
  for (let n = 2; n <= maxLen; n += 1) {
    for (const [g, c] of freq[n]) if (c >= minFreq) candidates.push({ g, c });
  }

  const minPMI = rest.minPMI ?? DEFAULT_MIN_PMI;
  const minEntropy = rest.minEntropy ?? DEFAULT_MIN_ENTROPY;
  const stopwords = rest.stopwords ?? DEFAULT_STOPWORDS;
  const words = [];

  // 分批：每 chunk 个候选 yield 一次
  for (let start = 0; start < candidates.length; start += chunk) {
    if (shouldStop?.()) break;
    for (const { g, c } of candidates.slice(start, start + chunk)) {
      if (!isWorthKeeping(g, stopwords)) continue;

      let pmi = Infinity;
      for (let k = 1; k < g.length; k += 1) {
        const a = g.slice(0, k);
        const b = g.slice(k);
        const pa = prob(a);
        const pb = prob(b);
        if (pa <= 0 || pb <= 0) continue;
        pmi = Math.min(pmi, Math.log2(prob(g) / (pa * pb)));
      }
      if (!(pmi >= minPMI)) continue;

      const left = new Map();
      const right = new Map();
      const n = g.length;
      for (const run of runs) {
        let i = run.indexOf(g);
        while (i >= 0) {
          if (i > 0) {
            const ch = run[i - 1];
            left.set(ch, (left.get(ch) ?? 0) + 1);
          }
          if (i + n < run.length) {
            const ch = run[i + n];
            right.set(ch, (right.get(ch) ?? 0) + 1);
          }
          i = run.indexOf(g, i + 1);
        }
      }
      const H = (m) => {
        let t = 0;
        for (const v of m.values()) t += v;
        if (!t) return 0;
        let h = 0;
        for (const v of m.values()) {
          const p = v / t;
          h -= p * Math.log2(p);
        }
        return h;
      };
      const entropy = Math.min(H(left), H(right));
      if (entropy < minEntropy) continue;

      words.push({ word: g, freq: c, pmi, entropy });
    }
    onProgress?.(Math.min(start + chunk, candidates.length), candidates.length);
    await new Promise((r) => setImmediate(r));
  }

  words.sort((a, b) => b.freq - a.freq || b.entropy - a.entropy);
  return {
    words,
    stats: { chars: totalChars, runs: runs.length, candidates: candidates.length, total: words.length },
  };
}

/**
 * 找出文本里出现的所有「真词」。
 *
 * 按首字建索引再匹配：374 个词按首字分桶后，每个位置平均只需试 0.4 个候选，
 * 比拿 374 个词逐个 `indexOf` 快两个数量级。
 *
 * @param {string} text
 * @param {Map<string, string[]>} index 首字 → 词列表
 * @returns {string[]} 命中的词（可能重复，调用方自行去重）
 */
export function findWordsIn(text, index) {
  const s = String(text ?? '');
  if (!s || !index || index.size === 0) return [];
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    const cands = index.get(s[i]);
    if (!cands) continue;
    for (const w of cands) {
      if (s.startsWith(w, i)) out.push(w);
    }
  }
  return out;
}

/** 把词列表建成 `findWordsIn` 需要的东西。 */
export function buildWordIndex(words) {
  const index = new Map();
  for (const w of words) {
    const head = w[0];
    if (!index.has(head)) index.set(head, []);
    index.get(head).push(w);
  }
  return index;
}

export { tokenize };
