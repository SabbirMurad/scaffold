// A small Markdown renderer for Claude's replies in the Claude panel: the
// GitHub-flavoured subset Claude Code writes — headings, bold / italic /
// strikethrough, inline code and fenced code blocks, lists, quotes, tables,
// links and rules. Every piece of text is HTML-escaped before any markup is
// added, so nothing in a reply can inject HTML.

const esc = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Inline markup within one block of text.
function inline(text) {
  // Code spans first, so nothing inside them is formatted; they're swapped out
  // for placeholders while the rest is processed.
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
const isTableRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre class="md-code"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`<div class="md-h md-h${heading[1].length}">${inline(heading[2])}</div>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // Table: a header row, then a |---|---| rule.
    if (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push('<div class="md-table"><table><thead><tr>'
        + head.map(c => `<th>${inline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + head.map((_, k) => `<td>${inline(r[k] || '')}</td>`).join('') + '</tr>').join('')
        + '</tbody></table></div>');
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    // List (nesting by indentation; a wrapped line continues its item).
    if (LIST_ITEM.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m) { items.push({ depth: Math.floor(m[1].replace(/\t/g, '  ').length / 2), ordered: /\d/.test(m[2]), text: m[3] }); i++; }
        else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) { items[items.length - 1].text += ' ' + lines[i].trim(); i++; }
        else break;
      }
      out.push(renderList(items));
      continue;
    }

    // Paragraph: consecutive plain lines, keeping their line breaks.
    const para = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

function startsBlock(lines, i) {
  const line = lines[i];
  return /^\s*(```|~~~)/.test(line) || /^#{1,6}\s/.test(line) || /^\s*>/.test(line) || LIST_ITEM.test(line)
    || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)
    || (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]));
}

function renderList(items) {
  let html = '';
  const open = [];
  for (const item of items) {
    const tagOf = item.ordered ? 'ol' : 'ul';
    while (open.length && open[open.length - 1].depth > item.depth) html += `</li></${open.pop().tag}>`;
    // A bullet list right after a numbered one (or the reverse) is a new list.
    if (open.length && open[open.length - 1].depth === item.depth && open[open.length - 1].tag !== tagOf) {
      html += `</li></${open.pop().tag}>`;
    }
    const top = open[open.length - 1];
    if (!top || top.depth < item.depth) {
      const tag = item.ordered ? 'ol' : 'ul';
      open.push({ depth: item.depth, tag });
      html += `<${tag}>`;
    } else html += '</li>';
    html += `<li>${inline(item.text)}`;
  }
  while (open.length) html += `</li></${open.pop().tag}>`;
  return html;
}
