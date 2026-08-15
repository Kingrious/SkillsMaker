/**
 * storage.js —— 数据存储层（基于 JSON 文件，MVP 足够）
 *
 * 说明：为了 Demo 零依赖、开箱即用，没有引入数据库。
 *       Skill 资产库 / 报告 / 平台配置 分别存成 data 目录下的 JSON 文件。
 *       所有写操作都是"整体读→内存改→整体写"，Demo 并发量下足够可靠。
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

// 确保 data 目录存在（不存在则创建）
if (!fs.existsSync(config.DATA_DIR)) {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

/** 通用：读 JSON 文件，文件不存在时返回默认值 */
function readJson(fileName, defaultValue) {
  const file = path.join(config.DATA_DIR, fileName);
  try {
    if (!fs.existsSync(file)) return defaultValue;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error(`[storage] 读取 ${fileName} 失败:`, e.message);
    return defaultValue;
  }
}

/** 通用：把对象整体写入 JSON 文件（带 2 空格缩进，方便人工查看） */
function writeJson(fileName, data) {
  const file = path.join(config.DATA_DIR, fileName);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

/** 生成简易唯一 ID（时间戳 + 随机数，Demo 够用） */
function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ==================== Skill 资产库 ==================== */

/** 读取全部 Skill */
function listSkills() {
  return readJson('skills.json', []);
}

/** 保存全部 Skill（整体覆盖写） */
function saveSkills(skills) {
  writeJson('skills.json', skills);
}

/** 按 ID 查询单个 Skill，找不到返回 null */
function getSkill(id) {
  return listSkills().find((s) => s.id === id) || null;
}

/** 新增一个 Skill */
function addSkill(skill) {
  const skills = listSkills();
  skills.push(skill);
  saveSkills(skills);
  return skill;
}

/** 更新一个 Skill（按 id 覆盖字段，返回更新后的对象） */
function updateSkill(id, patch) {
  const skills = listSkills();
  const idx = skills.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  skills[idx] = { ...skills[idx], ...patch, updatedAt: new Date().toISOString() };
  saveSkills(skills);
  return skills[idx];
}

/** 删除一个 Skill（同时级联删除其关联的执行报告，避免孤儿数据） */
function deleteSkill(id) {
  const skills = listSkills();
  const next = skills.filter((s) => s.id !== id);
  if (next.length === skills.length) return false;
  saveSkills(next);
  // 级联删除该 Skill 的所有历史报告
  const reports = readJson('reports.json', []);
  writeJson('reports.json', reports.filter((r) => r.skillId !== id));
  return true;
}

/* ==================== 执行报告 ==================== */

/** 读取某 Skill 的全部报告（按时间倒序） */
function listReports(skillId) {
  const reports = readJson('reports.json', []);
  return reports.filter((r) => r.skillId === skillId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** 保存一份报告 */
function addReport(report) {
  const reports = readJson('reports.json', []);
  reports.push(report);
  writeJson('reports.json', reports);
  return report;
}

/** 按报告 ID 查询 */
function getReport(id) {
  return readJson('reports.json', []).find((r) => r.id === id) || null;
}

/** 更新报告的反馈信息 */
function updateReportFeedback(reportId, feedback) {
  const reports = readJson('reports.json', []);
  const idx = reports.findIndex((r) => r.id === reportId);
  if (idx < 0) return null;
  reports[idx].feedback = feedback;
  writeJson('reports.json', reports);
  return reports[idx];
}

/* ==================== 平台配置（LLM API Key 等） ==================== */

/** 读取平台配置 */
function getPlatformConfig() {
  return readJson('config.json', { llm: {} });
}

/** 保存平台配置 */
function savePlatformConfig(cfg) {
  writeJson('config.json', cfg);
  return cfg;
}

/**
 * 生成不重名的 Skill 名称：与其他资产重名时自动追加（2）（3）……
 * @param {Array} skills 现有 Skill 列表
 * @param {string} name 期望名称
 * @param {string} excludeId 排除自身（改名时传入自己的 id，避免误判自己重名）
 */
function uniqueSkillName(skills, name, excludeId = '') {
  const base = String(name || '').trim() || '未命名 Skill';
  const exists = (n) => skills.some((s) => s.id !== excludeId && s.name === n);
  if (!exists(base)) return base;
  // 名称本身已带（n）序号时从该序号继续递增，否则从（2）开始
  const m = base.match(/^(.*)（(\d+)）$/);
  let stem = base;
  let start = 2;
  if (m) { stem = m[1]; start = parseInt(m[2], 10) + 1; }
  for (let i = start; ; i++) {
    const candidate = `${stem}（${i}）`;
    if (!exists(candidate)) return candidate;
  }
}

module.exports = {
  genId,
  listSkills,
  saveSkills,
  getSkill,
  addSkill,
  updateSkill,
  deleteSkill,
  uniqueSkillName,
  listReports,
  addReport,
  getReport,
  updateReportFeedback,
  getPlatformConfig,
  savePlatformConfig,
};
