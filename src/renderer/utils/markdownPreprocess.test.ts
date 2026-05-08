import { describe, expect, test } from 'vitest';

import { preprocessMarkdownContent } from './markdownPreprocess';

describe('preprocessMarkdownContent', () => {
  test('keeps C# language names inline instead of rewriting them as headings', () => {
    const input = '补充一下是： C# WPF + WebView2 架构';

    expect(preprocessMarkdownContent(input)).toBe(input);
  });

  test('keeps F# language names inline instead of rewriting them as headings', () => {
    const input = 'Use F# for this example';

    expect(preprocessMarkdownContent(input)).toBe(input);
  });

  test('still separates headings when marker is not attached to a word token', () => {
    expect(preprocessMarkdownContent('结果：# 标题')).toBe('结果：\n\n# 标题');
  });

  // Issue #167 — Chinese-tuned models (DeepSeek, MiniMax, …) emit full-width
  // punctuation U+FF0A `＊` in place of ASCII `*`, so bold rendered as literal
  // ＊＊P1＊＊ instead of <strong>P1</strong>. Normalize paired patterns only.
  describe('full-width markdown markers (issue #167)', () => {
    test('converts paired full-width asterisks to ASCII bold', () => {
      expect(preprocessMarkdownContent('看 ＊＊P1＊＊ 这里')).toBe('看 **P1** 这里');
    });

    test('converts paired full-width asterisks for italic', () => {
      expect(preprocessMarkdownContent('看 ＊P1＊ 这里')).toBe('看 *P1* 这里');
    });

    test('converts full-width underscore bold', () => {
      expect(preprocessMarkdownContent('see ＿＿bold＿＿ here')).toBe('see __bold__ here');
    });

    test('converts full-width tilde strikethrough', () => {
      expect(preprocessMarkdownContent('～～gone～～')).toBe('~~gone~~');
    });

    test('handles multiple bold patterns inline (table-row style)', () => {
      const input = '| ＊＊P1＊＊ | 框架 | ＊＊P2＊＊ | 鸟瞰 |';
      const expected = '| **P1** | 框架 | **P2** | 鸟瞰 |';
      expect(preprocessMarkdownContent(input)).toBe(expected);
    });

    test('leaves unpaired full-width asterisks alone (legitimate text)', () => {
      // A name with a single ＊ for redaction should not be mangled
      expect(preprocessMarkdownContent('张＊三')).toBe('张＊三');
    });

    test('does not convert inside protected code blocks', () => {
      const input = '```\n＊＊not bold＊＊\n```';
      expect(preprocessMarkdownContent(input)).toBe(input);
    });

    test('does not convert inside protected inline code', () => {
      const input = '`＊＊not bold＊＊`';
      expect(preprocessMarkdownContent(input)).toBe(input);
    });
  });
});
