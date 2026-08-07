import { Fragment, type ReactNode } from 'react'

/**
 * Minimal dependency-free markdown for chat bubbles: paragraphs, ul/ol,
 * headings, **bold**, *italic*, `inline code`, and `[label](url)` links.
 * Tolerates partial (streaming) input — anything unrecognized renders as plain text.
 *
 * Link safety: only absolute http:/https: URLs become anchors. javascript:,
 * file:, data:, relative paths, mailto:, etc. stay inert text. Anchors always
 * use target=_blank and rel=noopener noreferrer. No dangerouslySetInnerHTML.
 */

/** Returns href when it is a well-formed absolute http(s) URL; otherwise null. */
export function safeMarkdownHref(href: string): string | null {
  if (typeof href !== 'string') return null
  const trimmed = href.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  // new URL('//host/path') resolves against a base in browsers but throws in
  // Node without a base — still reject protocol-relative if it ever parses.
  if (trimmed.startsWith('//')) return null
  return trimmed
}

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  let key = 0

  const pushText = (s: string): void => {
    if (s) out.push(s)
  }

  while (i < text.length) {
    const ch = text[i]

    // `inline code`
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end !== -1 && !text.slice(i + 1, end).includes('\n')) {
        out.push(<code key={key++}>{text.slice(i + 1, end)}</code>)
        i = end + 1
        continue
      }
    }

    // [label](url) — only complete tokens; partial streaming stays text
    if (ch === '[') {
      const closeLabel = text.indexOf(']', i + 1)
      if (
        closeLabel !== -1 &&
        text[closeLabel + 1] === '(' &&
        !text.slice(i + 1, closeLabel).includes('\n')
      ) {
        const closeUrl = text.indexOf(')', closeLabel + 2)
        if (closeUrl !== -1 && !text.slice(closeLabel + 2, closeUrl).includes('\n')) {
          const label = text.slice(i + 1, closeLabel)
          const url = text.slice(closeLabel + 2, closeUrl)
          if (!/\s/.test(url)) {
            const href = safeMarkdownHref(url)
            if (href) {
              out.push(
                <a key={key++} href={href} target="_blank" rel="noopener noreferrer">
                  {renderInline(label)}
                </a>,
              )
            } else {
              // Inert: keep the raw markdown text so users can still read it.
              pushText(text.slice(i, closeUrl + 1))
            }
            i = closeUrl + 1
            continue
          }
        }
      }
    }

    // **bold**
    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2)
      if (end !== -1 && !text.slice(i + 2, end).includes('\n')) {
        out.push(<strong key={key++}>{renderInline(text.slice(i + 2, end))}</strong>)
        i = end + 2
        continue
      }
    }

    // *italic*
    if (ch === '*') {
      const end = text.indexOf('*', i + 1)
      if (end !== -1 && !text.slice(i + 1, end).includes('\n')) {
        out.push(<em key={key++}>{renderInline(text.slice(i + 1, end))}</em>)
        i = end + 1
        continue
      }
    }

    // plain run until next special char
    let j = i + 1
    while (j < text.length) {
      const c = text[j]
      if (c === '`' || c === '[' || c === '*') break
      j++
    }
    pushText(text.slice(i, j))
    i = j
  }

  return out
}

type MdBlock =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'h'; text: string }

function parseBlocks(text: string): MdBlock[] {
  const blocks: MdBlock[] = []
  let cur: MdBlock | null = null
  const flush = (): void => {
    if (cur) {
      blocks.push(cur)
      cur = null
    }
  }
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flush()
      continue
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      flush()
      blocks.push({ kind: 'h', text: h[1] ?? '' })
      continue
    }
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line)
    if (ul) {
      if (cur?.kind !== 'ul') {
        flush()
        cur = { kind: 'ul', items: [] }
      }
      cur.items.push(ul[1] ?? '')
      continue
    }
    const ol = /^\s*\d+[.、)]\s+(.*)$/.exec(line)
    if (ol) {
      if (cur?.kind !== 'ol') {
        flush()
        cur = { kind: 'ol', items: [] }
      }
      cur.items.push(ol[1] ?? '')
      continue
    }
    if (cur?.kind !== 'p') {
      flush()
      cur = { kind: 'p', lines: [] }
    }
    cur.lines.push(line)
  }
  flush()
  return blocks
}

export function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="ai-md">
      {parseBlocks(text).map((b, i) => {
        if (b.kind === 'h') {
          return (
            <p key={i} className="ai-md-h">
              {renderInline(b.text)}
            </p>
          )
        }
        if (b.kind === 'ul' || b.kind === 'ol') {
          const items = b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)
          return b.kind === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>
        }
        return (
          <p key={i}>
            {b.lines.map((ln, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {renderInline(ln)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
