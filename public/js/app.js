/**
 * app.js —— 前端主逻辑（单页应用：hash 路由 + 视图渲染）
 *
 * 路由设计：
 *   #/                首页：自然语言输入 → 生成 Skill 草案（7 要素）
 *   #/library         Skill 资产库：列表 / 搜索 / 状态筛选
 *   #/skill/:id       Skill 详情：7 要素在线编辑 / 发布 / 执行入口 / 报告历史
 *   #/execute/:id     执行页：上传/粘贴数据 → 逐步执行 → 生成报告
 *   #/report/:id      报告页：Markdown 渲染 / 复制 / 下载 / 反馈
 */

/* ==================== 工具函数 ==================== */

/** 快捷选择器 */
const $ = (sel, root = document) => root.querySelector(sel);

/** 全局 Toast 提示 */
let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

/** 文本转义（所有插入 HTML 的用户内容都要转义） */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 状态徽章样式映射 */
const STATUS_MAP = { draft: ['草稿', 'draft'], published: ['已发布', 'published'], archived: ['已下线', 'archived'] };

/* ==================== 全局状态 ==================== */

const state = {
  llm: null,             // LLM 接入状态（{mode, model, modelOptions...}）
  draftSkill: null,      // 首页刚生成的 Skill 草案（未保存）
  draftReq: '',          // 生成草案时用的原始需求
  draftName: '',         // 创建时用户起的 Skill 名称
  draftMeta: null,       // 生成模式信息（模型、重试次数等）
  generating: false,     // 是否正在生成 Skill（跨页面保持，切换页面不中断）
  clarifyQuestions: null, // 需求澄清反问问题（切走再回来时恢复展示）
  editingSkill: null,    // 详情页当前编辑中的 Skill
};

/* ==================== 路由 ==================== */

function parseRoute() {
  // 去掉开头的 #/ 后按 / 切分：[part0, part1...]
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return parts; // [] → 首页；['library']；['skill', id]；['execute', id]；['report', id]
}

async function router() {
  const parts = parseRoute();
  const app = $('#app');
  // 导航高亮：
  // 1. 顶部标签页——首页高亮「创建 Skill」，资产库页高亮「Skill 资产库」；
  //    进入某个具体资产后（skill/execute/report 子页）顶部标签保持「创建 Skill」状态不动；
  // 2. 同时给「Skill 资产库」菜单项保留选中/焦点标记（context），明确当前资产来自资产库。
  const assetRoutes = ['skill', 'execute', 'report'];
  const isAssetSubPage = assetRoutes.includes(parts[0]);
  document.querySelectorAll('.nav-link').forEach((a) => {
    const nav = a.dataset.nav;
    const active = nav === (parts[0] === 'library' ? 'library' : 'home');
    a.classList.toggle('active', active);
    a.classList.toggle('context', isAssetSubPage && nav === 'library');
  });
  try {
    if (parts.length === 0) return await renderHome(app);
    if (parts[0] === 'library') return await renderLibrary(app);
    if (parts[0] === 'skill' && parts[1]) return await renderSkillDetail(app, parts[1]);
    if (parts[0] === 'execute' && parts[1]) return await renderExecute(app, parts[1]);
    if (parts[0] === 'report' && parts[1]) return await renderReport(app, parts[1]);
    app.innerHTML = '<div class="empty-state"><div class="es-emoji">🧭</div><p>页面不存在</p><a href="#/">返回首页</a></div>';
  } catch (e) {
    app.innerHTML = `<div class="empty-state"><div class="es-emoji">⚠️</div><p>${esc(e.message)}</p><a href="#/">返回首页</a></div>`;
  }
}

/* ==================== 视图①：首页（创建 Skill） ==================== */

async function renderHome(app) {
  const isReal = state.llm && state.llm.mode === 'real';
  const modelName = (state.llm && state.llm.model) || '—';
  app.innerHTML = `
    <div class="hero">
      <h1 class="hero-title">用一句话，创建一个<span class="grad-text">岗位 AI 员工能力</span></h1>
      <p class="hero-desc">无需代码。描述您的分析需求，平台自动生成结构完整的岗位分析 Skill，上传数据即可产出标准分析报告。</p>
      <div class="flow-strip">
        <span class="flow-step">① 自然语言输入</span><span class="flow-arrow">→</span>
        <span class="flow-step">② Skill 自动生成</span><span class="flow-arrow">→</span>
        <span class="flow-step">③ 配置编辑发布</span><span class="flow-arrow">→</span>
        <span class="flow-step">④ 上传数据执行</span><span class="flow-arrow">→</span>
        <span class="flow-step">⑤ 输出分析报告</span>
      </div>
    </div>

    <div class="input-box">
      <input class="input name-input" id="skill-name-input" maxlength="40" autocomplete="off"
             placeholder="给 Skill 起个名字，例如：抖音直播运营复盘">
      <textarea id="req-input" placeholder="例如：帮我创建一个抖音直播运营复盘 Skill，我需要每场直播结束后分析 GMV、观看人数、转化率，并给出改进建议……"></textarea>
      <div class="input-row">
        <span class="muted small" id="mode-text" style="align-self:center;margin-right:auto">
          ${isReal ? `当前模型：✅ ${esc(modelName)}（真实大模型）` : '⚠️ 未配置 API Key（点击右上角「LLM 设置」配置后才能使用）'}
        </span>
        <button class="btn-primary" id="btn-generate">
          <span class="spinner hidden" id="gen-spinner"></span>✨ 生成 Skill
        </button>
      </div>
    </div>
    <div id="home-extra"></div>
    <h3 style="margin:28px 0 4px;">推荐场景（点击快速填充）</h3>
    <p class="muted small">共 8 个内置岗位场景，全部支持开箱即用的完整分析流程</p>
    <div class="example-cards" id="example-cards"></div>
  `;

  // 加载示例卡片（来自后端内置场景模板）
  const cardBox = $('#example-cards');
  try {
    const templates = await API.templates();
    const emojis = ['📺', '🛒', '📈', '🚀', '🏬', '🎧', '🧑‍💼', '✍️'];
    templates.forEach((t, i) => {
      const div = document.createElement('div');
      div.className = 'example-card';
      div.innerHTML = `
        <div class="ec-emoji">${emojis[i % emojis.length]}</div>
        <div class="ec-title">${esc(t.name)}</div>
        <div class="ec-desc">${esc(t.description.slice(0, 46))}…</div>`;
      div.addEventListener('click', () => {
        // 快速填充：名称 + 需求描述（名称去掉 Demo- 前缀，仅保留资产库里那一个 Demo 做测试）
        $('#skill-name-input').value = t.name.replace(/^Demo-/, '');
        $('#req-input').value = `帮我创建一个${t.name} Skill，需要分析我上传的业务数据，输出专业的分析报告和改进建议`;
        $('#req-input').focus();
      });
      cardBox.appendChild(div);
    });
  } catch (e) { /* 示例卡片加载失败不影响主流程 */ }

  // 生成按钮：核心交互（已彻底移除演示模式，未配置 API Key 时引导用户先配置）
  $('#btn-generate').addEventListener('click', async () => {
    const name = $('#skill-name-input').value.trim();
    const requirement = $('#req-input').value.trim();
    if (!name) { toast('请先给 Skill 起个名字', 'error'); $('#skill-name-input').focus(); return; }
    if (!requirement) return toast('请先输入您的需求描述', 'error');
    if (!state.llm || !state.llm.apiKeyConfigured) {
      toast('请先配置 LLM API Key（真实模式必须）', 'error');
      const modal = $('#settings-modal');
      modal.classList.remove('hidden');
      $('#settings-status').textContent = '';
      return;
    }
    await runGeneration(name, requirement, $('#home-extra'));
  });

  // 切换页面后回到首页：恢复生成现场（输入框内容、进行中状态、澄清反问、已生成的草案）
  if (state.draftName) $('#skill-name-input').value = state.draftName;
  if (state.draftReq) $('#req-input').value = state.draftReq;
  if (state.generating) {
    $('#btn-generate').disabled = true;
    $('#gen-spinner').classList.remove('hidden');
    $('#home-extra').innerHTML = '<p class="muted" style="text-align:center;padding:24px"><span class="spinner dark"></span> 正在分析需求并生成 Skill 七要素…（切换到其他页面不会中断）</p>';
  } else if (state.clarifyQuestions) {
    renderClarify($('#home-extra'), state.clarifyQuestions, state.draftReq, state.draftName);
  } else if (state.draftSkill && state.draftReq) {
    renderDraft($('#home-extra'), state.draftMeta || {});
  }
}

/**
 * 生成 Skill 草案并渲染结果（首页与澄清问答共用）。
 * 生成过程写入全局 state：切换到其他页面不会中断生成，回到首页会自动恢复进度/结果。
 * @param {string} name 用户起的 Skill 名称
 */
async function runGeneration(name, requirement, container) {
  if (state.generating) return toast('正在生成中，请稍候……', 'error');
  state.generating = true;
  state.draftSkill = null;      // 新一轮生成，清掉上一轮未保存的草案
  state.clarifyQuestions = null;
  state.draftName = name;       // 记住名称与需求原文，切走再回来可恢复输入框与结果
  state.draftReq = requirement;
  const btn = $('#btn-generate');
  if (btn) { btn.disabled = true; $('#gen-spinner').classList.remove('hidden'); }
  // 生成过程中用户可能切走再切回，渲染时每次都取“当前首页”的结果容器，而不是持有旧的已销毁节点
  const currentBox = () => $('#home-extra');
  if (currentBox()) {
    currentBox().innerHTML = '<p class="muted" style="text-align:center;padding:24px"><span class="spinner dark"></span> 正在分析需求并生成 Skill 七要素…</p>';
  }
  try {
    const result = await API.generateSkill(requirement, name);
    if (result.needClarify) {
      // 需求澄清（PRD 5.1）：信息不足时反问
      state.clarifyQuestions = result.questions;
      const box = currentBox();
      if (box) renderClarify(box, result.questions, requirement, name);
      else toast('需求还需补充信息，请回到首页继续', 'error');
      return;
    }
    state.draftSkill = result.skill;
    state.draftMeta = result;
    const box = currentBox();
    if (box) renderDraft(box, result);
    else toast('Skill 草案已生成，请回到首页查看', 'success');
  } catch (e) {
    const box = currentBox();
    if (box) {
      box.innerHTML = `<div class="clarify-box" style="background:var(--danger-bg);border-color:#fecaca">
        <h4 style="color:var(--danger)">❌ 生成失败</h4><p>${esc(e.message)}</p></div>`;
    }
    toast(e.message, 'error');
  } finally {
    state.generating = false;
    const b = $('#btn-generate');
    if (b) { b.disabled = false; $('#gen-spinner').classList.add('hidden'); }
  }
}

/** 渲染需求澄清反问框（首页与切回恢复时共用） */
function renderClarify(box, questions, requirement, name) {
  box.innerHTML = `
    <div class="clarify-box">
      <h4>💬 需求信息还不够完整，请补充一下：</h4>
      ${questions.map((q) => `<div class="clarify-q">${esc(q)}</div>`).join('')}
      <div class="input-row">
        <button class="btn-primary" id="btn-reply">补充需求并重新生成</button>
      </div>
    </div>`;
  $('#btn-reply').addEventListener('click', () => {
    const extra = prompt('请补充您的需求（例如岗位、分析什么数据）：', '');
    if (extra && extra.trim()) runGeneration(name, requirement + '，' + extra, box);
  });
}

/** 渲染 Skill 草案：7 要素逐个显现的动画 */
function renderDraft(container, meta) {
  const s = state.draftSkill;
  const items = [
    ['要素 1 · Skill 名称', esc(s.name)],
    ['要素 2 · Skill 描述', esc(s.description)],
    ['要素 3 · 使用场景', esc(`适用岗位：${s.scenarios.role || '—'}；适用时机：${s.scenarios.timing || '—'}；前置条件：${s.scenarios.preconditions || '—'}`)],
    ['要素 4 · 输入数据定义', esc(s.inputDataDef.map((d) => `${d.field}（${d.type}）`).join('、'))],
    ['要素 5 · 分析流程', esc(s.analysisFlow.map((x, i) => `${i + 1}. ${x}`).join('；'))],
    ['要素 6 · Agent Prompt', esc(s.agentPrompt.slice(0, 120) + (s.agentPrompt.length > 120 ? '…' : ''))],
    ['要素 7 · 输出结果模板', esc(s.outputTemplate.join('；'))],
  ];
  const modelName = (state.llm && state.llm.model) || (meta.model || '');
  const modeNote = `✅ 由大模型（${esc(modelName)}）生成${meta.retries > 0 ? `，校验重试 ${meta.retries} 次` : '，一次通过'}`;
  container.innerHTML = `
    <div class="gen-progress">
      <p class="muted small" style="margin-bottom:6px">${modeNote}</p>
      <div id="gen-items"></div>
      <div class="input-row" id="draft-actions">
        <button class="btn-ghost" id="btn-regen">↻ 重新生成</button>
        <button class="btn-primary" id="btn-save-draft">💾 保存为草稿（进入资产库）</button>
      </div>
    </div>`;
  // 逐个显现动画（每 180ms 出现一个要素）
  const box = $('#gen-items');
  items.forEach(([label, value], i) => {
    setTimeout(() => {
      const div = document.createElement('div');
      div.className = 'gen-item';
      div.style.animationDelay = '0s';
      div.innerHTML = `<div class="gi-label">${label}</div><div class="gi-value">${value}</div>`;
      box.appendChild(div);
    }, i * 180);
  });
  $('#btn-regen').addEventListener('click', () => runGeneration(state.draftName, state.draftReq, container));
  $('#btn-save-draft').addEventListener('click', async () => {
    try {
      const { skill, nameDeduped } = await API.createSkill(state.draftSkill);
      // 已保存进资产库，清掉未保存草案，避免回首页时重复展示
      state.draftSkill = null;
      state.draftReq = '';
      state.draftName = '';
      state.draftMeta = null;
      toast(nameDeduped ? `已保存为草稿「${skill.name}」（与已有资产重名，自动加了序号）` : `已保存为草稿「${skill.name}」`, 'success');
      location.hash = `#/skill/${skill.id}`;
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* ==================== 视图②：Skill 资产库 ==================== */

async function renderLibrary(app) {
  app.innerHTML = `
    <h1 class="page-title">Skill 资产库</h1>
    <p class="page-desc">企业岗位经验沉淀为可复用、可管理的数字资产</p>
    <div class="library-toolbar">
      <input class="input" id="lib-kw" placeholder="🔍 搜索 Skill 名称 / 描述……">
      <div class="filter-tabs" id="lib-filter">
        <button class="filter-tab active" data-status="">全部</button>
        <button class="filter-tab" data-status="draft">草稿</button>
        <button class="filter-tab" data-status="published">已发布</button>
        <button class="filter-tab" data-status="archived">已下线</button>
      </div>
    </div>
    <div id="lib-list"></div>
  `;
  const kwInput = $('#lib-kw');
  let status = '';
  $('#lib-filter').addEventListener('click', (e) => {
    const tab = e.target.closest('.filter-tab');
    if (!tab) return;
    document.querySelectorAll('.filter-tab').forEach((t) => t.classList.toggle('active', t === tab));
    status = tab.dataset.status;
    loadList();
  });
  let kwTimer;
  kwInput.addEventListener('input', () => { clearTimeout(kwTimer); kwTimer = setTimeout(loadList, 300); });
  async function loadList() {
    const box = $('#lib-list');
    box.innerHTML = '<p class="muted" style="text-align:center;padding:40px"><span class="spinner dark"></span> 加载中…</p>';
    try {
      const { skills } = await API.listSkills(kwInput.value.trim(), status);
      if (skills.length === 0) {
        box.innerHTML = `<div class="empty-state"><div class="es-emoji">📦</div><p>还没有 Skill 资产</p><a href="#/">去创建一个 →</a></div>`;
        return;
      }
      box.innerHTML = `<div class="skill-grid">${skills.map((s) => {
        const [label, cls] = STATUS_MAP[s.status] || ['未知', ''];
        return `
        <div class="skill-card" data-id="${esc(s.id)}">
          <div class="sc-head">
            <span class="sc-title">${esc(s.name)}</span>
            <span class="badge ${cls}">${label}</span>
            <button class="sc-del sc-rename" title="重命名" aria-label="重命名">✏️</button>
            <button class="sc-del" title="删除该资产" aria-label="删除">🗑</button>
          </div>
          <div class="sc-desc">${esc(s.description)}</div>
          <div class="sc-meta">
            <span>版本 V${esc(s.version)}</span>·<span>执行 ${s.runCount || 0} 次</span>·<span>更新于 ${esc((s.updatedAt || '').slice(0, 10))}</span>
          </div>
        </div>`;}).join('')}</div>`;
      box.querySelectorAll('.skill-card').forEach((card) => {
        const skill = skills.find((x) => x.id === card.dataset.id);
        card.addEventListener('click', () => { location.hash = `#/skill/${card.dataset.id}`; });
        // 改名入口：输入新名称保存；与已有资产重名时后端自动追加序号（2）（3）……
        card.querySelector('.sc-del[title="重命名"]').addEventListener('click', async (e) => {
          e.stopPropagation();
          const newName = (prompt('请输入新的 Skill 名称：', skill.name) || '').trim();
          if (!newName) return;
          if (newName === skill.name) return toast('名称没有变化', 'error');
          try {
            const { skill: updated, nameDeduped } = await API.updateSkill(skill.id, { ...skill, name: newName });
            toast(nameDeduped ? `已改名「${updated.name}」（与已有资产重名，自动加了序号）` : `已改名「${updated.name}」`, 'success');
            loadList();
          } catch (err) { toast(err.message, 'error'); }
        });
        // 删除入口：二次确认防误删，确认后删除并刷新列表（后端同时级联删除关联报告）
        card.querySelector('.sc-del[title="删除该资产"]').addEventListener('click', async (e) => {
          e.stopPropagation();
          const ok = confirm(`确定删除资产「${skill.name}」吗？\n删除后不可恢复，其关联的历史执行报告也会一并删除。`);
          if (!ok) return;
          try {
            await API.deleteSkill(skill.id);
            toast(`已删除「${skill.name}」`, 'success');
            loadList();
          } catch (err) { toast(err.message, 'error'); }
        });
      });
    } catch (e) { box.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p></div>`; }
  }
  loadList();
}

/* ==================== 视图③：Skill 详情 / 编辑 ==================== */

async function renderSkillDetail(app, id) {
  const { skill } = await API.getSkill(id);
  state.editingSkill = JSON.parse(JSON.stringify(skill)); // 深拷贝，编辑不直接改原对象
  const s = state.editingSkill;
  const [label, cls] = STATUS_MAP[s.status] || ['未知', ''];

  app.innerHTML = `
    <div class="detail-head">
      <div>
        <h1 class="page-title" style="margin-bottom:2px">${esc(s.name)} <span class="badge ${cls}">${label} · V${esc(s.version)}</span></h1>
        <p class="muted small">创建于 ${esc(s.createdAt.slice(0, 16).replace('T', ' '))} ｜ 已执行 ${s.runCount || 0} 次</p>
      </div>
      <div class="detail-actions">
        ${s.status === 'draft' ? '<button class="btn-primary" id="btn-publish">🚀 发布 V1.0</button>' : ''}
        ${s.status === 'published' ? '<button class="btn-ghost" id="btn-archive">⏸ 下线</button>' : ''}
        ${s.status === 'archived' ? '<button class="btn-ghost" id="btn-republish">♻ 重新发布</button>' : ''}
        <button class="btn-ghost" id="btn-save">💾 保存修改</button>
        ${s.status === 'published' ? '<button class="btn-primary" id="btn-execute">▶ 上传数据执行</button>' : ''}
      </div>
    </div>
    <p class="page-desc">${esc(s.description)}</p>

    <div class="section-card">
      <h3><span class="section-num">3</span>使用场景</h3>
      <div class="kv-row"><span class="kv-label">适用岗位</span><input class="input kv-value" id="f-role" value="${esc(s.scenarios.role)}"></div>
      <div class="kv-row"><span class="kv-label">适用时机</span><input class="input kv-value" id="f-timing" value="${esc(s.scenarios.timing)}"></div>
      <div class="kv-row"><span class="kv-label">前置条件</span><input class="input kv-value" id="f-pre" value="${esc(s.scenarios.preconditions)}"></div>
    </div>

    <div class="section-card">
      <h3><span class="section-num">4</span>输入数据定义（执行时按此校验上传数据）</h3>
      <div class="field-list" id="field-list"></div>
      <button class="btn-ghost btn-sm" id="btn-add-field" style="margin-top:10px">＋ 添加字段</button>
    </div>

    <div class="section-card">
      <h3><span class="section-num">5</span>分析流程（执行步骤）</h3>
      <div class="step-list" id="step-list"></div>
      <button class="btn-ghost btn-sm" id="btn-add-step" style="margin-top:10px">＋ 添加步骤</button>
    </div>

    <div class="section-card">
      <h3><span class="section-num">6</span>Agent Prompt（驱动大模型以岗位专家口吻分析）</h3>
      <textarea class="input" id="f-agent" rows="4">${esc(s.agentPrompt)}</textarea>
    </div>

    <div class="section-card">
      <h3><span class="section-num">7</span>输出结果模板（报告章节结构）</h3>
      <div class="step-list" id="tpl-list"></div>
      <button class="btn-ghost btn-sm" id="btn-add-tpl" style="margin-top:10px">＋ 添加章节</button>
    </div>

    <div class="section-card">
      <h3><span class="section-num">📊</span>历史执行报告</h3>
      <div id="report-history"><p class="muted">加载中…</p></div>
    </div>
  `;

  // ---- 动态列表渲染：字段 / 步骤 / 模板章节 ----
  function renderFieldList() {
    $('#field-list').innerHTML = s.inputDataDef.map((d, i) => `
      <div class="field-item" data-i="${i}">
        <input class="input" data-k="field" placeholder="字段名，如 GMV(元)" value="${esc(d.field)}">
        <input class="input fi-type" data-k="type" placeholder="类型" value="${esc(d.type)}" list="type-options">
        <input class="input" data-k="desc" placeholder="字段说明" value="${esc(d.desc)}">
        <button class="btn-ghost fi-del" title="删除">✕</button>
      </div>`).join('');
    // 字段变化实时写回 state.editingSkill
    document.querySelectorAll('#field-list .field-item').forEach((item) => {
      const i = +item.dataset.i;
      item.querySelectorAll('input').forEach((inp) => {
        inp.addEventListener('input', () => { s.inputDataDef[i][inp.dataset.k] = inp.value; });
      });
      item.querySelector('.fi-del').addEventListener('click', () => {
        s.inputDataDef.splice(i, 1); renderFieldList();
      });
    });
  }
  function renderStepList() {
    $('#step-list').innerHTML = s.analysisFlow.map((x, i) => `
      <div class="step-item" data-i="${i}">
        <span class="step-index">${i + 1}</span>
        <input class="input" value="${esc(x)}">
        <button class="btn-ghost btn-sm" style="margin-top:6px">✕</button>
      </div>`).join('');
    document.querySelectorAll('#step-list .step-item').forEach((item) => {
      const i = +item.dataset.i;
      item.querySelector('input').addEventListener('input', (e) => { s.analysisFlow[i] = e.target.value; });
      item.querySelector('button').addEventListener('click', () => { s.analysisFlow.splice(i, 1); renderStepList(); });
    });
  }
  function renderTplList() {
    $('#tpl-list').innerHTML = s.outputTemplate.map((x, i) => `
      <div class="step-item" data-i="${i}">
        <span class="step-index">${i + 1}</span>
        <input class="input" value="${esc(x)}">
        <button class="btn-ghost btn-sm" style="margin-top:6px">✕</button>
      </div>`).join('');
    document.querySelectorAll('#tpl-list .step-item').forEach((item) => {
      const i = +item.dataset.i;
      item.querySelector('input').addEventListener('input', (e) => { s.outputTemplate[i] = e.target.value; });
      item.querySelector('button').addEventListener('click', () => { s.outputTemplate.splice(i, 1); renderTplList(); });
    });
  }
  renderFieldList(); renderStepList(); renderTplList();

  $('#btn-add-field').addEventListener('click', () => { s.inputDataDef.push({ field: '新字段', type: '数值', desc: '' }); renderFieldList(); });
  $('#btn-add-step').addEventListener('click', () => { s.analysisFlow.push('新步骤'); renderStepList(); });
  $('#btn-add-tpl').addEventListener('click', () => { s.outputTemplate.push('新章节'); renderTplList(); });

  // ---- 表单字段变化回写 ----
  ['f-role', 'f-timing', 'f-pre', 'f-agent'].forEach((fid) => {
    $(`#${fid}`).addEventListener('input', (e) => {
      const map = { 'f-role': 'role', 'f-timing': 'timing', 'f-pre': 'preconditions', 'f-agent': 'agentPrompt' };
      s[map[fid]] = e.target.value;
    });
  });

  // ---- 操作按钮 ----
  async function saveEdits() {
    try {
      const { skill: updated } = await API.updateSkill(id, s);
      state.editingSkill = JSON.parse(JSON.stringify(updated));
      toast('修改已保存', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }
  $('#btn-save').addEventListener('click', saveEdits);
  const btnExec = $('#btn-execute');
  if (btnExec) btnExec.addEventListener('click', () => { location.hash = `#/execute/${id}`; });
  const btnPub = $('#btn-publish');
  if (btnPub) btnPub.addEventListener('click', async () => {
    await saveEdits();
    try {
      const { skill: published } = await API.publishSkill(id);
      toast(`「${published.name}」已发布 V${published.version}，进入资产库`, 'success');
      renderSkillDetail(app, id);
    } catch (e) { toast(e.message, 'error'); }
  });
  const btnArch = $('#btn-archive');
  if (btnArch) btnArch.addEventListener('click', async () => {
    await API.archiveSkill(id); toast('已下线', 'success'); renderSkillDetail(app, id);
  });
  const btnRepub = $('#btn-republish');
  if (btnRepub) btnRepub.addEventListener('click', async () => {
    await API.publishSkill(id); toast('已重新发布', 'success'); renderSkillDetail(app, id);
  });

  // ---- 历史报告列表 ----
  try {
    const { reports } = await API.listReports(id);
    $('#report-history').innerHTML = reports.length === 0
      ? '<p class="muted">暂无执行记录，点击右上角「上传数据执行」生成第一份报告</p>'
      : `<div class="skill-grid" style="margin-top:6px">${reports.map((r) => `
          <div class="skill-card" data-rid="${esc(r.id)}">
            <div class="sc-head"><span class="sc-title" style="font-size:14px">📄 ${esc((r.createdAt || '').slice(0, 16).replace('T', ' '))}</span></div>
            <div class="sc-desc">数据 ${r.rowCount} 行 ｜ ${esc(r.modeLabel)}</div>
            <div class="sc-meta">${r.feedback ? (r.feedback.type === 'like' ? '👍 已反馈：有用' : r.feedback.type === 'dislike' ? '👎 已反馈：需改进' : '📝 已反馈：纠错') : '未反馈'}</div>
          </div>`).join('')}</div>`;
    document.querySelectorAll('#report-history .skill-card').forEach((c) => {
      c.addEventListener('click', () => { location.hash = `#/report/${c.dataset.rid}`; });
    });
  } catch (e) { $('#report-history').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

/* ==================== 视图④：执行页（上传数据 → 逐步执行） ==================== */

async function renderExecute(app, id) {
  const { skill } = await API.getSkill(id);
  // 硬限制：草稿 / 已下线不能执行（防止直接输入 URL 绕过详情页）
  if (skill.status !== 'published') {
    app.innerHTML = `
      <div class="empty-state">
        <div class="es-emoji">🔒</div>
        <p>${esc(skill.status === 'draft' ? '该 Skill 还是草稿状态，发布后才能执行' : '该 Skill 已下线，重新发布后才能执行')}</p>
        <a href="#/skill/${esc(id)}">← 返回 Skill 详情</a>
      </div>`;
    return;
  }
  const hasSample = /^Demo/i.test(skill.name); // 仅 Demo 前缀的演示项目提供"载入示例数据"能力

  app.innerHTML = `
    <h1 class="page-title">执行 Skill：${esc(skill.name)}</h1>
    <p class="page-desc">${esc(skill.description)}</p>

    <div class="section-card">
      <h3>📥 第一步：接入数据（CSV / 粘贴表格文本）</h3>
      <div class="data-source-tabs">
        <button class="data-tab active" data-tab="upload">📄 上传 CSV 文件</button>
        <button class="data-tab" data-tab="paste">📋 粘贴表格文本</button>
        ${hasSample ? '<button class="data-tab" data-tab="sample">🧪 载入示例数据</button>' : ''}
      </div>
      <div id="data-upload-zone">
        <div class="upload-drop" id="drop-zone">点击选择 CSV 文件，或拖拽文件到此处</div>
        <input type="file" id="file-input" accept=".csv,.txt" class="hidden">
      </div>
      <div id="data-paste-zone" class="hidden">
        <textarea class="input" id="paste-area" rows="7" placeholder="第一行是表头（列名），从第二行开始是数据。支持逗号或制表符分隔。&#10;例如：&#10;日期,销售额(元),订单量&#10;2026-08-01,12000,86&#10;2026-08-02,13500,92"></textarea>
      </div>
      <div id="data-preview"></div>
      <div id="data-errors"></div>
      <div id="compare-hint"></div>
      <div class="input-row" style="margin-top:12px">
        <button class="btn-primary" id="btn-run" disabled>▶ 第二步：执行分析</button>
      </div>
    </div>

    <div class="section-card hidden" id="exec-card">
      <h3>⚙️ 执行过程（确定性计算 + AI 推理混合调度）</h3>
      <div class="exec-steps" id="exec-steps"></div>
    </div>
  `;

  let dataText = '';
  let isSampleData = false; // 当前数据是否来自"载入示例数据"（是则启用 Skill 效果对比）

  /* ---- 数据来源 Tab 切换 ---- */
  document.querySelectorAll('.data-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.data-tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('#data-upload-zone').classList.toggle('hidden', tab.dataset.tab !== 'upload');
      $('#data-paste-zone').classList.toggle('hidden', tab.dataset.tab !== 'paste');
      if (tab.dataset.tab === 'sample') loadSample();
    });
  });

  /* ---- 上传文件（读取为文本；编码由后端自动识别 GBK/UTF-8） ---- */
  const fileInput = $('#file-input');
  const dropZone = $('#drop-zone');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setData(String(reader.result), `文件「${file.name}」`); };
    reader.readAsText(file, 'utf-8');
  });
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setData(String(reader.result), `文件「${file.name}」`); };
    reader.readAsText(file, 'utf-8');
  });

  /* ---- 粘贴文本 ---- */
  $('#paste-area').addEventListener('input', (e) => {
    if (e.target.value.trim()) setData(e.target.value, '粘贴文本');
    else { dataText = ''; isSampleData = false; $('#btn-run').disabled = true; $('#data-preview').innerHTML = ''; $('#compare-hint').innerHTML = ''; }
  });

  /* ---- 载入示例数据（Demo 专属：同时启用 Skill 效果对比） ---- */
  async function loadSample() {
    try {
      const resp = await fetch('sample-data/douyin_live_sample.csv');
      const text = await resp.text();
      if (!text.trim() || text.includes('<html')) throw new Error('示例数据加载失败');
      setData(text, '示例数据（抖音直播 14 场）', true);
      toast('示例数据已载入（将启用 Skill 效果对比）', 'success');
    } catch (e) { toast('示例数据加载失败：' + e.message, 'error'); }
  }

  /* ---- 数据预览（前端解析表头展示，最终解析在后端） ---- */
  function setData(text, sourceName, fromSample = false) {
    dataText = text;
    isSampleData = fromSample;
    const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
    const sep = (lines[0].match(/,/g) || []).length >= (lines[0].match(/\t/g) || []).length ? ',' : '\t';
    const headers = lines[0].split(sep).map((h) => h.replace(/^"|"$/g, '').trim());
    // 预览行数：示例数据（14 行）完整展示；大数据量最多预览 20 行，避免页面卡顿
    const MAX_PREVIEW_ROWS = 20;
    const totalRows = lines.length - 1;
    const shownAll = totalRows <= MAX_PREVIEW_ROWS;
    const rows = lines.slice(1, 1 + MAX_PREVIEW_ROWS).map((l) => l.split(sep).map((c) => c.replace(/^"|"$/g, '').trim()));
    $('#data-preview').innerHTML = `
      <div class="data-preview">
        <p class="small muted" style="margin-bottom:6px">数据来源：${esc(sourceName)} ｜ 共 ${totalRows} 行 ｜ ${headers.length} 列（${shownAll ? `预览全部 ${totalRows} 行` : `预览前 ${rows.length} 行`}）</p>
        <div class="data-preview-wrap${shownAll ? ' preview-all' : ''}"><table>
          <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    // 示例数据：提示将启用对比模式（同时生成"使用 Skill / 不使用 Skill"两份报告并做价值对比）
    $('#compare-hint').innerHTML = isSampleData
      ? `<div class="compare-hint">🧪 <strong>Skill 效果对比已启用</strong>：本次执行将同时生成两份分析报告——「使用当前 Skill」与「不使用任何 Skill（仅基础 LLM 能力）」，并由 AI 对比阐述引入 Skill 带来的优势与业务价值。</div>`
      : '';
    $('#btn-run').disabled = false;
    $('#data-errors').innerHTML = '';
  }

  /* ---- 执行：逐步展示过程 ---- */
  $('#btn-run').addEventListener('click', async () => {
    if (!dataText.trim()) return toast('请先上传或粘贴数据', 'error');
    $('#exec-card').classList.remove('hidden');
    const box = $('#exec-steps');
    box.innerHTML = '';
    const btn = $('#btn-run');
    btn.disabled = true;
    btn.textContent = '⏳ 执行中……';

    try {
      const { steps, report } = await API.executeSkill(id, dataText, { compare: isSampleData });
      // 逐步回放执行过程（增强可信感，对应 PRD 5.4 过程可视化）
      for (const [i, st] of steps.entries()) {
        setTimeout(() => addExecStep(box, st), i * 350);
      }
      setTimeout(() => {
        btn.textContent = '▶ 已完成，查看报告';
        btn.disabled = false;
        toast('分析完成，报告已生成', 'success');
        setTimeout(() => { location.hash = `#/report/${report.id}`; }, 900);
      }, steps.length * 350 + 500);
    } catch (e) {
      // 数据不匹配时给出结构化提示（PRD 6.3：列出缺失字段）
      if (e.data && e.data.detail) {
        const d = e.data.detail;
        $('#data-errors').innerHTML = `
          <div class="clarify-box" style="background:var(--danger-bg);border-color:#fecaca">
            <h4 style="color:var(--danger)">❌ ${esc(e.message)}</h4>
            ${d.matched.length ? `<p>✅ 已匹配字段：${d.matched.map(esc).join('、')}</p>` : ''}
            ${d.issues.length ? `<p>⚠️ 数据质量提示：${d.issues.map(esc).join('；')}</p>` : ''}
          </div>`;
      } else {
        addExecStep(box, { name: '执行失败', status: 'failed', detail: e.message });
      }
      btn.textContent = '▶ 第二步：执行分析';
      btn.disabled = false;
    }
  });
}

/** 往执行步骤区追加一个步骤节点 */
function addExecStep(box, step) {
  const icon = step.status === 'done' ? '✓' : step.status === 'failed' ? '✕' : '●';
  const div = document.createElement('div');
  div.className = 'exec-step';
  div.innerHTML = `
    <span class="exec-dot ${esc(step.status)}">${icon}</span>
    <div><div class="exec-step-name">${esc(step.name)}</div>
    <div class="exec-step-detail">${esc(step.detail || '')}</div></div>`;
  box.appendChild(div);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ==================== 视图⑤：报告页 ==================== */

async function renderReport(app, id) {
  app.innerHTML = '<p class="muted" style="text-align:center;padding:60px"><span class="spinner dark"></span> 加载报告…</p>';
  const { report } = await API.getReport(id);

  // Demo 对比模式：报告同时包含"使用 Skill / 不使用 Skill / 价值对比"三份 Markdown
  const isCompare = !!report.compareMode && !!report.baselineMarkdown;
  const compareBanner = isCompare
    ? '<div class="compare-banner">🧪 <strong>Skill 效果对比</strong>：本次执行同时生成了「使用 Skill」与「不使用任何 Skill（仅基础 LLM 能力）」两份分析报告，并由 AI 完成了价值对比。请切换下方页签查看。</div>'
    : '';
  const compareTabs = isCompare
    ? `<div class="compare-tabs">
        <button class="compare-tab active" data-view="skill">📗 使用 Skill 报告</button>
        <button class="compare-tab" data-view="baseline">📄 无 Skill 基线报告</button>
        <button class="compare-tab" data-view="comparison">⚖️ Skill 价值对比</button>
      </div>`
    : '';

  app.innerHTML = `
    <div class="report-head">
      <div>
        <h1 class="page-title" style="margin-bottom:2px">📊 分析报告</h1>
        <p class="muted small">Skill：${esc(report.skillName)} ｜ ${esc(report.createdAt.slice(0, 16).replace('T', ' '))} ｜ 数据 ${report.rowCount} 行 ｜ ${esc(report.modeLabel)}</p>
      </div>
      <div class="detail-actions">
        <button class="btn-ghost" id="btn-copy">📋 复制 Markdown</button>
        <button class="btn-ghost" id="btn-download">⬇ 下载 .md 文件</button>
        <a class="btn-ghost" href="#/skill/${esc(report.skillId)}">← 返回 Skill</a>
      </div>
    </div>
    ${compareBanner}
    ${compareTabs}
    <div class="report-body" id="report-body"></div>
    <div class="feedback-bar">
      <span class="fb-text">这份报告对您有帮助吗？（反馈将沉淀为 Skill 优化依据）</span>
      <button class="fb-btn like" data-type="like">👍 有用</button>
      <button class="fb-btn dislike" data-type="dislike">👎 需改进</button>
      <button class="fb-btn" id="btn-correct">📝 纠错</button>
    </div>
  `;

  // 对比模式下三份内容：按页签切换渲染；普通模式只有 Skill 报告
  const views = {
    skill: report.markdown,
    baseline: report.baselineMarkdown || '',
    comparison: report.comparisonMarkdown || '',
  };
  let currentView = 'skill';

  function renderBody() {
    $('#report-body').innerHTML = renderMarkdown(views[currentView]);
  }
  // 渲染报告正文（自研 Markdown 渲染器，已做 HTML 转义防 XSS）
  renderBody();

  if (isCompare) {
    document.querySelectorAll('.compare-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.compare-tab').forEach((t) => t.classList.toggle('active', t === tab));
        currentView = tab.dataset.view;
        renderBody();
        toast(currentView === 'skill' ? '已切换到：使用 Skill 报告' : currentView === 'baseline' ? '已切换到：无 Skill 基线报告' : '已切换到：Skill 价值对比', 'success');
      });
    });
  }

  // 复制 / 下载（对比模式下：复制当前页签内容；下载合并的完整对比文档）
  $('#btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(views[currentView]);
      toast('已复制当前视图 Markdown 到剪贴板', 'success');
    } catch (e) {
      toast('复制失败，请手动选择文本复制', 'error');
    }
  });
  $('#btn-download').addEventListener('click', () => {
    const downloadMd = isCompare
      ? [
          report.markdown,
          '\n\n---\n\n# 附一：基线报告（未使用任何 Skill）\n\n' + (report.baselineMarkdown || ''),
          '\n\n---\n\n# 附二：Skill 价值对比\n\n' + (report.comparisonMarkdown || ''),
        ].join('\n')
      : report.markdown;
    const blob = new Blob([downloadMd], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${report.skillName}-分析报告-${report.createdAt.slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // 反馈
  const currentFeedback = report.feedback ? report.feedback.type : '';
  document.querySelectorAll('.fb-btn[data-type]').forEach((b) => {
    if (currentFeedback === b.dataset.type) b.classList.add('selected', b.dataset.type);
    b.addEventListener('click', async () => {
      try {
        await API.reportFeedback(id, b.dataset.type);
        document.querySelectorAll('.fb-btn[data-type]').forEach((x) => x.classList.remove('selected', 'like', 'dislike'));
        b.classList.add('selected', b.dataset.type);
        toast('感谢反馈！已记录，将用于 Skill 迭代优化', 'success');
      } catch (e) { toast(e.message, 'error'); }
    });
  });
  $('#btn-correct').addEventListener('click', async () => {
    const comment = prompt('请描述报告中哪里不对（例如：第X个数字与数据不符）：', '');
    if (comment && comment.trim()) {
      try {
        await API.reportFeedback(id, 'correction', comment);
        toast('纠错已记录，感谢您的反馈', 'success');
      } catch (e) { toast(e.message, 'error'); }
    }
  });
}

/* ==================== LLM 状态与设置 ==================== */

/** 刷新顶栏 LLM 状态徽章 */
async function refreshLlmBadge() {
  try {
    state.llm = await API.llmStatus();
  } catch (e) {
    state.llm = { mode: 'nokey', model: 'unknown' };
  }
  const badge = $('#llm-badge');
  if (state.llm.mode === 'real') {
    badge.className = 'llm-badge real';
    badge.textContent = `● 大模型已接入（模型：${state.llm.model}）`;
  } else {
    badge.className = 'llm-badge nokey';
    badge.textContent = '○ 未配置 API Key（点击配置）';
  }
  // 同步刷新首页的"当前模型"文字（保存 Key / 切换模型后无需手动刷新页面）
  const modeText = $('#mode-text');
  if (modeText) {
    modeText.textContent = state.llm.mode === 'real'
      ? `当前模型：✅ ${state.llm.model}（真实大模型）`
      : '⚠️ 未配置 API Key（点击右上角「LLM 设置」配置后才能使用）';
  }
}

/** 设置弹窗逻辑 */
function initSettings() {
  const modal = $('#settings-modal');
  const modelSelect = $('#select-model');
  // 填充模型选择器（v4pro / flash / chat，来自后端状态接口）
  const options = (state.llm && state.llm.modelOptions) || ['v4pro', 'flash', 'chat'];
  options.forEach((o) => {
    const opt = document.createElement('option');
    opt.value = typeof o === 'string' ? o : o.id;
    opt.textContent = opt.value;
    modelSelect.appendChild(opt);
  });
  // 默认选中当前保存的模型；无法识别时回退到 chat（与后端默认一致）
  const ids = options.map((o) => (typeof o === 'string' ? o : o.id));
  modelSelect.value = ids.includes(state.llm && state.llm.model)
    ? state.llm.model
    : (ids.includes('chat') ? 'chat' : ids[0]);

  $('#btn-settings').addEventListener('click', () => {
    modal.classList.remove('hidden');
    $('#settings-status').textContent = '';
  });
  $('#llm-badge').addEventListener('click', () => {
    modal.classList.remove('hidden');
    $('#settings-status').textContent = '';
  });
  $('#btn-close-settings').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  $('#btn-save-key').addEventListener('click', async () => {
    const key = $('#input-api-key').value.trim();
    const model = modelSelect.value;
    const status = $('#settings-status');
    if (!key) { status.className = 'modal-status err'; status.textContent = '请输入 API Key'; return; }
    try {
      await API.setLlmConfig(key, model);
      status.className = 'modal-status ok';
      status.textContent = `✅ 保存成功，已接入大模型（模型：${model}）`;
      $('#input-api-key').value = '';
      await refreshLlmBadge();
      setTimeout(() => modal.classList.add('hidden'), 900);
      toast(`LLM 已接入（模型：${model}）`, 'success');
    } catch (e) {
      status.className = 'modal-status err';
      status.textContent = '保存失败：' + e.message;
    }
  });
}

/* ==================== 启动 ==================== */

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', async () => {
  await refreshLlmBadge();
  initSettings();
  router();
});
