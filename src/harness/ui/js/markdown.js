import { escapeHtml } from "./dom.js";

// ─── Client-side Markdown-to-HTML parser ─────────────────────────────────
function renderMarkdownToHtml(text) {
  if (!text) return "";
  const lines = text.split("\n");
  let html = "";
  let inCode = false;
  let codeContent = [];
  let codeLang = "";
  let inList = false;
  let listType = ""; // "ul" or "ol"
  
  function closeList() {
    if (inList) {
      html += `</${listType}>`;
      inList = false;
      listType = "";
    }
  }

  for (let line of lines) {
    // ── Inside code block ──
    if (inCode) {
      if (line.trim().startsWith("```")) {
        html += `<pre><code class="language-${codeLang || 'plaintext'}">${escapeHtml(codeContent.join("\n"))}</code></pre>`;
        inCode = false;
        codeContent = [];
        codeLang = "";
      } else {
        codeContent.push(line);
      }
      continue;
    }

    // ── Opening fence ──
    if (line.trim().startsWith("```")) {
      closeList();
      inCode = true;
      codeLang = line.trim().slice(3).trim();
      continue;
    }

    // ── Headers ──
    let m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      closeList();
      const level = m[1].length;
      html += `<h${level}>${renderInlineMarkdown(m[2])}</h${level}>`;
      continue;
    }

    // ── Blockquotes ──
    m = line.match(/^\s{0,3}>\s?(.*)$/);
    if (m) {
      closeList();
      html += `<blockquote>${renderInlineMarkdown(m[1])}</blockquote>`;
      continue;
    }

    // ── Horizontal Rule ──
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList();
      html += "<hr>";
      continue;
    }

    // ── Bullet Lists ──
    m = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (m) {
      if (!inList || listType !== "ul") {
        closeList();
        html += "<ul>";
        inList = true;
        listType = "ul";
      }
      html += `<li>${renderInlineMarkdown(m[3])}</li>`;
      continue;
    }

    // ── Numbered Lists ──
    m = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (m) {
      if (!inList || listType !== "ol") {
        closeList();
        html += "<ol>";
        inList = true;
        listType = "ol";
      }
      html += `<li>${renderInlineMarkdown(m[3])}</li>`;
      continue;
    }

    // ── Empty lines ──
    if (line.trim() === "") {
      closeList();
      html += "<br>";
      continue;
    }

    // ── Plain paragraph line ──
    closeList();
    html += `<p>${renderInlineMarkdown(line)}</p>`;
  }

  closeList();
  
  if (inCode) {
    html += `<pre><code class="language-${codeLang || 'plaintext'}">${escapeHtml(codeContent.join("\n"))}</code></pre>`;
  }

  return html;
}

function renderInlineMarkdown(text) {
  if (!text) return "";
  let escaped = escapeHtml(text);
  
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*]+\*)|(_[^_]+_)/g;
  let out = "";
  let last = 0;
  let mm;
  
  while ((mm = pattern.exec(escaped))) {
    out += escaped.slice(last, mm.index);
    last = mm.index + mm[0].length;
    const tok = mm[0];
    
    if (tok.startsWith("`")) {
      out += `<code>${tok.slice(1, -1)}</code>`;
    } else if (tok.startsWith("**")) {
      out += `<strong>${tok.slice(2, -2)}</strong>`;
    } else if (tok.startsWith("__")) {
      out += `<strong>${tok.slice(2, -2)}</strong>`;
    } else if (tok.startsWith("~~")) {
      out += `<del>${tok.slice(2, -2)}</del>`;
    } else if (tok.startsWith("[")) {
      const lm = tok.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
      if (lm) {
        out += `<a href="${lm[2]}" target="_blank" class="preview-link">${lm[1]}</a>`;
      } else {
        out += tok;
      }
    } else if (tok.startsWith("*")) {
      out += `<em>${tok.slice(1, -1)}</em>`;
    } else if (tok.startsWith("_")) {
      out += `<em>${tok.slice(1, -1)}</em>`;
    } else {
      out += tok;
    }
  }
  
  out += escaped.slice(last);
  return out;
}

export { renderMarkdownToHtml, renderInlineMarkdown };
