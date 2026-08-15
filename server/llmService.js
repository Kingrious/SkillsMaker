/**
 * llmService.js —— LLM 调用层（模型可替换的抽象层，对应 PRD 7.4 "模型可替换"）
 *
 * 设计说明：
 * 1. 平台所有"需要大模型"的地方都统一走这里的 chat() 方法，不在别处直接发 HTTP 请求。
 *    未来要换模型（比如通义千问 / GLM / GPT），只改这一个文件即可。
 * 2. 仅真实模式：必须配置 API Key 才能使用（已彻底移除演示模式，不再有内置模板兜底）。
 * 3. 支持在界面上选择具体模型版本（v4pro / flash / chat，见 config.llm.modelOptions）。
 */
const config = require('./config');
const storage = require('./storage');

/* ==================== 模式判断与状态 ==================== */

/** 判断当前是否配置了 API Key（环境变量优先，其次页面保存的配置） */
function getApiKey() {
  const fileCfg = storage.getPlatformConfig();
  return config.llm.apiKey || (fileCfg.llm && fileCfg.llm.apiKey) || '';
}

/**
 * 把任意来源的模型标识规整为合法的模型 id（chat / v4pro / flash）。
 * 兼容旧值（如 deepseek-chat）或环境变量：带 chat 字样映射回 chat，否则取第一个选项。
 */
function resolveModelId(id) {
  const opts = config.llm.modelOptions;
  if (opts.some((o) => o.id === id)) return id;
  if (/chat/i.test(String(id || ''))) return opts.find((o) => o.id === 'chat') ? 'chat' : opts[0].id;
  return opts[0].id;
}

/** 读取当前选择的模型 id（页面保存的配置优先，其次 config 默认值） */
function getSelectedModel() {
  const fileCfg = storage.getPlatformConfig();
  const selected = (fileCfg.llm && fileCfg.llm.model) || config.llm.model || '';
  return resolveModelId(selected);
}

/** 模型 id → 实际发送给 LLM 接口的模型名（见 config.llm.modelOptions） */
function getModelApiName() {
  const id = getSelectedModel();
  const opt = config.llm.modelOptions.find((o) => o.id === id) || config.llm.modelOptions[0];
  return opt.apiModel;
}

/** 返回当前 LLM 接入状态（前端"设置"面板用它展示） */
function getStatus() {
  const key = getApiKey();
  return {
    mode: key ? 'real' : 'nokey',
    provider: config.llm.provider,
    model: getSelectedModel(),      // 界面展示用：chat / v4pro / flash
    apiModel: getModelApiName(),    // 实际发送给接口的模型名
    apiKeyConfigured: !!key,
    baseUrl: config.llm.baseUrl,
    modelOptions: config.llm.modelOptions.map((o) => o.id),
  };
}

/** 保存用户在页面上填写的 API Key 与模型版本（存到 data/config.json，重启后依然生效） */
function setLlmConfig({ apiKey, model }) {
  const cfg = storage.getPlatformConfig();
  cfg.llm = cfg.llm || {};
  cfg.llm.apiKey = String(apiKey || '').trim();
  if (model) cfg.llm.model = resolveModelId(String(model));
  storage.savePlatformConfig(cfg);
  return getStatus();
}

/* ==================== 真实 LLM 调用（DeepSeek，OpenAI 兼容） ==================== */

/**
 * 调用 DeepSeek 对话接口。
 * @param {Array<{role:string, content:string}>} messages 消息列表（system/user/assistant）
 * @param {object} opts 可选参数 { temperature, jsonMode }
 * @returns {Promise<string>} 模型回复文本
 */
async function callDeepSeek(messages, opts = {}) {
  const key = getApiKey();
  if (!key) {
    throw new Error('未配置 LLM API Key，无法调用大模型');
  }

  const url = `${config.llm.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: getModelApiName(),
    messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 4096,
    // DeepSeek 支持 JSON 输出模式：让模型严格输出合法 JSON，配合下面的 jsonMode 使用
    ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };

  // 用 AbortController 实现超时控制（PRD 7.3：LLM 服务不可用时友好降级，不白屏）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      // 常见错误码给出中文提示，方便排查
      const hints = {
        401: 'API Key 无效，请检查是否填写正确',
        402: '账户余额不足，请前往 DeepSeek 平台充值',
        429: '请求过于频繁或配额不足，请稍后再试',
      };
      throw new Error(`LLM 接口返回 ${resp.status}：${hints[resp.status] || errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const text = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    if (!text) throw new Error('LLM 返回内容为空');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/* ==================== 容错 JSON 提取 ==================== */

/**
 * 从 LLM 回复中提取 JSON 对象（PRD 风险应对：防止"格式漂移"）。
 * LLM 经常在 JSON 外面包一层 ```json ... ``` 代码块或加一些解释文字，
 * 这里做三层容错：
 *   1) 优先提取 ```json 代码块里的内容
 *   2) 再尝试直接整段 JSON.parse
 *   3) 最后用"从第一个 { 到最后一个 }"的截取方式解析
 */
function extractJson(text) {
  if (!text) return null;

  // 第一层：找 ```json 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (e) { /* 继续尝试下一层 */ }
  }

  // 第二层：整段解析
  try { return JSON.parse(text.trim()); } catch (e) { /* 继续 */ }

  // 第三层：截取第一个 { 到最后一个 }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { /* 放弃 */ }
  }
  return null;
}

/** 把对象转成带 ```json 标记的文本，作为消息内容发给模型 */
function toJsonBlock(obj) {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}

module.exports = {
  getStatus,
  setLlmConfig,
  getApiKey,
  getSelectedModel,
  callDeepSeek,
  extractJson,
  toJsonBlock,
};
