/**
 * skillExecutor.js —— Skill 执行引擎（对应 PRD 5.4，本项目技术核心）
 *
 * 设计思想（面试重点）：
 *   "确定性计算步骤（统计、排序、环比）与 LLM 推理步骤（归因、建议）混合调度"
 *   - 数值计算全部由本文件用 JS 完成：结果 100% 准确、可复现、可溯源；
 *   - 归因、结论、建议等"需要经验判断"的步骤才交给 LLM；
 *   - 报告里明确标注每个结论的来源（[数据计算] / [AI 分析]），实现 PRD 5.5 "数据溯源"。
 *
 * 执行流程（每个步骤都有中间产出，前端可逐步可视化展示）：
 *   ① 数据解析：CSV / 粘贴文本 → 结构化表格（自动识别 GBK/UTF-8 编码）
 *   ② 数据校验：对照 Skill 的输入数据定义，检查字段是否缺失（PRD 6.3 异常流程）
 *   ③ 确定性指标计算：汇总、均值、极值、环比、达成率、Top 分类
 *   ④ AI 推理分析：LLM 基于计算结果生成归因与建议（必须已配置 API Key，未配置直接报错）
 *   ⑤ 报告组装与模板校验：按输出模板组装 Markdown 报告，章节缺失自动修复
 *
 * Demo 对比模式（仅"载入示例数据"执行时启用，见 execute 的 opts.compare）：
 *   ⑥ 基线分析：不注入 Skill 的岗位人设与输出模板，让通用 LLM 直接分析原始数据，
 *      生成"未使用任何 Skill"的对照报告；
 *   ⑦ 价值对比：调用 LLM 对两份报告做差异化对比，阐述引入 Skill 的具体优势、
 *      结构化提升与业务价值。
 *   对比模式的每个 LLM 环节均为真实调用（已彻底移除演示模式，无规则引擎降级）。
 */
const llm = require('./llmService');
const { buildReportPrompt } = require('./templates');

/* ==================== ① 数据解析 ==================== */

/**
 * 解析表格文本（CSV / TSV / 粘贴的制表符文本）。
 * 支持：
 *   - 逗号 / 制表符 / 中文逗号分隔（自动探测，以出现次数多的为准）
 *   - 双引号包裹的字段（字段里含分隔符时）
 *   - GBK 与 UTF-8 编码自动识别（国内 Excel 导出的 CSV 多为 GBK）
 * @param {string} text 原始文本
 * @returns {{ columns: string[], rows: object[] }}
 */
function parseTable(text) {
  let content = String(text || '').trim().replace(/^\uFEFF/, ''); // 去掉 BOM
  if (!content) throw new Error('数据为空，请上传文件或粘贴数据');

  // 编码检测：合法 UTF-8 直接解析；否则按 GBK 重新解码
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(Buffer.from(content, 'utf-8'));
  } catch (e) {
    try {
      const decoder = new TextDecoder('gbk', { fatal: true });
      content = decoder.decode(Buffer.from(content, 'latin1'));
    } catch (e2) {
      // GBK 也不支持时保持原样，尽量解析
    }
  }

  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error('数据至少需要 1 行表头 + 1 行数据');

  // 探测分隔符：比较每行逗号/制表符/中文逗号的总出现次数
  const sample = lines.slice(0, 5).join('\n');
  const counts = { ',': 0, '\t': 0, '，': 0 };
  for (const ch of [',', '\t', '，']) {
    counts[ch] = sample.split(ch).length - 1;
  }
  let sep = ',';
  let maxCount = 0;
  for (const ch of [',', '\t', '，']) {
    if (counts[ch] > maxCount) { maxCount = counts[ch]; sep = ch; }
  }
  if (maxCount === 0) throw new Error('无法识别数据分隔符，请使用 CSV 或制表符分隔的表格');

  /** 单行切分：正确处理双引号包裹的字段 */
  function splitLine(line) {
    const cells = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (c === '"') {
          // 两个连续双引号是转义引号，否则关闭引用
          if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuote = false; }
        } else { cur += c; }
      } else if (c === '"') {
        inQuote = true;
      } else if (c === sep) {
        cells.push(cur.trim()); cur = '';
      } else {
        cur += c;
      }
    }
    cells.push(cur.trim());
    return cells;
  }

  const columns = splitLine(lines[0]).map((h) => h.replace(/^"|"$/g, '').trim());
  if (columns.length === 0 || columns.some((c) => !c)) {
    throw new Error('表头解析失败，请检查第一行是否为列名');
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    if (cells.length === 0 || cells.every((c) => !c)) continue; // 跳过空行
    const row = {};
    columns.forEach((col, idx) => { row[col] = (cells[idx] || '').replace(/^"|"$/g, '').trim(); });
    rows.push(row);
  }
  if (rows.length === 0) throw new Error('没有有效数据行');

  return { columns, rows };
}

/* ==================== ② 数据校验（对照输入数据定义） ==================== */

/**
 * 对照 Skill 的 inputDataDef 检查上传数据。
 * 规则（宽松，避免误伤）：定义里的字段只要有一个能在表头中匹配到（完全一致或去掉单位后缀一致）即视为存在。
 * @returns {{ missing: string[], matched: string[], issues: string[] }}
 */
function validateData(skill, table) {
  const def = skill.inputDataDef || [];
  const missing = [];
  const matched = [];
  const issues = [];

  // 列名归一化：去掉括号单位、空格，便于模糊匹配
  const norm = (s) => String(s).replace(/[（(].*?[)）]/g, '').replace(/\s/g, '');
  const normCols = table.columns.map(norm);

  for (const d of def) {
    const nf = norm(d.field);
    const hit = normCols.some((c) => c === nf || c.includes(nf) || nf.includes(c));
    if (hit) matched.push(d.field); else missing.push(d.field);
  }

  // 数据质量检查：每列统计空值比例，>50% 给出提示
  for (const col of table.columns) {
    const emptyCount = table.rows.filter((r) => !String(r[col] || '').trim()).length;
    if (emptyCount / table.rows.length > 0.5) {
      issues.push(`列"${col}"有超过一半为空值`);
    }
  }
  return { missing, matched, issues };
}

/* ==================== ③ 确定性指标计算（纯 JS，结果可溯源） ==================== */

/** 判断字符串能否转成数值 */
function isNumeric(v) {
  if (v === null || v === undefined || v === '') return false;
  const n = Number(String(v).replace(/,/g, '').replace(/[¥￥]/g, ''));
  return !Number.isNaN(n) && isFinite(n);
}

/** 转数值 */
function toNum(v) {
  return Number(String(v).replace(/,/g, '').replace(/[¥￥%]/g, ''));
}

/**
 * 自动指标计算引擎：
 * - 对每个数值列：合计 / 均值 / 最大 / 最小（附最大值所在行号）
 * - 时间序列：以第一个"日期类"或"文本类"列作为时间轴排序，计算关键数值列首末变化率
 * - 达成率：找到含"目标"的列与对应实际列（去掉"目标"前缀后同名），计算整体达成率
 * - 文本列：Top3 取值分布
 * @returns {{ numericStats, timeSeries, goalInfo, topCategories, keyInsights }}
 */
function computeMetrics(table) {
  const { columns, rows } = table;
  const numericCols = columns.filter((c) => {
    const values = rows.map((r) => r[c]).filter((v) => v !== '');
    return values.length > 0 && values.filter(isNumeric).length / values.length >= 0.7;
  });

  const stats = {};
  const keyInsights = [];
  for (const col of numericCols) {
    const values = rows.map((r) => ({ v: toNum(r[col]), idx: rows.indexOf(r) + 2 })).filter((x) => isNumeric(x.v));
    if (values.length === 0) continue;
    const nums = values.map((x) => x.v);
    const sum = nums.reduce((a, b) => a + b, 0);
    const mean = sum / nums.length;
    const max = values.reduce((a, b) => (b.v > a.v ? b : a));
    const min = values.reduce((a, b) => (b.v < a.v ? b : a));
    stats[col] = {
      sum: round(sum), mean: round(mean), min: round(min.v), max: round(max.v),
      count: nums.length,
      maxRow: max.idx, minRow: min.idx,
    };
    // 中性事实描述（只陈述计算结果，不做推断）—— 这是"数据溯源"的基础
    keyInsights.push({
      text: `${col}：合计 ${fmt(sum)}，平均 ${fmt(mean)}，最高 ${fmt(max.v)}（第${max.idx}行），最低 ${fmt(min.v)}（第${min.idx}行）`,
      source: 'data',
    });
  }

  // 时间序列：找时间轴列（含 日期/时间/周/月 字样，或数值单调递增的第一列）
  const timeCol = columns.find((c) => /日期|时间|周|月|天|date|time/i.test(c))
    || columns.find((c) => !numericCols.includes(c));
  const timeSeries = [];
  if (timeCol && numericCols.length > 0) {
    const sorted = [...rows].sort((a, b) => String(a[timeCol]).localeCompare(String(b[timeCol]), 'zh-CN', { numeric: true }));
    const keyCol = numericCols.find((c) => /gmv|销售额|营业额|营收|金额|业绩|新增/i.test(c)) || numericCols[0];
    const first = sorted[0]; const last = sorted[sorted.length - 1];
    if (isNumeric(first[keyCol]) && isNumeric(last[keyCol])) {
      const a = toNum(first[keyCol]); const b = toNum(last[keyCol]);
      const change = a !== 0 ? ((b - a) / Math.abs(a)) * 100 : 0;
      timeSeries.push({
        timeCol, keyCol,
        period: `${String(first[timeCol])} → ${String(last[timeCol])}`,
        firstValue: fmt(a), lastValue: fmt(b),
        changePct: round(change),
      });
      keyInsights.push({
        text: `趋势：${keyCol} 从 ${fmt(a)}（${first[timeCol]}）变为 ${fmt(b)}（${last[timeCol]}），变化 ${change >= 0 ? '+' : ''}${round(change)}%`,
        source: 'data',
      });
      // 相邻周期环比（逐行对比），找波动最大的一步
      let maxStep = null;
      for (let i = 1; i < sorted.length; i++) {
        const prev = toNum(sorted[i - 1][keyCol]); const cur = toNum(sorted[i][keyCol]);
        if (!isNumeric(prev) || !isNumeric(cur) || prev === 0) continue;
        const pct = ((cur - prev) / Math.abs(prev)) * 100;
        if (!maxStep || Math.abs(pct) > Math.abs(maxStep.pct)) {
          maxStep = { from: String(sorted[i - 1][timeCol]), to: String(sorted[i][timeCol]), pct: round(pct) };
        }
      }
      if (maxStep) {
        timeSeries[0].maxStep = maxStep;
        keyInsights.push({
          text: `最大单期波动：${maxStep.from} → ${maxStep.to}，${keyCol} 环比 ${maxStep.pct >= 0 ? '+' : ''}${maxStep.pct}%`,
          source: 'data',
        });
      }
    }
  }

  // 达成率：找"目标"列，对应实际列 = 去掉"目标"后同名列
  const goalInfo = [];
  for (const col of columns) {
    if (!/目标|计划|target|goal/i.test(col) || !isNumeric(rows[0][col])) continue;
    const actualCol = columns.find((c) => c !== col && normEq(c, col.replace(/目标|计划|target|goal/gi, '')));
    if (!actualCol) continue;
    const goalSum = rows.reduce((s, r) => s + (isNumeric(r[col]) ? toNum(r[col]) : 0), 0);
    const actualSum = rows.reduce((s, r) => s + (isNumeric(r[actualCol]) ? toNum(r[actualCol]) : 0), 0);
    const rate = goalSum !== 0 ? (actualSum / goalSum) * 100 : 0;
    // 未达标的行数统计
    const below = rows.filter((r) => isNumeric(r[col]) && isNumeric(r[actualCol]) && toNum(r[actualCol]) < toNum(r[col])).length;
    goalInfo.push({
      goalCol: col, actualCol, goalSum: fmt(goalSum), actualSum: fmt(actualSum),
      ratePct: round(rate), belowCount: below, totalCount: rows.length,
    });
    keyInsights.push({
      text: `达成率：${actualCol} 合计 ${fmt(actualSum)} / 目标 ${fmt(goalSum)} = ${round(rate)}%，共 ${below} 行未达标`,
      source: 'data',
    });
  }

  // 文本列 Top3 分布
  const topCategories = [];
  const textCols = columns.filter((c) => !numericCols.includes(c) && c !== timeCol);
  for (const col of textCols.slice(0, 3)) {
    const counter = {};
    for (const r of rows) {
      const v = String(r[col] || '').trim();
      if (v) counter[v] = (counter[v] || 0) + 1;
    }
    const top = Object.entries(counter).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (top.length > 0) {
      topCategories.push({
        col,
        top: top.map(([name, count]) => ({ name, count, pct: round((count / rows.length) * 100) })),
      });
    }
  }

  return { numericStats: stats, timeSeries, goalInfo, topCategories, keyInsights };
}

/** 归一化后完全相等（去单位/空格/大小写） */
function normEq(a, b) {
  const norm = (s) => String(s).replace(/[（(].*?[)）]/g, '').replace(/\s/g, '').toLowerCase();
  return norm(a) === norm(b);
}

/** 四舍五入保留 2 位小数 */
function round(n) {
  return Math.round(n * 100) / 100;
}

/** 数值格式化：加千分位，保留 2 位小数（整数不显示小数） */
function fmt(n) {
  if (Number.isInteger(n)) return n.toLocaleString('zh-CN');
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ==================== ④ AI 推理分析（真实 LLM） ==================== */

/** 把指标计算结果整理成 LLM 易读的文本摘要 */
function buildDataSummary(table, metrics) {
  const lines = [
    `数据行数：${table.rows.length}`,
    `字段清单：${table.columns.join('、')}`,
    '',
    '【确定性计算结果】（这部分是程序精确计算的，分析时必须引用这些数字）',
    ...metrics.keyInsights.map((k) => '- ' + k.text),
  ];
  if (metrics.goalInfo.length) {
    lines.push('', '【目标达成】');
    metrics.goalInfo.forEach((g) => lines.push(`- ${g.actualCol} vs ${g.goalCol}：达成率 ${g.ratePct}%`));
  }
  return lines.join('\n');
}

/** 把数值统计转成 Markdown 表格文本（报告"核心指标总览"用） */
function metricsToMarkdown(metrics) {
  const lines = ['| 指标列 | 合计 | 平均 | 最高 | 最低 |', '| --- | --- | --- | --- | --- |'];
  for (const [col, s] of Object.entries(metrics.numericStats)) {
    lines.push(`| ${col} | ${fmt(s.sum)} | ${fmt(s.mean)} | ${fmt(s.max)} | ${fmt(s.min)} |`);
  }
  if (metrics.goalInfo.length) {
    lines.push('', '**目标达成情况**', '', '| 实际指标 | 目标指标 | 实际合计 | 目标合计 | 达成率 |', '| --- | --- | --- | --- | --- |');
    metrics.goalInfo.forEach((g) => lines.push(`| ${g.actualCol} | ${g.goalCol} | ${g.actualSum} | ${g.goalSum} | **${g.ratePct}%** |`));
  }
  if (metrics.topCategories.length) {
    lines.push('', '**分类分布 Top3**');
    metrics.topCategories.forEach((t) => {
      lines.push('', `- ${t.col}：${t.top.map((x) => `${x.name}(${x.count}次, ${x.pct}%)`).join('；')}`);
    });
  }
  return lines.join('\n');
}

/**
 * 真实 LLM 分析：把计算结果交给模型，按 Skill 的 agentPrompt + 输出模板生成分析正文。
 * @returns {Promise<string>} Markdown 格式的分析正文（"三、详细分析"之后的章节）
 */
async function analyzeByLLM(skill, table, metrics) {
  const dataSummary = buildDataSummary(table, metrics);
  const messages = buildReportPrompt(skill, metricsToMarkdown(metrics), dataSummary);
  return llm.callDeepSeek(messages, { temperature: 0.5 });
}

/* ==================== ④+ Skill 效果对比（Demo 专属：使用 Skill vs 不使用 Skill） ==================== */

/**
 * 把原始表格转成 Markdown 表格文本（基线分析专用：只给原始数据，
 * 不给确定性计算结果，模拟"没有 Skill 执行引擎"的裸 LLM 分析场景）。
 * @param {object} table 解析后的表格 { columns, rows }
 * @param {number} maxRows 最多传给 LLM 的数据行数（防止超长）
 */
function tableToMarkdown(table, maxRows = 60) {
  const header = `| ${table.columns.join(' | ')} |`;
  const sep = `| ${table.columns.map(() => '---').join(' | ')} |`;
  const rows = table.rows.slice(0, maxRows).map(
    (r) => `| ${table.columns.map((c) => String(r[c] ?? '').replace(/\|/g, '／')).join(' | ')} |`
  );
  const lines = [header, sep, ...rows];
  if (table.rows.length > maxRows) {
    lines.push(`| ……（共 ${table.rows.length} 行，此处仅展示前 ${maxRows} 行） |`);
  }
  return lines.join('\n');
}

/**
 * 构建"不使用任何 Skill"的基线分析 prompt。
 * 与使用 Skill 的分析形成严格对照：不注入 agentPrompt（岗位人设）、
 * 不注入 outputTemplate（输出模板）、不提供确定性计算结果，
 * 仅凭基础 LLM 能力自由分析。
 */
function buildBaselinePrompt(table) {
  return [
    {
      role: 'system',
      content: '你是一名通用数据分析师，没有任何特定岗位的预设方法论与分析模板。请完全凭借你的通用能力，按你自己的判断组织分析内容与报告结构，对用户提供的数据完成一次数据分析。\n\n要求：\n1. 不要套用任何固定报告模板，结构由你自由发挥\n2. 分析必须基于提供的数据，引用数据中的具体数值\n3. 使用 Markdown 格式输出完整报告',
    },
    {
      role: 'user',
      content: `请分析以下表格数据（共 ${table.rows.length} 行、${table.columns.length} 个字段）：\n\n${tableToMarkdown(table)}\n\n请输出你的分析报告（Markdown 格式）。`,
    },
  ];
}

/** 调用 LLM 执行基线分析（不使用任何 Skill，仅通用能力自由分析） */
async function analyzeBaselineByLLM(table) {
  return llm.callDeepSeek(buildBaselinePrompt(table), { temperature: 0.7 });
}

/**
 * 组装"未使用 Skill"的基线报告 Markdown。
 * 结构刻意保持自由简单（不套 Skill 输出模板），与 Skill 报告的标准化结构形成对照。
 */
function assembleBaselineReport(table, analysisText, meta) {
  const lines = [];
  lines.push('# 通用数据分析报告（未使用任何 Skill）');
  lines.push('');
  lines.push(`> 生成时间：${meta.generatedAt} ｜ 数据行数：${table.rows.length} ｜ 生成方式：${meta.modeLabel}`);
  lines.push('');
  lines.push('> 本报告由通用大模型直接对原始数据自由分析生成，**未注入**任何岗位专家经验（Agent Prompt）与输出模板，用于与「使用 Skill」的分析报告进行效果对比。');
  lines.push('');
  lines.push(analysisText);
  return lines.join('\n');
}

/**
 * 构建 Skill 价值对比 prompt：让 LLM 客观对比"使用 Skill"与"未使用 Skill"两份报告，
 * 阐述引入 Skill 带来的具体优势、结构化提升与业务价值。
 */
function buildComparisonPrompt(skill, skillMarkdown, baselineMarkdown) {
  return [
    {
      role: 'system',
      content: '你是一名企业 AI 产品评估专家，负责评估"岗位经验 Skill"相比"直接使用通用大模型"带来的价值。\n\n你将收到针对同一份数据的两个版本分析报告：\n- 报告 A（使用 Skill 生成）：注入了岗位专家人设（Agent Prompt）、标准分析流程与输出模板，关键指标由程序确定性计算并标注数据来源\n- 报告 B（未使用任何 Skill）：由通用大模型凭自身通用能力自由分析生成\n\n请客观对比两份报告，重点阐述引入该 Skill 带来的价值，输出内容必须包含：\n1. **具体优势**：逐条列出报告 A 相比报告 B 的改进点，并引用两份报告中的具体内容作为佐证\n2. **结构化提升**：报告结构、章节完整性、数据口径一致性、可读性与可追溯性方面的提升\n3. **业务价值**：对该岗位业务场景（如复盘、诊断、决策支持）的实际价值\n\n要求：\n- 使用 Markdown 格式输出，结构清晰，关键差异用对比表格呈现\n- 客观公正：报告 B 中值得借鉴之处也应指出\n- 结尾给出「Skill 引入价值」的总结性评价（3~5 句）',
    },
    {
      role: 'user',
      content: `【Skill 信息】\n名称：${skill.name}\n岗位描述：${skill.agentPrompt}\n\n【报告 A：使用 Skill 生成】\n\n${skillMarkdown}\n\n【报告 B：未使用任何 Skill 生成】\n\n${baselineMarkdown}\n\n请输出对比评估报告（Markdown 格式）。`,
    },
  ];
}

/** 调用 LLM 执行 Skill 价值对比 */
async function compareByLLM(skill, skillMarkdown, baselineMarkdown) {
  return llm.callDeepSeek(buildComparisonPrompt(skill, skillMarkdown, baselineMarkdown), { temperature: 0.4 });
}

/**
 * 执行"不使用 Skill"的基线分析：真实调用 LLM（必须已配置 API Key）。
 * @returns {Promise<{ markdown: string, modeLabel: string }>}
 */
async function runBaselineAnalysis(table, metrics, generatedAt) {
  const analysis = await analyzeBaselineByLLM(table);
  return { markdown: assembleBaselineReport(table, analysis, { generatedAt, modeLabel: 'LLM 分析' }), modeLabel: 'LLM 分析' };
}

/**
 * 执行 Skill 价值对比分析：真实调用 LLM（必须已配置 API Key）。
 * @returns {Promise<{ markdown: string, modeLabel: string }>}
 */
async function runComparisonAnalysis(skill, skillMarkdown, baselineMarkdown) {
  const comparison = await compareByLLM(skill, skillMarkdown, baselineMarkdown);
  return { markdown: comparison, modeLabel: 'LLM 分析' };
}

/* ==================== ⑤ 报告组装与模板校验 ==================== */

/**
 * 从输出模板条目中提取章节关键词（"三、目标达成度分析" → "目标达成度分析"），
 * 用于校验报告章节完整性。
 */
function extractSectionKeys(outputTemplate) {
  return outputTemplate.map((line) => {
    const m = String(line).match(/[一二三四五六七八九十]+、\s*(.{2,20})/);
    return m ? m[1].split('（')[0].split('(')[0].trim() : String(line).slice(0, 8);
  });
}

/** 校验 AI 生成的分析正文是否覆盖了输出模板要求的关键章节 */
function checkSections(markdown, sectionKeys) {
  // 报告固定骨架（摘要/指标总览/附录）由程序生成，不属于 AI 输出校验范围
  const fixed = /摘要|总览|附录|速览/;
  const aiKeys = sectionKeys.filter((key) => !fixed.test(key));
  return aiKeys.filter((key) => !markdown.includes(key));
}

/** 基于确定性计算结果生成事实摘要（不含任何推断，可直接溯源） */
function buildSummary(table, metrics) {
  const lines = [];
  const first = metrics.numericStats[Object.keys(metrics.numericStats)[0]];
  if (first) {
    lines.push(`本次共分析 ${table.rows.length} 行数据、${table.columns.length} 个字段。`);
  }
  // 挑 2 条最有信息量的关键事实（优先达成率与趋势）
  const goal = metrics.keyInsights.find((k) => k.text.includes('达成率'));
  const trend = metrics.keyInsights.find((k) => k.text.includes('趋势'));
  if (goal) lines.push(goal.text.replace('达成率：', '目标达成方面，'));
  if (trend) lines.push(trend.text.replace('趋势：', '趋势方面，'));
  if (lines.length === 0) lines.push(`本次共分析 ${table.rows.length} 行数据。`);
  return lines.join('\n');
}

/**
 * 组装完整报告 Markdown。
 * 结构：标题 + 事实摘要 + 核心指标总览（确定性计算）+ AI 详细分析 + 要点速览 + 数据附录。
 * 每个来源明确标注 [数据计算] 或 [AI 分析]，实现数据溯源。
 */
function assembleReport(skill, table, metrics, analysisText, meta) {
  const lines = [];
  lines.push(`# ${skill.name} 分析报告`);
  lines.push('');
  lines.push(`> 生成时间：${meta.generatedAt} ｜ Skill 版本：V1.0 ｜ 数据行数：${table.rows.length} ｜ 分析模式：${meta.modeLabel}`);
  lines.push('');
  lines.push('## 一、分析摘要');
  lines.push('');
  lines.push(`> 本摘要由程序基于确定性计算自动生成，全部为可溯源的事实陈述。 [数据计算]`);
  lines.push('');
  lines.push(buildSummary(table, metrics));
  lines.push('');
  lines.push('## 二、核心指标总览');
  lines.push('');
  lines.push(`> 本表由程序对原始数据**确定性计算**得出，可直接溯源至源数据。 [数据计算]`);
  lines.push('');
  lines.push(metricsToMarkdown(metrics));
  lines.push('');
  lines.push('## 三、详细分析');
  lines.push('');
  lines.push(`> 本章节由大模型基于确定性计算结果推理生成，供人工复核。 [AI 分析]`);
  lines.push('');
  lines.push(analysisText);
  lines.push('');
  lines.push('## 四、结论与改进建议（要点速览）');
  lines.push('');
  lines.push(`> 速览由程序从确定性计算结果中提取，完整分析见第三章。 [数据计算]`);
  lines.push('');
  lines.push('**核心事实**：');
  metrics.keyInsights.slice(0, 3).forEach((k) => lines.push(`- ${k.text}`));
  const adviceChapterKey = extractSectionKeys(skill.outputTemplate).find((k) => /建议|优化|策略|改进/.test(k));
  if (adviceChapterKey && analysisText.includes(adviceChapterKey)) {
    lines.push('');
    lines.push(`**改进建议已包含在第三章「${adviceChapterKey}」中，请以该章节为准。**`);
  }
  lines.push('');
  lines.push('## 五、数据附录');
  lines.push('');
  lines.push(`- **数据字段**：${table.columns.join('、')}`);
  lines.push(`- **数据行数**：${table.rows.length}`);
  lines.push(`- **计算口径**：合计=逐行求和；平均=合计÷行数；达成率=实际合计÷目标合计×100%；环比=本期较上期变化÷上期×100%`);
  if (meta.skillId) lines.push(`- **Skill 编号**：${meta.skillId}`);
  return lines.join('\n');
}

/* ==================== 对外主入口 ==================== */

/**
 * 执行 Skill（主入口）。
 * @param {object} skill 完整的 Skill 对象
 * @param {string} dataText 用户上传/粘贴的表格文本
 * @param {object} opts 可选参数 { compare: boolean }
 *   compare 为 true 时启用 Demo 对比模式（仅"载入示例数据"流程传入）：
 *   同时生成"使用 Skill"与"不使用任何 Skill"两份报告，并调用 LLM 做价值对比。
 * @returns {Promise<object>} { steps, report } steps 为各步骤中间产出，report 为最终报告
 */
async function execute(skill, dataText, opts = {}) {
  const compareMode = !!opts.compare; // Demo 专属：载入示例数据执行时启用 Skill 效果对比
  const steps = []; // 过程可视化：每个步骤的产出都记录下来
  const pushStep = (name, status, detail) => steps.push({ name, status, detail, at: new Date().toISOString() });

  /* ① 数据解析 */
  pushStep('数据解析', 'running', '正在解析上传的数据（自动识别编码与分隔符）……');
  const table = parseTable(dataText);
  pushStep('数据解析', 'done', `解析成功：共 ${table.rows.length} 行数据，${table.columns.length} 个字段（${table.columns.join('、')}）`);

  /* ② 数据校验 */
  pushStep('数据校验', 'running', `对照 Skill 输入数据定义（${skill.inputDataDef.length} 个字段）进行校验……`);
  const check = validateData(skill, table);
  if (check.missing.length > 0) {
    // PRD 6.3：上传数据与输入定义不匹配 → 明确提示缺失字段
    const err = new Error(`上传数据与 Skill 输入定义不匹配，缺失字段：${check.missing.join('、')}`);
    err.code = 'DATA_MISMATCH';
    err.detail = { missing: check.missing, matched: check.matched, issues: check.issues };
    pushStep('数据校验', 'failed', err.message);
    throw err;
  }
  pushStep('数据校验', 'done', `校验通过：定义字段全部匹配${check.issues.length ? '；提示：' + check.issues.join('；') : ''}`);

  /* ③ 确定性指标计算（纯 JS，不依赖 LLM） */
  pushStep('指标计算', 'running', '程序正在执行确定性计算（汇总、均值、极值、环比、达成率）……');
  const metrics = computeMetrics(table);
  pushStep('指标计算', 'done', `计算完成：${Object.keys(metrics.numericStats).length} 个数值指标、${metrics.goalInfo.length} 组达成率、${metrics.timeSeries.length} 组趋势分析`);

  /* ④ AI 推理分析：必须已配置 API Key 的真实 LLM 调用（已移除演示模式与规则降级） */
  let analysisText;
  const modeLabel = 'LLM 分析';
  if (!llm.getApiKey()) {
    pushStep('AI 推理分析', 'failed', '未配置 LLM API Key');
    throw new Error('未配置 LLM API Key，无法执行 AI 推理分析。请点击右上角「LLM 设置」配置真实 API Key 后重试');
  }
  pushStep('AI 推理分析', 'running', '正在调用大模型进行归因分析与建议生成……');
  try {
    analysisText = await analyzeByLLM(skill, table, metrics);
    pushStep('AI 推理分析', 'done', '大模型分析完成');
  } catch (e) {
    console.warn('[skillExecutor] LLM 分析失败：', e.message);
    pushStep('AI 推理分析', 'failed', e.message);
    throw new Error(`LLM 分析失败：${e.message}`);
  }

  /* ⑤ 报告组装 + 输出模板校验（缺失章节自动修复） */
  if (!compareMode) {
    pushStep('报告生成', 'running', `正在按 Skill 输出模板（${skill.outputTemplate.length} 个章节要求）组装报告……`);
  }
  const sectionKeys = extractSectionKeys(skill.outputTemplate);
  // 校验 AI 分析正文是否覆盖模板要求的关键章节；缺失时补一段兜底内容（PRD 6.3：降级标注）
  const missingSections = checkSections(analysisText, sectionKeys);
  let finalAnalysis = analysisText;
  if (missingSections.length > 0) {
    const fallback = [
      '',
      `> 以下章节在大模型输出中缺失，由程序自动补充（降级处理，需人工复核）：${missingSections.join('、')}`,
      ...missingSections.map((k) => `\n**${k}**\n\n（该章节由程序根据确定性计算指标自动生成，见"核心指标总览"）`),
    ].join('\n');
    finalAnalysis = analysisText + '\n' + fallback;
  }

  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  // 先组装"使用 Skill"的完整报告（对比模式下还需作为价值对比的输入）
  const markdown = assembleReport(skill, table, metrics, finalAnalysis, { generatedAt, modeLabel, skillId: skill.id });

  /* ⑥ 对比模式：同时生成"不使用 Skill"的基线报告，并对两份报告做价值对比 */
  let baselineMarkdown = '';
  let baselineModeLabel = '';
  let comparisonMarkdown = '';
  let comparisonModeLabel = '';
  if (compareMode) {
    pushStep('基线分析（不使用 Skill）', 'running', '正在调用通用大模型直接分析原始数据（不注入 Skill 的岗位人设与输出模板）……');
    const baseline = await runBaselineAnalysis(table, metrics, generatedAt);
    baselineMarkdown = baseline.markdown;
    baselineModeLabel = baseline.modeLabel;
    pushStep('基线分析（不使用 Skill）', 'done', `基线报告生成完成（${baselineModeLabel}）`);

    pushStep('Skill 价值对比', 'running', '正在调用大模型对两份报告进行差异化与价值对比……');
    const comparison = await runComparisonAnalysis(skill, markdown, baselineMarkdown);
    comparisonMarkdown = comparison.markdown;
    comparisonModeLabel = comparison.modeLabel;
    pushStep('Skill 价值对比', 'done', `价值对比完成（${comparisonModeLabel}），已阐述 Skill 带来的优势与业务价值`);
  }

  pushStep('报告生成', 'done', compareMode
    ? '报告组装完成：使用 Skill 报告 + 基线报告 + 价值对比已全部生成'
    : (missingSections.length > 0
      ? `报告组装完成；提示：LLM 输出缺失 ${missingSections.length} 个章节，已自动降级补充`
      : '报告组装完成，输出模板章节校验全部通过'));

  return {
    steps,
    report: {
      id: require('./storage').genId('rpt'),
      skillId: skill.id,
      skillName: skill.name,
      markdown,
      modeLabel,
      generatedAt,
      rowCount: table.rows.length,
      columnCount: table.columns.length,
      missingSections: missingSections.length > 0 ? missingSections : [],
      // Demo 对比模式专属字段（普通执行时为空字符串，前端据此判断是否展示对比视图）
      compareMode,
      baselineMarkdown,
      baselineModeLabel,
      comparisonMarkdown,
      comparisonModeLabel,
      feedback: null,
      createdAt: new Date().toISOString(),
    },
  };
}

module.exports = { execute, parseTable, computeMetrics, validateData };
