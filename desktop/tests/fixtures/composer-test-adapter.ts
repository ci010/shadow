/** Test-only DOM adapter for smoke fixtures that previously drove a textarea.
 * Selectors must explicitly target .reference-composer. Real DOM identity, focus,
 * selection, input events and disabled state remain observable; no Vue state or
 * production component methods are patched. Dedicated question textareas are untouched.
 * Install before each evaluation so newly mounted split/session composers work too.
 */
export function withComposerTestAdapter(script: string): string {
  return `(() => {
    const text = node => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      if (!(node instanceof Element)) return '';
      if (node.hasAttribute('data-reference')) return node.getAttribute('data-reference');
      if (node.tagName === 'BR') return '\\n';
      return Array.from(node.childNodes, text).join('');
    };
    const offset = (root, node, count) => {
      if (root === node) return node.nodeType === Node.TEXT_NODE ? count : Array.from(node.childNodes).slice(0, count).reduce((sum, child) => sum + text(child).length, 0);
      let total = 0;
      for (const child of root.childNodes) {
        if (child === node || child.contains(node)) return total + offset(child, node, count);
        total += text(child).length;
      }
      return total;
    };
    const point = (root, position) => {
      let remaining = Math.max(0, position);
      for (const child of root.childNodes) {
        const length = text(child).length;
        if (child instanceof Element && (child.hasAttribute('data-reference') || child.tagName === 'BR')) {
          if (remaining < length) return [root, Array.from(root.childNodes).indexOf(child) + (remaining > length / 2 ? 1 : 0)];
        } else if (remaining <= length) {
          return child.nodeType === Node.TEXT_NODE ? [child, remaining] : point(child, remaining);
        }
        remaining -= length;
      }
      return [root, root.childNodes.length];
    };
    for (const input of document.querySelectorAll('.reference-composer')) {
      if (Object.hasOwn(input, 'value')) continue;
      const selection = () => {
        const s = getSelection();
        if (!s?.anchorNode || !s.focusNode || !input.contains(s.anchorNode) || !input.contains(s.focusNode)) return [0, 0];
        const a = offset(input, s.anchorNode, s.anchorOffset), b = offset(input, s.focusNode, s.focusOffset);
        return [Math.min(a, b), Math.max(a, b)];
      };
      Object.defineProperties(input, {
        value: { get: () => text(input), set: value => { input.textContent = value; } },
        disabled: { get: () => input.getAttribute('aria-disabled') === 'true' },
        readOnly: { get: () => false },
        selectionStart: { get: () => selection()[0] },
        selectionEnd: { get: () => selection()[1] },
        setSelectionRange: { value: (start, end) => {
          const range = document.createRange(); range.setStart(...point(input, start)); range.setEnd(...point(input, end));
          const s = getSelection(); s.removeAllRanges(); s.addRange(range);
        } },
      });
    }
  })();\n${script}`
}
