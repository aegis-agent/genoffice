/**
 * Safe Markdown link rendering for AI chat bubbles.
 * Only absolute http(s) hrefs become anchors; everything else stays inert text.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, safeMarkdownHref } from '../src/Markdown'

function html(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text }))
}

describe('safeMarkdownHref', () => {
  it('allows absolute http and https only', () => {
    expect(safeMarkdownHref('https://example.com/a?b=c')).toBe('https://example.com/a?b=c')
    expect(safeMarkdownHref('http://example.com')).toBe('http://example.com')
  })

  it('rejects dangerous, relative, file, and mailto hrefs', () => {
    expect(safeMarkdownHref('javascript:alert(1)')).toBeNull()
    expect(safeMarkdownHref('file:///etc/passwd')).toBeNull()
    expect(safeMarkdownHref('data:text/html,hi')).toBeNull()
    expect(safeMarkdownHref('smb://server/share')).toBeNull()
    expect(safeMarkdownHref('mailto:a@b.com')).toBeNull()
    expect(safeMarkdownHref('/relative/path')).toBeNull()
    expect(safeMarkdownHref('../escape')).toBeNull()
    expect(safeMarkdownHref('C:\\\\Users\\\\x')).toBeNull()
    expect(safeMarkdownHref('/Users/x/file')).toBeNull()
    expect(safeMarkdownHref('//evil.example/path')).toBeNull()
    expect(safeMarkdownHref('not a url')).toBeNull()
    expect(safeMarkdownHref('')).toBeNull()
  })
})

describe('Markdown http(s) links', () => {
  it('renders [label](url) as anchors in paragraphs, headings, and lists', () => {
    const p = html('See [Example](https://example.com/path) please')
    expect(p).toContain(
      '<a href="https://example.com/path" target="_blank" rel="noopener noreferrer">Example</a>',
    )
    expect(p).toContain('<p>')

    const h = html('## Read [Docs](http://docs.example)')
    expect(h).toContain('ai-md-h')
    expect(h).toContain(
      '<a href="http://docs.example" target="_blank" rel="noopener noreferrer">Docs</a>',
    )

    const ul = html('- [Item](https://example.com/item)\n- plain')
    expect(ul).toContain('<ul>')
    expect(ul).toContain(
      '<a href="https://example.com/item" target="_blank" rel="noopener noreferrer">Item</a>',
    )

    const ol = html('1. [First](https://example.com/1)')
    expect(ol).toContain('<ol>')
    expect(ol).toContain(
      '<a href="https://example.com/1" target="_blank" rel="noopener noreferrer">First</a>',
    )
  })

  it('keeps dangerous and relative markdown links as inert text (no anchor)', () => {
    const cases = [
      '[x](javascript:alert(1))',
      '[x](file:///etc/passwd)',
      '[x](data:text/html,hi)',
      '[x](smb://server/share)',
      '[x](mailto:a@b.com)',
      '[x](/relative)',
      '[x](../escape)',
      '[x](C:\\\\Users\\\\x)',
      '[x](/Users/x/file)',
      '[x](//evil.example)',
    ]
    for (const text of cases) {
      const out = html(text)
      expect(out, text).not.toContain('<a ')
      expect(out, text).toContain('[x](')
    }
  })

  it('handles nested bold/code around links and streaming partials', () => {
    const boldAround = html('**go [here](https://example.com/b)**')
    expect(boldAround).toContain('<strong>')
    expect(boldAround).toContain(
      '<a href="https://example.com/b" target="_blank" rel="noopener noreferrer">here</a>',
    )

    const boldLabel = html('see [**bold**](https://example.com/l) ok')
    expect(boldLabel).toContain(
      '<a href="https://example.com/l" target="_blank" rel="noopener noreferrer"><strong>bold</strong></a>',
    )

    const codeShield = html('use `[no](https://example.com)` literal')
    expect(codeShield).toContain('<code>[no](https://example.com)</code>')
    expect(codeShield).not.toContain('<a ')

    const adjacent = html('a [l](https://example.com/a) and **b**')
    expect(adjacent).toContain(
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">l</a>',
    )
    expect(adjacent).toContain('<strong>b</strong>')

    // Partial / streaming tokens stay plain text (no half-open anchors).
    expect(html('see [label](https://ex')).not.toContain('<a ')
    expect(html('see [label](https://ex')).toContain('[label](https://ex')
    expect(html('see [label](')).not.toContain('<a ')
    expect(html('see [lab')).not.toContain('<a ')
  })

  it('never uses dangerouslySetInnerHTML', () => {
    // Structural guarantee: renderer builds React elements only.
    expect(html('[t](https://example.com)<script>alert(1)</script>')).not.toContain(
      'dangerouslySetInnerHTML',
    )
    expect(html('[t](https://example.com)<script>alert(1)</script>')).toContain('&lt;script&gt;')
  })
})
