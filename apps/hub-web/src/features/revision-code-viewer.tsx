import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { CodeRevision } from '../api/types';
import { Button, Notice } from '../components/ui';
import { decodeRevisionFile } from './context-model';
import './revision-code-viewer.css';

const highlighter = hljs.newInstance();
const languages = { bash, css, diff, javascript, json, markdown, python, typescript, xml, yaml };
for (const [name, grammar] of Object.entries(languages)) highlighter.registerLanguage(name, grammar);

const extensions: Record<string, keyof typeof languages> = {
  sh: 'bash', bash: 'bash', css: 'css', patch: 'diff', diff: 'diff',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', py: 'python',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  html: 'xml', xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml',
};

type Fragment = { text: string; className?: string };
const maxLines = 4000;

function codeLines(source: string, language?: string): Fragment[][] {
  const plain = () => source.split('\n').map(text => [{ text }]);
  if (!language) return plain();
  try {
    const html = highlighter.highlight(source, { language, ignoreIllegals: true }).value;
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const lines: Fragment[][] = [[]];
    // Render only React text and highlighting classes, with line breaks outside token spans.
    function collect(node: Node, className?: string) {
      if (node.nodeType === Node.TEXT_NODE) {
        const parts = (node.textContent ?? '').split('\n');
        parts.forEach((text, index) => {
          if (index > 0) lines.push([]);
          if (text) lines.at(-1)?.push({ text, className });
        });
      } else if (node instanceof Element) {
        const classes = [className, node.getAttribute('class')].filter(Boolean).join(' ');
        node.childNodes.forEach(child => collect(child, classes));
      }
    }
    collect(parsed.body);
    return lines;
  } catch {
    return plain();
  }
}

export function RevisionCodeViewer({
  file,
  preview,
}: {
  file: CodeRevision['files'][number];
  preview: Extract<ReturnType<typeof decodeRevisionFile>, { kind: 'text' }>;
}) {
  const { t } = useTranslation('context');
  const [wrap, setWrap] = useState(true);
  const [copyStatus, setCopyStatus] = useState<'success' | 'error'>();
  const extension = file.path.split('.').at(-1)?.toLowerCase() ?? '';
  const language = Object.hasOwn(extensions, extension) ? extensions[extension] : undefined;
  const { lines, lineLimitReached } = useMemo(() => {
    const split = preview.text.replace(/\r\n?/g, '\n').split('\n', maxLines + 1);
    return {
      lines: codeLines(split.slice(0, maxLines).join('\n'), language),
      lineLimitReached: split.length > maxLines,
    };
  }, [preview.text, language]);

  async function copySource() {
    try {
      const source = preview.truncated ? decodeRevisionFile(file.contentBase64, Infinity) : preview;
      if (source.kind !== 'text') throw new Error('File cannot be decoded as text');
      await navigator.clipboard.writeText(source.text);
      setCopyStatus('success');
    } catch {
      setCopyStatus('error');
    }
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => void copySource()}>{t('copyCode')}</Button>
        <Button variant={wrap ? 'primary' : 'secondary'} aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
          {t('wrapLines')}
        </Button>
      </div>
      <span role="status" className="text-xs text-slate-500">
        {copyStatus && t(copyStatus === 'success' ? 'codeCopied' : 'codeCopyFailed')}
      </span>
      {preview.truncated && <Notice>{t('truncated')}</Notice>}
      {lineLimitReached && <Notice>{t('codeLineLimit', { count: maxLines })}</Notice>}
      <div className="revision-code" data-wrap={wrap} role="region" aria-label={file.path} tabIndex={0}>
        <code>
          {lines.map((line, index) => (
            <span className="revision-code-line" key={index}>
              <span aria-hidden="true" className="revision-code-number">{index + 1}</span>
              <span className="revision-code-text">
                {line.map(({ text, className }, token) => <span className={className} key={token}>{text}</span>)}
              </span>
            </span>
          ))}
        </code>
      </div>
    </div>
  );
}
