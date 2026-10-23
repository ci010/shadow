/** Ignore cached, hidden conversations without hiding collapsed rows or file tabs. */
export function activeWorkspaceScript(source: string): string {
  return `
    window.fixtureActiveDocument ??= {
      querySelectorAll(selector) {
        return Array.from(document.querySelectorAll(selector)).filter(element => {
          const workspace = element.closest('.project-conversation');
          return !workspace || getComputedStyle(workspace).display !== 'none';
        });
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    };
    ${source.replaceAll('document.querySelector', 'window.fixtureActiveDocument.querySelector')}
  `
}
