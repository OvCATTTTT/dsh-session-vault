/**
 * 中文 / 混合文本切词。
 *
 * 设计要点（实测得出的结论）：
 *   · FTS5 的 unicode61 分词器**不切分中文**，整句会变成一个 token，检索直接失效。
 *   · FTS5 的 trigram 分词器要求查询 ≥3 字符，"项目""火锅""方案"这类 2 字高频词全部漏掉。
 *   · 因此在入库前把中文切成 bigram（相邻两字），再用 unicode61 索引 —— 实测三查三中。
 *
 * ASCII 词（标识符、路径、包名、命令）原样保留并转小写，它们是技术语料里
 * 信息量最高的部分（`SetNamedSecurityInfoW`、`bge-m3`、`.mjs`）。
 */

/** 中文/日文假名等需要 bigram 处理的区段。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

/** ASCII 词：字母开头，可含字母数字与常见技术符号。 */
const ASCII_WORD = /[A-Za-z][A-Za-z0-9_@./\\:-]*/g;

/** 中文连续串。 */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g;

/**
 * 停用词：过于常见、对区分度没有贡献的 2 字组合。
 * 这些不参与「关键词库」，否则边表会被噪声占满。
 */
export const DEFAULT_STOPWORDS = new Set([
  '可以', '这个', '那个', '一个', '我们', '你们', '他们', '什么', '怎么', '因为',
  '所以', '如果', '但是', '然后', '现在', '已经', '还是', '就是', '不是', '没有',
  '这样', '那样', '这里', '那里', '时候', '问题', '东西', '地方', '事情', '地方',
  '需要', '应该', '可能', '或者', '而且', '并且', '不过', '其实', '自己', '一下',
  '这些', '那些', '一些', '有点', '比较', '非常', '特别', '真的', '确实', '直接',
  // 实测高频、但没有主题意义的虚词组合
  '只有', '不要', '两个', '不会', '一次', '一句', '这是', '这样', '一样', '一直',
  '刚才', '看看', '好像', '觉得', '知道', '认为', '开始', '结束', '继续', '而且',
  '以及', '还有', '虽然', '然而', '因此', '于是', '另外', '其他', '大家', '每个',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'your',
  'are', 'was', 'were', 'but', 'not', 'you', 'can', 'all', 'any', 'has', 'had',
]);

/**
 * 纯功能字。
 *
 * bigram 里**任意一个字**落在这些字上，基本就是跨词边界切出来的碎片。
 * 实测真实库：`的鱼`、`鱼的`、`的工`、`己的`、`里的`、`人的`、`来的`、`我自`、
 * `一就`、`一把`、`上是`、`丁与` 全是这类，占了中文词库的三成以上。
 *
 * 实测这个集合不会误伤真词：`会话`、`最近`、`更新`、`人格`、`关键`、`工作`、
 * `维护`、`数据`、`日志`、`目录`、`索引` 里一个字都不在里面。
 */
export const CJK_FUNC = new Set([...'的了是在和与也都就而被把着过呢吧啊嘛呀哦呃这那我你他她它们']);

/**
 * 判断一个中文 bigram 是否是跨词碎片。
 * @param {string} t
 * @returns {boolean}
 */
export function isCjkFragment(t) {
  if (t.length !== 2) return false;
  for (const ch of t) {
    if (CJK_FUNC.has(ch)) return true;
  }
  return false;
}

/**
 * 代码 / JSON / PowerShell 里的通用字段名。
 *
 * 这些词在技术语料里频繁出现，但对"找到很久之前那次对话"没有任何区分度：
 * 实测真实库按连接度排序时，前 40 名里挤满了 `content`、`length`、`name`、
 * `const`、`categoryinfo`、`lastwritetime` 这类词。它们只在**挖关键词**时过滤，
 * 全文索引（FTS）里保留 —— 用户搜一个字段名时仍然能命中原文。
 */
export const CODE_NOISE = new Set([
  // JSON / JS 语法
  'content', 'length', 'name', 'value', 'type', 'string', 'number', 'boolean',
  'object', 'array', 'function', 'return', 'const', 'let', 'var', 'null',
  'undefined', 'true', 'false', 'export', 'import', 'default', 'async', 'await',
  'class', 'extends', 'this', 'new', 'typeof', 'instanceof', 'try', 'catch',
  'finally', 'throw', 'while', 'break', 'continue', 'else', 'switch', 'case',
  'message', 'error', 'errors', 'stack', 'code', 'data', 'items', 'node',
  'props', 'state', 'props.', 'options', 'params', 'args', 'config', 'status',
  'success', 'failed', 'successfully', 'updated', 'created', 'deleted', 'ok',
  'exit', 'stderr', 'stdout', 'err', 'warn', 'debug', 'info', 'log',
  // PowerShell 错误对象字段（在真实数据里霸榜过）
  'categoryinfo', 'fullyqualifiederrorid', 'lastwritetime', 'exception',
  'targetobject', 'invocationinfo', 'scriptstacktrace', 'errorrecord',
  'psmessage', 'pscomputername', 'psversiontable', 'errordetails',
  // 常见文件后缀碎片
  'md', 'json', 'txt', 'yml', 'yaml', 'mjs', 'cjs', 'tsx', 'jsx', 'png', 'svg',
  // 实测在真实库里霸榜的泛开发词（没有任何主题区分度）
  'check', 'lines', 'line', 'total', 'been', 'fetch', 'tick', 'date', 'mb', 'kb',
  'bytes', 'byte', 'scripts', 'notspecified', 'compress', 'summary', 'summaries',
  'eslint', 'console', 'warn', 'readme', 'head', 'tail', 'tmp', 'temp', 'bin',
  // 英语虚词 / 泛词（会挤掉真正有主题意义的词）
  'if', 'at', 'id', 'none', 'null', 'found', 'body', 'text', 'test', 'tests',
  'root', 'path', 'file', 'files', 'token', 'tokens', 'profile', 'reindex',
  'then', 'than', 'when', 'where', 'which', 'while', 'also', 'only', 'into',
  'out', 'off', 'up', 'down', 'about', 'over', 'more', 'most', 'some', 'such',
  // 英语功能词全家桶：只按词频排序时它们会占满整个榜单
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'by', 'as', 'or', 'no', 'do', 'does', 'did', 'so', 'we',
  'it', 'its', 'he', 'she', 'his', 'her', 'my', 'me', 'us', 'get', 'gets',
  'got', 'set', 'sets', 'has', 'have', 'had', 'not', 'but', 'can', 'could',
  'will', 'would', 'should', 'may', 'might', 'must', 'all', 'any', 'one', 'two',
  'first', 'last', 'next', 'now', 'this', 'that', 'these', 'those', 'they',
  'them', 'their', 'you', 'your', 'we', 'our', 'very', 'well', 'back', 'again',
  'once', 'same', 'other', 'own', 'under', 'above', 'below', 'between',
  'through', 'during', 'before', 'after', 'against', 'because', 'until',
  'without', 'within', 'along', 'across', 'behind', 'beyond', 'plus', 'except',
  'via', 'per', 'etc', 'showing', 'appended', 'enabled', 'active', 'newday',
  'sync-persona', 'sha256', 'utf8', 'ipv6',
  'offset', 'use', 'already', 'cards', 'scope', 'plugin', 'plugins', 'dsh',
]);

/**
 * 摘要正文里的角色标签，例如 `[助手]`、`[tool-result]`。
 * 这些标签是在拼摘要时加给人看的，不该被当成关键词 ——
 * 实测 `tool-result` 曾出现在 3298/4196 条摘要里，直接霸榜第一。
 */
const ROLE_LABEL = /\[(?:用户|助手|系统|工具|工具调用|工具结果|user|assistant|system|tool|tool-call|tool-result|turn|compaction)\]/gi;

/**
 * 判断一个 ASCII token 是否是"挖关键词"时该丢的噪声。
 * @param {string} t 已经小写、已去掉尾部标点的 token
 * @returns {boolean}
 */
export function isNoiseToken(t) {
  if (!t) return true;
  if (t.length > 40) return true;
  // 路径：含分隔符，或盘符开头
  if (t.includes('\\') || t.includes('/')) return true;
  if (/^[a-z]:/.test(t)) return true;
  // 带点的标识符不在这里处理 —— tokenize 会先截断到第一个点
  // （`obsidian.md` → `obsidian`），见 terms() 里的 mining 分支。
  // 哈希 / uuid / base64 碎片
  if (/^[0-9a-f]{16,}$/.test(t)) return true;
  if (CODE_NOISE.has(t)) return true;
  return false;
}

export { ROLE_LABEL };

/**
 * 把文本切成 term 列表。
 *
 * @param {string} text 任意文本
 * @param {object} [opts]
 * @param {number} [opts.minAsciiLen=2] ASCII 词最短长度
 * @param {Set<string>} [opts.stopwords] 停用词集合
 * @param {boolean} [opts.keepStopwords=false] 是否保留停用词
 * @param {boolean} [opts.mining=false] 挖关键词模式：剥角色标签、丢路径与代码字段名
 * @returns {string[]} 去重后的 term 列表（保持首次出现顺序）
 */
export function terms(text, opts = {}) {
  const {
    minAsciiLen = 2,
    stopwords = DEFAULT_STOPWORDS,
    keepStopwords = false,
    mining = false,
  } = opts;
  const raw = String(text ?? '');
  if (!raw) return [];
  const src = mining ? raw.replace(ROLE_LABEL, ' ') : raw;

  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (!t) return;
    if (!keepStopwords && stopwords.has(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  for (const m of src.matchAll(ASCII_WORD)) {
    // 尾部标点不属于词：`error:` / `ok.` / `path.join)` 都该被修掉
    const raw = m[0].toLowerCase().replace(/[.:,;)\]]+$/, '');
    if (!raw) continue;

    // 挖词模式下对"复合标识符"做归一化，而不是整条丢弃。
    //
    // 实测教训：一个聊 Obsidian 的会话里，这个词的真实写法有三种：
    //   `obsidian`        → 直接命中
    //   `obsidian.md`     → 带点
    //   `obsidian_data`   → 带下划线
    //   `D:\notes\base1_test`        → 在路径里
    // 之前的规则把后三种整条扔掉，导致 54 条摘要只剩下 19 条进词库，
    // 用户自然觉得"关键词里怎么没有 obsidian"。
    if (mining) {
      if (/[\\/]/.test(raw)) {
        // 路径：只取**最后两段**。
        //
        // 前面的段基本是无关前缀（`C:\Users\you`、`D:\work\project`），
        // 全拆出来会让 `users` / `you` 这种词爬进关键词榜。
        // 最后一段通常是文件名或项目名，倒数第二段是父目录（往往也是项目名）：
        //   `C:\Users\you\.dsh\whale-work` → dsh(噪声) + whale-work ✅
        //   `D:\work\whale-memory\1-人格记忆` → 1-人格记忆 + whale-memory ✅
        const parts = raw.split(/[\\/]+/).filter(Boolean).slice(-2);
        for (const part of parts) {
          const seg = part
            .replace(/[.:,;)\]]+$/, '') // `obsidian://x` 的首段是 `obsidian:`
            .split(/[._]/)[0]
            .replace(/^-+|-+$/g, '');
          if (seg.length < minAsciiLen) continue;
          if (isNoiseToken(seg)) continue;
          push(seg);
        }
        continue;
      }
      // 点 / 下划线截断到第一个分隔符之前
      const head = raw.split(/[._]/)[0].replace(/^-+|-+$/g, '');
      if (head.length < minAsciiLen) continue;
      if (isNoiseToken(head)) continue;
      push(head);
      continue;
    }

    if (raw.length < minAsciiLen) continue;
    push(raw);
  }

  for (const m of src.matchAll(CJK_RUN)) {
    const run = m[0];
    if (run.length === 1) {
      // 单个汉字（"个""和""了"）对回忆旧事没有区分度，挖词时直接丢
      if (!mining) push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bigram = run.slice(i, i + 2);
      // 跨词边界的碎片（"的鱼""鱼的""里的"）只在挖词时过滤；
      // 全文索引用 full 模式，保留原样以免影响检索召回
      if (mining && isCjkFragment(bigram)) continue;
      push(bigram);
    }
  }

  return out;
}

/**
 * 切词后拼成 FTS5 的分词串（空格分隔，让 unicode61 逐 token 处理）。
 *
 * @param {string} text
 * @param {object} [opts]
 * @returns {string}
 */
export function seg(text, opts = {}) {
  return terms(text, opts).join(' ');
}

/**
 * 检查一个字符串是否以 CJK 为主。
 * @param {string} s
 * @returns {boolean}
 */
export function isCjkHeavy(s) {
  const str = String(s ?? '');
  if (!str) return false;
  const cjk = (str.match(new RegExp(CJK.source, 'g')) ?? []).length;
  return cjk / str.length > 0.3;
}

export { CJK, ASCII_WORD, CJK_RUN };
