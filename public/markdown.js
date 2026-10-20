function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>');
}

/** A deliberately small Markdown subset for strategy documents. */
export function renderMarkdown(markdown = '') {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let paragraph = [];
  let list = null;

  const closeParagraph = () => {
    if (paragraph.length) output.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) output.push(`<${list.type}>${list.items.join('')}</${list.type}>`);
    list = null;
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (heading) {
      closeParagraph(); closeList();
      const level = heading[1].length + 1;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
    } else if (unordered || ordered) {
      closeParagraph();
      const type = ordered ? 'ol' : 'ul';
      if (list?.type !== type) { closeList(); list = { type, items: [] }; }
      list.items.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
    } else if (!line.trim()) {
      closeParagraph(); closeList();
    } else {
      closeList(); paragraph.push(line.trim());
    }
  }
  closeParagraph(); closeList();
  return output.join('');
}

export { escapeHtml };
