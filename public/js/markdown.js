/**
 * markdown.js —— 轻量 Markdown 渲染器
 *
 * 为什么自己写而不引入 marked.js？
 * 1. 报告格式由平台自己的输出模板控制，只需要支持有限的语法（标题/表格/列表/引用/加粗/代码）
 * 2. 零外部依赖：没有网络/CDN 的环境也能完整运行，演示更稳
 * 3. 所有 HTML 都经过转义后再拼接，天然防 XSS
 */

/** HTML 转义：任何来自数据/LLM 的文本先转义，防止注入脚本 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内元素：加粗、行内代码、链接 */
function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');          // **加粗**
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');                     // `代码`
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>'); // [链接](url)
  return s;
}

/**
 * 把 Markdown 文本渲染为 HTML。
 * 支持：标题(#~####)、引用(>)、表格(|)、有序/无序列表(短横线、星号、数字点)、分隔线(---)
 */
function renderMarkdown(md) {
  const lines = String(md || '').split(/\r?\n/);
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 表格：以 | 开头，且下一行是 |---| 分隔行
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const header = line.split('|').slice(1, -1).map((c) => c.trim());
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i++;
      }
      html.push('<table><thead><tr>');
      header.forEach((h) => html.push(`<th>${renderInline(h)}</th>`));
      html.push('</tr></thead><tbody>');
      rows.forEach((r) => {
        html.push('<tr>');
        r.forEach((c) => html.push(`<td>${renderInline(c)}</td>`));
        html.push('</tr>');
      });
      html.push('</tbody></table>');
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      html.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      html.push(`<blockquote>${renderInline(line.replace(/^>\s?/, ''))}</blockquote>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { html.push('<hr>'); i++; continue; }

    // 无序列表（- 或 * 开头）
    if (/^\s*[-*]\s+/.test(line)) {
      html.push('<ul>');
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        html.push(`<li>${renderInline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i++;
      }
      html.push('</ul>');
      continue;
    }

    // 有序列表（数字. 开头）
    if (/^\s*\d+[.、]\s+/.test(line)) {
      html.push('<ol>');
      while (i < lines.length && /^\s*\d+[.、]\s+/.test(lines[i])) {
        html.push(`<li>${renderInline(lines[i].replace(/^\s*\d+[.、]\s+/, ''))}</li>`);
        i++;
      }
      html.push('</ol>');
      continue;
    }

    // 空行
    if (!line.trim()) { i++; continue; }

    // 普通段落：把连续的普通行合并成一段
    const para = [];
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,4})\s/.test(lines[i]) && !/^>\s?/.test(lines[i])
      && !/^\s*\|/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])
      && !/^\s*\d+[.、]\s+/.test(lines[i]) && !/^\s*(-{3,}|\*{3,})\s*$/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    html.push(`<p>${renderInline(para.join('<br>'))}</p>`);
  }

  return html.join('\n');
}
