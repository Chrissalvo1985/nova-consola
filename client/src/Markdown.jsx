/**
 * Markdown ligero y seguro para burbujas del agente.
 * Soporta: headings, bold/italic, código inline/bloques, listas, links, hr, párrafos.
 * Sin deps externas; escapa HTML crudo.
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inlineFormat(text) {
  let s = escapeHtml(text)
  // code first so we don't format inside backticks
  s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="md-link">$1</a>')
  return s
}

function parseBlocks(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // fenced code
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim()
      i++
      const body = []
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // close fence
      blocks.push({ type: 'code', lang, content: body.join('\n') })
      continue
    }

    // hr
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    // heading
    const hm = line.match(/^(#{1,3})\s+(.+)$/)
    if (hm) {
      blocks.push({ type: 'heading', level: hm[1].length, content: hm[2] })
      i++
      continue
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
        i++
      }
      blocks.push({ type: 'ol', items })
      continue
    }

    // blank
    if (!line.trim()) {
      i++
      continue
    }

    // paragraph (merge consecutive non-empty non-special lines)
    const para = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    blocks.push({ type: 'p', content: para.join('\n') })
  }

  return blocks
}

export default function Markdown({ text }) {
  const blocks = parseBlocks(text)

  return (
    <div className="md">
      {blocks.map((b, idx) => {
        if (b.type === 'code') {
          return (
            <pre key={idx} className="md-pre">
              {b.lang ? <span className="md-lang">{b.lang}</span> : null}
              <code>{b.content}</code>
            </pre>
          )
        }
        if (b.type === 'hr') return <hr key={idx} className="md-hr" />
        if (b.type === 'heading') {
          const Tag = `h${b.level}`
          return (
            <Tag
              key={idx}
              className={`md-h md-h${b.level}`}
              dangerouslySetInnerHTML={{ __html: inlineFormat(b.content) }}
            />
          )
        }
        if (b.type === 'ul') {
          return (
            <ul key={idx} className="md-ul">
              {b.items.map((it, j) => (
                <li key={j} dangerouslySetInnerHTML={{ __html: inlineFormat(it) }} />
              ))}
            </ul>
          )
        }
        if (b.type === 'ol') {
          return (
            <ol key={idx} className="md-ol">
              {b.items.map((it, j) => (
                <li key={j} dangerouslySetInnerHTML={{ __html: inlineFormat(it) }} />
              ))}
            </ol>
          )
        }
        return (
          <p
            key={idx}
            className="md-p"
            dangerouslySetInnerHTML={{ __html: inlineFormat(b.content) }}
          />
        )
      })}
    </div>
  )
}
