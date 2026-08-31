// SPDX-License-Identifier: MPL-2.0
interface CodeMirrorEditor {
  focus(): void;
  getTextArea(): HTMLTextAreaElement;
  operation(callback: () => void): void;
  replaceSelection(text: string, collapse?: 'around' | 'start' | 'end', origin?: string): void;
}

type CodeMirrorElement = HTMLElement & { CodeMirror?: CodeMirrorEditor };

export function insertAtEditorSelection(text: string): 'codemirror' | 'textarea' {
  const textarea = document.querySelector<HTMLTextAreaElement>('#wpTextbox1');
  if (!textarea) throw new Error('未找到维基文本编辑器');

  const codeMirror = [...document.querySelectorAll<CodeMirrorElement>('.CodeMirror')]
    .map((element) => element.CodeMirror)
    .find((editor) => editor?.getTextArea() === textarea);
  if (codeMirror) {
    codeMirror.operation(() => codeMirror.replaceSelection(text, 'end', '+input'));
    codeMirror.focus();
    return 'codemirror';
  }

  textarea.focus();
  const insertedWithUndo = document.execCommand?.('insertText', false, text) ?? false;
  if (!insertedWithUndo) {
    textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  return 'textarea';
}

export function wikiLink(title: string, query: string, namespace?: number): string {
  const label = query.trim();
  const target = namespace === 6 || namespace === 14 ? `:${title.replace(/^:/, '')}` : title;
  if (!label || label.toLocaleLowerCase() === title.toLocaleLowerCase()) {
    return `[[${target}]]`;
  }
  return `[[${target}|${label}]]`;
}
