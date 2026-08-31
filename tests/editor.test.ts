// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom

import { insertAtEditorSelection, wikiLink } from '../src/editor';

describe('editor integration', () => {
  beforeEach(() => {
    document.body.innerHTML = '<textarea id="wpTextbox1">前后</textarea>';
  });

  it('creates a display-labelled wiki link from the query', () => {
    expect(wikiLink('12号鹿弹', '鹿弹')).toBe('[[12号鹿弹|鹿弹]]');
    expect(wikiLink('12号鹿弹', '12号鹿弹')).toBe('[[12号鹿弹]]');
  });

  it('creates ordinary links for Category and File namespaces', () => {
    expect(wikiLink('分类:武器', '武器', 14)).toBe('[[:分类:武器|武器]]');
    expect(wikiLink('文件:Item morphine.png', 'morphine', 6)).toBe(
      '[[:文件:Item morphine.png|morphine]]',
    );
  });

  it('inserts into a native textarea selection', () => {
    const textarea = document.querySelector<HTMLTextAreaElement>('#wpTextbox1')!;
    textarea.setSelectionRange(1, 1);

    expect(insertAtEditorSelection('[[鹿弹]]')).toBe('textarea');
    expect(textarea.value).toBe('前[[鹿弹]]后');
  });

  it('uses the active CodeMirror instance so insertion is undoable', () => {
    const textarea = document.querySelector<HTMLTextAreaElement>('#wpTextbox1')!;
    const replaceSelection = vi.fn();
    const codeMirror = document.createElement('div') as HTMLDivElement & {
      CodeMirror: unknown;
    };
    codeMirror.className = 'CodeMirror';
    codeMirror.CodeMirror = {
      getTextArea: () => textarea,
      replaceSelection,
      focus: vi.fn(),
      operation: (callback: () => void) => callback(),
    };
    document.body.append(codeMirror);

    expect(insertAtEditorSelection('[[鹿弹]]')).toBe('codemirror');
    expect(replaceSelection).toHaveBeenCalledWith('[[鹿弹]]', 'end', '+input');
  });
});
