// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'
import { parseGfmWithMath } from '../src/markdown/parse.ts'

afterEach(cleanup)

describe('multiline display dollars with attached TeX', () => {
  it('preserves a cases environment attached to both fences inside a list', () => {
    const text = String.raw`- **Scheme:**
  $$\begin{cases}
  a > 0: & U_j^{n+1} = (1-\sigma)U_j^n + \sigma U_{j-1}^n \\
  a < 0: & U_j^{n+1} = (1+\sigma)U_j^n - \sigma U_{j+1}^n
  \end{cases}$$
- Stability follows.`
    const { container } = render(<MarkdownText text={text} />)
    expect(container.querySelector('.katex-error')).toBeNull()
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1)
    expect(container.querySelector('annotation')?.textContent).toContain('\\begin{cases}')
    expect(container.querySelector('annotation')?.textContent).toContain('\\end{cases}')
    expect(container.querySelector('annotation')?.textContent).not.toContain('$$')
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.textContent).toContain('Stability follows.')
  })

  it.each([
    '$$\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}$$',
    '$$\n\\begin{pmatrix}1 & 2 \\\\ 3 & 4\\end{pmatrix}$$',
    '$$\\begin{matrix}\n1 & 2 \\\\\n3 & 4\n\\end{matrix}\n$$',
    '> $$\\begin{cases}\n> x & x > 0 \\\\\n> 0 & x = 0\n> \\end{cases}$$',
  ])('renders mixed-fence alignment without dropping content: %s', (text) => {
    const { container } = render(<MarkdownText text={text} />)
    expect(container.querySelector('.katex-error')).toBeNull()
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1)
    expect(container.querySelector('annotation')?.textContent).toContain('&')
    expect(container.querySelector('annotation')?.textContent).toContain('\\end{')
  })

  it('keeps standard and same-line displays separate from following prose and displays', () => {
    const text = '$$\nx^2\n$$\n\nBetween.\n\n$$y^2$$\n\nAfter.\n\n$$z\n+1$$\n\nLast.'
    const { container } = render(<MarkdownText text={text} />)
    expect(container.querySelectorAll('.katex-display')).toHaveLength(3)
    expect([...container.querySelectorAll('p')].map(node => node.textContent)).toEqual(['Between.', 'After.', 'Last.'])
    expect(container.querySelector('.katex-error')).toBeNull()
  })

  it('does not turn code, escaped dollars, or currency into math', () => {
    const text = '```tex\n$$\\begin{cases}\na&b\n\\end{cases}$$\n```\n\n`$$x\n+y$$`\n\n\\$\\$ literal. Price $20 and USD 30.'
    const { container } = render(<MarkdownText text={text} />)
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('$$\\begin{cases}')
    expect(container.textContent).toContain('Price $20')
  })

  it('retains real errors for invalid TeX and the source in the AST', () => {
    const text = '$$\\frac{1\n+y$$'
    const { container } = render(<MarkdownText text={text} />)
    expect(container.querySelector('.katex-error')).not.toBeNull()
    expect(parseGfmWithMath(text).children[0]).toMatchObject({ type: 'math', value: '\\frac{1\n+y' })
  })
})
