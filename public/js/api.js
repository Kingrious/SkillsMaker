/**
 * api.js —— 后端接口封装
 * 前端所有与后端的通信都走这里，统一处理错误提示。
 */
const API = {
  /** 通用请求方法：自动 JSON 序列化 + 错误解析 */
  async request(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const resp = await fetch(path, opts);
    let data = {};
    try { data = await resp.json(); } catch (e) { /* 非 JSON 响应 */ }
    if (!resp.ok) {
      // 后端统一返回 { error: 中文提示 }，直接抛出给页面展示
      const err = new Error(data.error || `请求失败（${resp.status}）`);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  },

  /* ---- 平台 / LLM ---- */
  health: () => API.request('GET', '/api/health'),
  llmStatus: () => API.request('GET', '/api/llm/status'),
  // apiKey 必填；model 为模型版本（chat / v4pro / flash）
  setLlmConfig: (apiKey, model) => API.request('POST', '/api/llm/config', { apiKey, model }),
  templates: () => API.request('GET', '/api/templates'),

  /* ---- Skill ---- */
  // name 为创建时用户指定的 Skill 名称（可选，但页面强制要求填写）
  generateSkill: (requirement, name) => API.request('POST', '/api/skills/generate', { requirement, name }),
  createSkill: (skill) => API.request('POST', '/api/skills', { skill }),
  listSkills: (kw = '', status = '') => API.request('GET', `/api/skills?kw=${encodeURIComponent(kw)}&status=${encodeURIComponent(status)}`),
  getSkill: (id) => API.request('GET', `/api/skills/${id}`),
  updateSkill: (id, skill) => API.request('PUT', `/api/skills/${id}`, { skill }),
  publishSkill: (id) => API.request('POST', `/api/skills/${id}/publish`),
  archiveSkill: (id) => API.request('POST', `/api/skills/${id}/archive`),
  deleteSkill: (id) => API.request('DELETE', `/api/skills/${id}`),

  /* ---- 执行与报告 ---- */
  // opts.compare 为 true 时启用 Demo 对比模式：同时生成"使用 Skill / 不使用 Skill"两份报告并做价值对比
  executeSkill: (id, dataText, opts = {}) => API.request('POST', `/api/skills/${id}/execute`, { dataText, compare: !!opts.compare }),
  listReports: (skillId) => API.request('GET', `/api/skills/${skillId}/reports`),
  getReport: (id) => API.request('GET', `/api/reports/${id}`),
  reportFeedback: (id, type, comment = '') => API.request('POST', `/api/reports/${id}/feedback`, { type, comment }),
};
