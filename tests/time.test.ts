import { describe, expect, it } from 'vitest'
import { countWords, enforceSummaryLimit, formatTimestamp, normalizeChapters, normalizeEditorialChapters } from '../shared/time'

describe('time and output helpers', () => {
  it('formats timestamps as hh:mm:ss', () => {
    expect(formatTimestamp(0)).toBe('00:00:00')
    expect(formatTimestamp(65)).toBe('00:01:05')
    expect(formatTimestamp(3661.8)).toBe('01:01:01')
  })

  it('enforces the summary word limit', () => {
    const summary = Array.from({ length: 205 }, (_, index) => `word${index}`).join(' ')
    const limited = enforceSummaryLimit(summary, 200)

    expect(countWords(limited)).toBeLessThanOrEqual(200)
    expect(limited.endsWith('.')).toBe(true)
  })

  it('sorts and formats chapters', () => {
    expect(
      normalizeChapters([
        { startSeconds: 90, title: 'Second idea', summary: 'More detail.' },
        { startSeconds: 0, title: 'Opening', summary: null },
      ]),
    ).toEqual([
      { timestamp: '00:00:00', title: 'Opening' },
      { timestamp: '00:01:30', title: 'Second idea', summary: 'More detail.' },
    ])
  })

  it('normalizes editorial chapters as title-only show notes by default', () => {
    expect(
      normalizeEditorialChapters([
        { startSeconds: 372, title: ' Jury Selection Drama. ', summary: 'Potential jurors react to Musk.' },
      ]),
    ).toEqual([{ timestamp: '00:06:12', title: 'Jury Selection Drama' }])
  })
})
