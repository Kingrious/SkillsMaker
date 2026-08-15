/**
 * server.js —— 后端服务入口（零依赖，纯 Node 原生 http 模块）
 *
 * 职责：
 * 1. 提供 REST API（/api/*）
 * 2. 托管前端静态资源（public 目录）
 * 3. 统一错误处理：任何接口异常都返回 { error: 中文提示 }，前端不白屏
 *
 * 启动方式：node server/server.js （或 npm start）
 * 访问地址：http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const storage = require('./storage');
const llm = require('./llmService');
const skillGenerator = require('./skillGenerator');
const skillExecutor = require('./skillExecutor');
const { builtinTemplates } = require('./templates');

/* ==================== 工具函数 ==================== */

/** 读取请求体（JSON） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10 * 1024 * 1024) { // 超过 10MB 直接拒绝，防止恶意大包
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/** 统一发送 JSON 响应 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/* ==================== 路由处理 ==================== */

/**
 * 简单路由器：把 /api/skills/:id/reports 这种带参数路径匹配成 { path: '/api/skills', params: {id} }
 */
const ROUTES = [
  { method: 'GET', pattern: /^\/api\/skills\/([^/]+)\/reports$/, handler: 'listReports' },
  { method: 'GET', pattern: /^\/api\/skills\/([^/]+)$/, handler: 'getSkill' },
  { method: 'PUT', pattern: /^\/api\/skills\/([^/]+)$/, handler: 'updateSkill' },
  { method: 'DELETE', pattern: /^\/api\/skills\/([^/]+)$/, handler: 'deleteSkill' },
  { method: 'POST', pattern: /^\/api\/skills\/([^/]+)\/publish$/, handler: 'publishSkill' },
  { method: 'POST', pattern: /^\/api\/skills\/([^/]+)\/archive$/, handler: 'archiveSkill' },
  { method: 'POST', pattern: /^\/api\/skills\/([^/]+)\/execute$/, handler: 'executeSkill' },
  { method: 'GET', pattern: /^\/api\/reports\/([^/]+)$/, handler: 'getReport' },
  { method: 'POST', pattern: /^\/api\/reports\/([^/]+)\/feedback$/, handler: 'reportFeedback' },
];

/** 各路由的具体处理函数 */
const handlers = {
  /* ---- 平台与 LLM ---- */

  health: async (req, res) => sendJson(res, 200, { ok: true, name: '企业岗位经验 Skill 生成平台', time: new Date().toISOString() }),

  llmStatus: async (req, res) => sendJson(res, 200, llm.getStatus()),

  llmConfig: async (req, res) => {
    const body = await readBody(req);
    // 保存 API Key 与模型版本（chat / v4pro / flash）
    const status = llm.setLlmConfig({
      apiKey: String(body.apiKey || ''),
      model: String(body.model || ''),
    });
    sendJson(res, 200, { ok: true, status });
  },

  templates: async (req, res) => {
    // 返回内置场景（前端首页示例卡片用），只暴露必要字段
    sendJson(res, 200, builtinTemplates.map((t) => ({ name: t.name, description: t.description, example: t.keywords[0] })));
  },

  /* ---- Skill 生成与资产库 ---- */

  generateSkill: async (req, res) => {
    const body = await readBody(req);
    const requirement = String(body.requirement || '').trim();
    if (!requirement) return sendJson(res, 400, { error: '请输入您的 Skill 需求描述' });

    // 强制真实模式：未配置 API Key 直接拒绝（已彻底移除演示模式）
    if (!llm.getApiKey()) {
      return sendJson(res, 400, { error: '未配置 LLM API Key，无法生成 Skill。请点击右上角「LLM 设置」配置真实 API Key 后重试' });
    }

    try {
      const result = await skillGenerator.generate(requirement, {
        name: String(body.name || '').trim(), // 用户在创建时指定的名称
      });
      if (result.needClarify) {
        return sendJson(res, 200, { needClarify: true, questions: result.questions });
      }
      sendJson(res, 200, {
        needClarify: false,
        skill: result.skill,          // 7 要素草案（尚未保存）
        mode: result.mode,            // 恒为 real（真实模式）
        model: result.model,          // 本次使用的模型：chat / v4pro / flash
        retries: result.retries || 0,
      });
    } catch (e) {
      sendJson(res, 400, { error: e.message || 'Skill 生成失败' });
    }
  },

  createSkill: async (req, res) => {
    const body = await readBody(req);
    const check = skillGenerator.validateSkill(body.skill);
    if (!check.ok) return sendJson(res, 400, { error: 'Skill 校验失败：' + check.errors.join('；') });

    const now = new Date().toISOString();
    const skill = {
      id: storage.genId('sk'),
      ...skillGenerator.normalizeSkill(body.skill),
      status: 'draft',              // 生命周期：草稿 → 已发布 → 已下线（PRD 5.6）
      version: '0.1',
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    // 防重名：与资产库中已有名称重复时自动追加（2）（3）……
    const originalName = skill.name;
    skill.name = storage.uniqueSkillName(storage.listSkills(), skill.name);
    storage.addSkill(skill);
    sendJson(res, 201, { ok: true, skill, nameDeduped: skill.name !== originalName });
  },

  listSkills: async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const kw = (url.searchParams.get('kw') || '').trim();
    const status = (url.searchParams.get('status') || '').trim();
    let skills = storage.listSkills();
    if (kw) skills = skills.filter((s) => s.name.includes(kw) || s.description.includes(kw));
    if (status) skills = skills.filter((s) => s.status === status);
    // 按更新时间倒序
    skills.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    sendJson(res, 200, { skills });
  },

  getSkill: async (req, res, params) => {
    const skill = storage.getSkill(params[0]);
    if (!skill) return sendJson(res, 404, { error: 'Skill 不存在' });
    sendJson(res, 200, { skill });
  },

  updateSkill: async (req, res, params) => {
    const body = await readBody(req);
    const check = skillGenerator.validateSkill(body.skill);
    if (!check.ok) return sendJson(res, 400, { error: 'Skill 校验失败：' + check.errors.join('；') });
    const current = storage.getSkill(params[0]);
    if (!current) return sendJson(res, 404, { error: 'Skill 不存在' });
    const normalized = skillGenerator.normalizeSkill(body.skill);
    // 防重名：改名时与其他资产重名则自动追加（2）（3）……；名称未变则不动
    const originalName = normalized.name;
    if (normalized.name !== current.name) {
      normalized.name = storage.uniqueSkillName(storage.listSkills(), normalized.name, params[0]);
    }
    const skill = storage.updateSkill(params[0], normalized);
    sendJson(res, 200, { ok: true, skill, nameDeduped: skill.name !== originalName });
  },

  publishSkill: async (req, res, params) => {
    const skill = storage.getSkill(params[0]);
    if (!skill) return sendJson(res, 404, { error: 'Skill 不存在' });
    const check = skillGenerator.validateSkill(skill);
    if (!check.ok) return sendJson(res, 400, { error: '发布前校验失败：' + check.errors.join('；') });
    // 发布：草稿 → 已发布，版本升级为 1.0（若已是正式版则小版本 +0.1）
    const newVersion = skill.status === 'published'
      ? bumpVersion(skill.version)
      : '1.0';
    const updated = storage.updateSkill(params[0], { status: 'published', version: newVersion });
    sendJson(res, 200, { ok: true, skill: updated });
  },

  archiveSkill: async (req, res, params) => {
    const skill = storage.getSkill(params[0]);
    if (!skill) return sendJson(res, 404, { error: 'Skill 不存在' });
    const updated = storage.updateSkill(params[0], { status: 'archived' });
    sendJson(res, 200, { ok: true, skill: updated });
  },

  deleteSkill: async (req, res, params) => {
    const ok = storage.deleteSkill(params[0]);
    if (!ok) return sendJson(res, 404, { error: 'Skill 不存在' });
    sendJson(res, 200, { ok: true });
  },

  /* ---- Skill 执行 ---- */

  executeSkill: async (req, res, params) => {
    const skill = storage.getSkill(params[0]);
    if (!skill) return sendJson(res, 404, { error: 'Skill 不存在' });
    // 硬限制：只有"已发布"的 Skill 才能执行（草稿先发布，已下线先重新发布）
    if (skill.status !== 'published') {
      const hint = skill.status === 'draft'
        ? '当前 Skill 还是草稿状态，不能执行。请先点「🚀 发布 V1.0」发布后再执行'
        : '当前 Skill 已下线，不能执行。请先点「♻ 重新发布」恢复后再执行';
      return sendJson(res, 403, { error: hint });
    }
    const body = await readBody(req);
    const dataText = String(body.dataText || '').trim();
    if (!dataText) return sendJson(res, 400, { error: '请上传数据文件或粘贴表格数据' });

    try {
      // 执行引擎跑完整流程：解析→校验→计算→AI 分析→报告组装
      // compare=true 时启用 Demo 对比模式（载入示例数据流程）：同时生成"使用 Skill / 不使用 Skill"两份报告并做价值对比
      const result = await skillExecutor.execute(skill, dataText, { compare: !!body.compare });
      // 保存报告 + 更新 Skill 执行次数（PRD 5.6 使用统计）
      const savedReport = storage.addReport({
        ...result.report,
        createdAt: new Date().toISOString(),
      });
      storage.updateSkill(skill.id, { runCount: (skill.runCount || 0) + 1 });
      sendJson(res, 200, { ok: true, steps: result.steps, report: savedReport });
    } catch (e) {
      // DATA_MISMATCH 是"数据与定义不匹配"的预期异常，返回结构化 detail 供前端友好展示
      if (e.code === 'DATA_MISMATCH') {
        return sendJson(res, 422, { error: e.message, detail: e.detail });
      }
      sendJson(res, 500, { error: e.message || '执行失败' });
    }
  },

  listReports: async (req, res, params) => {
    const reports = storage.listReports(params[0]);
    // 列表不返回完整 markdown，减小响应体积
    sendJson(res, 200, {
      reports: reports.map((r) => ({
        id: r.id, skillId: r.skillId, skillName: r.skillName,
        modeLabel: r.modeLabel, rowCount: r.rowCount, createdAt: r.createdAt,
        feedback: r.feedback,
      })),
    });
  },

  getReport: async (req, res, params) => {
    const report = storage.getReport(params[0]);
    if (!report) return sendJson(res, 404, { error: '报告不存在' });
    sendJson(res, 200, { report });
  },

  reportFeedback: async (req, res, params) => {
    const body = await readBody(req);
    const type = ['like', 'dislike', 'correction'].includes(body.type) ? body.type : 'like';
    const updated = storage.updateReportFeedback(params[0], {
      type,
      comment: String(body.comment || '').slice(0, 500),
      at: new Date().toISOString(),
    });
    if (!updated) return sendJson(res, 404, { error: '报告不存在' });
    sendJson(res, 200, { ok: true, feedback: updated.feedback });
  },
};

/** 小版本号 +0.1（"1.0" → "1.1"） */
function bumpVersion(v) {
  const parts = String(v).split('.');
  const minor = parseInt(parts[1] || '0', 10) + 1;
  return `${parts[0]}.${minor}`;
}

/* ==================== 静态文件服务 ==================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 安全地读取静态文件（防目录穿越攻击） */
function serveStatic(req, res, pathname) {
  let filePath = path.join(config.PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  // 防止 ../../ 越界访问
  if (!filePath.startsWith(config.PUBLIC_DIR)) {
    return sendJson(res, 403, { error: '禁止访问' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 找不到文件时回退到 index.html（前端是单页应用，支持直接刷新任意子路径）
      fs.readFile(path.join(config.PUBLIC_DIR, 'index.html'), (err2, html) => {
        if (err2) return sendJson(res, 404, { error: '资源不存在' });
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ==================== 服务主入口 ==================== */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    // 1) 先匹配 API 路由
    if (pathname.startsWith('/api/')) {
      // CORS 预检（如果前端与后端分离部署时需要）
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
      }
      // 精确路径路由
      const exact = {
        'GET /api/health': 'health',
        'GET /api/llm/status': 'llmStatus',
        'POST /api/llm/config': 'llmConfig',
        'GET /api/templates': 'templates',
        'POST /api/skills/generate': 'generateSkill',
        'POST /api/skills': 'createSkill',
        'GET /api/skills': 'listSkills',
      };
      const key = `${req.method} ${pathname}`;
      if (exact[key]) {
        return await handlers[exact[key]](req, res, []);
      }
      // 带参数路径路由
      for (const r of ROUTES) {
        if (req.method !== r.method) continue;
        const m = pathname.match(r.pattern);
        if (m) return await handlers[r.handler](req, res, m.slice(1));
      }
      return sendJson(res, 404, { error: `接口不存在：${req.method} ${pathname}` });
    }

    // 2) 其余请求按静态文件处理
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }
    sendJson(res, 405, { error: '方法不允许' });
  } catch (e) {
    console.error('[server] 请求处理异常：', e);
    sendJson(res, 500, { error: e.message || '服务器内部错误' });
  }
});

server.listen(config.PORT, () => {
  const llmStatus = llm.getStatus();
  console.log('======================================================');
  console.log('  企业岗位经验 Skill 生成平台已启动');
  console.log(`  访问地址：http://localhost:${config.PORT}`);
  console.log(`  LLM 状态：${llmStatus.mode === 'real' ? `已接入（模型：${llmStatus.model}）` : '未配置 API Key（LLM 功能不可用，请在页面右上角配置）'}`);
  console.log('======================================================');
});
