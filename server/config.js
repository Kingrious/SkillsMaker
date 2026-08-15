/**
 * config.js —— 全局配置
 * 说明：平台所有可调配置集中在这里，方便统一管理。
 *       LLM 的 API Key 优先从环境变量读取，其次从 data/config.json 读取（用户在页面上设置后保存）。
 */
const path = require('path');

module.exports = {
  // 服务监听端口
  PORT: process.env.PORT || 3000,

  // 项目根目录（server 目录的上一级）
  ROOT_DIR: path.join(__dirname, '..'),

  // 运行时数据目录（Skill 资产库、报告、配置等 JSON 文件都存这里）
  DATA_DIR: path.join(__dirname, 'data'),

  // 前端静态资源目录
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),

  /**
   * LLM 接入配置（OpenAI 兼容接口格式，默认指向 DeepSeek）
   *
   * - apiKey：密钥。读取优先级：
   *     1) 环境变量 DEEPSEEK_API_KEY（推荐，生产安全）
   *     2) data/config.json 中的 llm.apiKey（用户在页面"设置"里填写后保存）
   *     未配置 Key 时平台不可用（已彻底移除演示模式）
   * - baseUrl：接口地址（OpenAI 兼容），可用环境变量 DEEPSEEK_BASE_URL 覆盖
   * - model：默认模型标识（chat / v4pro / flash）
   * - modelOptions：界面可选模型列表。id 为界面展示与存储的标识，
   *     apiModel 为实际发送给 LLM 接口的模型名（按接口要求填写完整名称）。
   */
  llm: {
    provider: 'deepseek',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'chat',
    modelOptions: [
      { id: 'v4pro', apiModel: 'deepseek-v4-pro' },
      { id: 'flash', apiModel: 'deepseek-v4-flash' },
      { id: 'chat', apiModel: 'deepseek-chat' },
    ],
    // 单次 LLM 请求超时时间（毫秒）
    timeoutMs: 120 * 1000,
    // 生成 Skill 失败时的最大重试次数（PRD 要求：最多 3 次）
    maxRetry: 3,
  },

  // Skill 生成配置
  generation: {
    // 需求澄清：信息不足时最多反问 2 轮（PRD 6.3 异常流程）
    maxClarifyRounds: 2,
  },
};
