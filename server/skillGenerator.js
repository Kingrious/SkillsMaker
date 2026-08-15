/**
 * skillGenerator.js —— Skill 自动生成服务（对应 PRD 5.2）
 *
 * 核心流程（仅真实模式，已彻底移除演示模式）：
 *   必须已配置 LLM API Key → 调用 LLM 按 7 要素生成 JSON → schema 校验
 *   → 校验失败则把"哪里不对"反馈给 LLM 重试（最多 3 次，PRD 6.3）
 *   → 3 次仍失败：直接报错提示（不再降级为内置模板）
 *
 * 还实现 PRD 5.1 的"需求澄清"：输入过短（信息不足）时，返回反问问题而不是直接生成。
 */
const llm = require('./llmService');
const { skillGenSystemPrompt } = require('./templates');

/* ==================== 7 要素 schema 校验 ==================== */

/**
 * 校验 LLM 生成的 Skill 是否 7 要素齐全。
 * @returns {{ ok: boolean, errors: string[] }} ok 是否通过，errors 逐条说明哪里不合规
 */
function validateSkill(skill) {
  const errors = [];
  if (!skill || typeof skill !== 'object') return { ok: false, errors: ['输出不是有效的 JSON 对象'] };

  if (!skill.name || typeof skill.name !== 'string') errors.push('缺少要素1：Skill 名称 name');
  if (!skill.description || typeof skill.description !== 'string') errors.push('缺少要素2：Skill 描述 description');

  // 要素3：使用场景。允许对象 {role,timing,preconditions} 或非空字符串
  const hasScenarios = (skill.scenarios && typeof skill.scenarios === 'object'
    && (skill.scenarios.role || skill.scenarios.timing || skill.scenarios.preconditions))
    || (typeof skill.scenarios === 'string' && skill.scenarios.trim());
  if (!hasScenarios) errors.push('缺少要素3：使用场景 scenarios（需含 role/timing/preconditions）');

  // 要素4：输入数据定义。允许数组（每项含 field）或非空对象/字符串
  const defArr = Array.isArray(skill.inputDataDef) ? skill.inputDataDef : [];
  const hasInput = defArr.length > 0
    || (skill.inputDataDef && typeof skill.inputDataDef === 'object' && Object.keys(skill.inputDataDef).length > 0)
    || (typeof skill.inputDataDef === 'string' && skill.inputDataDef.trim());
  if (!hasInput) errors.push('缺少要素4：输入数据定义 inputDataDef');

  // 要素5：分析流程，必须是非空字符串数组
  if (!Array.isArray(skill.analysisFlow) || skill.analysisFlow.length === 0
    || skill.analysisFlow.some((s) => typeof s !== 'string' || !s.trim())) {
    errors.push('缺少要素5：分析流程 analysisFlow（需为非空字符串数组）');
  }

  // 要素6：Agent Prompt
  if (!skill.agentPrompt || typeof skill.agentPrompt !== 'string') {
    errors.push('缺少要素6：Agent Prompt agentPrompt');
  }

  // 要素7：输出结果模板，必须是非空数组（或非空字符串）
  const hasTemplate = (Array.isArray(skill.outputTemplate) && skill.outputTemplate.length > 0)
    || (typeof skill.outputTemplate === 'string' && skill.outputTemplate.trim());
  if (!hasTemplate) errors.push('缺少要素7：输出结果模板 outputTemplate');

  return { ok: errors.length === 0, errors };
}

/* ==================== 规范化 ==================== */

/** 把 LLM 输出的各种形态统一规范成标准结构，供前端展示与执行引擎使用 */
function normalizeSkill(raw) {
  const s = { ...raw };
  // 使用场景：如果是字符串，包成对象
  if (typeof s.scenarios === 'string') {
    s.scenarios = { role: '', timing: '', preconditions: s.scenarios };
  }
  s.scenarios = {
    role: s.scenarios && s.scenarios.role ? String(s.scenarios.role) : '',
    timing: s.scenarios && s.scenarios.timing ? String(s.scenarios.timing) : '',
    preconditions: s.scenarios && s.scenarios.preconditions ? String(s.scenarios.preconditions) : '',
  };
  // 输入数据定义：字符串/对象 → 统一转数组（兼容 LLM 输出成 {字段: 说明} 的形态）
  if (typeof s.inputDataDef === 'string') {
    s.inputDataDef = [{ field: '数据字段', type: '文本', desc: s.inputDataDef }];
  } else if (!Array.isArray(s.inputDataDef)) {
    s.inputDataDef = Object.entries(s.inputDataDef || {}).map(([field, desc]) => ({
      field, type: '文本', desc: String(desc),
    }));
  }
  s.inputDataDef = s.inputDataDef.map((d) => ({
    field: String(d.field || d.name || '字段'),
    type: String(d.type || '文本'),
    desc: String(d.desc || ''),
  }));
  // 输出模板：字符串 → 数组
  if (typeof s.outputTemplate === 'string') {
    s.outputTemplate = [s.outputTemplate];
  }
  return {
    name: String(s.name || '').trim(),
    description: String(s.description || '').trim(),
    scenarios: s.scenarios,
    inputDataDef: s.inputDataDef,
    analysisFlow: s.analysisFlow.map((x) => String(x)),
    agentPrompt: String(s.agentPrompt || '').trim(),
    outputTemplate: s.outputTemplate.map((x) => String(x)),
  };
}

/* ==================== 需求澄清 ==================== */

/**
 * 判断输入是否"信息不足"，不足时返回 1~2 个反问问题（PRD 5.1 需求澄清）。
 * Demo 简化规则：输入太短（不足 6 个字符）视为信息不足。
 */
function needClarify(requirement) {
  const text = String(requirement || '').trim();
  if (text.length < 6) {
    return {
      needClarify: true,
      questions: [
        '您想创建哪个岗位的分析 Skill？（例如：直播运营、销售管理、电商运营……）',
        '您希望这个 Skill 分析什么数据？（例如：每场直播的 GMV 与观看数据）',
      ],
    };
  }
  return { needClarify: false, questions: [] };
}

/* ==================== 真实 LLM 生成（带校验重试） ==================== */

/**
 * 用 LLM 生成 7 要素（name 为用户在创建时指定的名称，可选）。
 * 失败时把校验错误拼进提示词重试（最多 config.llm.maxRetry 次）。
 */
async function generateByLLM(requirement, name) {
  let lastErrors = [];
  for (let attempt = 0; attempt <= llmGetMaxRetry(); attempt++) {
    let userMsg = `用户需求：${requirement}`;
    if (name) userMsg += `\n用户指定的 Skill 名称：${name}（要素 1 的 name 必须使用这个名称，不得修改）`;
    userMsg += `\n\n请生成该 Skill 的 7 要素 JSON。`;
    if (lastErrors.length > 0) {
      userMsg += `\n\n上一次生成结果校验失败，问题如下：\n${lastErrors.map((e) => '- ' + e).join('\n')}\n请修正后重新输出完整 JSON（7 要素齐全）。`;
    }
    const text = await llm.callDeepSeek(
      [
        { role: 'system', content: skillGenSystemPrompt },
        { role: 'user', content: userMsg },
      ],
      { jsonMode: true, temperature: 0.4 }
    );
    const raw = llm.extractJson(text);
    const check = validateSkill(raw);
    if (check.ok) {
      return { skill: normalizeSkill(raw), retries: attempt, mode: 'real' };
    }
    lastErrors = check.errors;
  }
  // 3 次重试仍失败 → 直接抛错给用户（已移除演示模式，不再降级为内置模板）
  throw new Error(`LLM 生成多次校验失败：${lastErrors.join('；')}`);
}

/** 读取重试次数配置（包一层方便测试） */
function llmGetMaxRetry() {
  const config = require('./config');
  return config.llm.maxRetry;
}

/* ==================== 对外主入口 ==================== */

/**
 * 生成 Skill（主入口，被路由调用）。
 * 仅真实模式：未配置 API Key 时直接报错（已彻底移除演示模式）。
 * @param {string} requirement 用户自然语言需求
 * @param {object} options 可选参数 { name }：用户在创建时指定的 Skill 名称（优先于 LLM 生成的名称）
 * @returns {Promise<object>}
 *   - needClarify 为 true 时返回 { needClarify, questions }
 *   - 否则返回 { needClarify:false, skill, mode:'real', retries, model }
 */
async function generate(requirement, options = {}) {
  // 第一步：需求澄清（信息不足直接反问，不生成）
  const clarify = needClarify(requirement);
  if (clarify.needClarify) return clarify;

  // 第二步：强制真实模式——未配置 Key 直接报错，不再走内置模板
  if (!llm.getApiKey()) {
    throw new Error('未配置 LLM API Key，无法生成 Skill。请点击右上角「LLM 设置」配置真实 API Key 后重试');
  }
  const name = String((options && options.name) || '').trim();
  const result = await generateByLLM(requirement, name);
  // 用户指定的名称优先，保证与创建时输入的名称一致
  if (name) result.skill.name = name;
  return { needClarify: false, ...result, model: llm.getSelectedModel() };
}

module.exports = { generate, validateSkill, normalizeSkill, needClarify };
