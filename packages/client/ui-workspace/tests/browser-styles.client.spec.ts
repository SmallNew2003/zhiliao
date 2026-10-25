/**
 * WorkspaceBrowser spacing contract, asserted against the CSS text on disk:
 * row fills share the shell's trailing inset, the stable scrollbar counts
 * inside it, and flat, grouped, and search views keep their intended rhythm.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/rows/WorkspaceBrowser.module.css', import.meta.url)), 'utf8')
const rowsCss = readFileSync(fileURLToPath(new URL('../src/client/rows/Rows.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one selector rule, keyed by property with whitespace collapsed.
 * Declaration order and trailing semicolons are normalized away.
 * @param selector - one exact selector, including a leading dot for local classes.
 * @returns the rule's declarations, or undefined when no such rule exists.
 */
function declarationsFrom(source: string, selector: string): Map<string, string> | undefined {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const found = new Map<string, string>()
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
  }
  return found.size === 0 ? undefined : found
}

const declarations = (selector: string): Map<string, string> | undefined => declarationsFrom(css, selector)
const rowDeclarations = (selector: string): Map<string, string> | undefined => declarationsFrom(rowsCss, selector)

describe('WorkspaceBrowser.module.css list', () => {
  const root = declarations('.root')
  const listArea = declarations('.listArea')
  const list = declarations('.list')

  it('is the scrolling region', () => {
    expect(list).toBeDefined()
    expect(list!.get('overflow-y')).toBe('auto')
  })

  it('counts the themed scrollbar inside the shell trailing inset', () => {
    expect(root?.get('--dsh-session-list-edge-inset')).toBe('var(--dsh-sidebar-inline-padding)')
    expect(root?.get('--dsh-session-list-scrollbar-width')).toBe('8px')
    expect(root?.get('--dsh-session-list-scrollbar-offset')).toBe('2px')
    expect(root?.get('padding-right')).toBe('var(--dsh-session-list-edge-inset)')
    expect(listArea?.get('margin-left')).toBe('-4px')
    expect(listArea?.get('padding-left')).toBe('4px')
    expect(listArea?.get('margin-right')).toBe('calc(-1 * var(--dsh-session-list-edge-inset))')
    expect(declarations('.fade')?.get('right')).toBe('var(--dsh-session-list-edge-inset)')
    expect(list?.get('margin-right')).toBe('var(--dsh-session-list-scrollbar-offset)')
    expect(list?.get('margin-left')).toBe('-4px')
    expect(list?.get('padding-left')).toBe('4px')
    expect(list?.get('padding-right')).toBe([
      'calc(',
      'var(--dsh-session-list-edge-inset)',
      '- var(--dsh-session-list-scrollbar-width)',
      '- var(--dsh-session-list-scrollbar-offset)',
      ')',
    ].join(' '))
    expect(declarations('.list::-webkit-scrollbar')).toBeUndefined()
  })

  it('reserves the scrollbar whether or not the list overflows', () => {
    expect(list!.get('scrollbar-gutter')).toBe('stable')
  })

  it('keeps 2px between rows and 4px between workspace groups', () => {
    expect(declarations('.flatList > * + *')?.get('margin-top')).toBe('2px')
    expect(declarations(".searchTree > [role='treeitem'] + [role='treeitem']")?.get('margin-top')).toBe('2px')
    expect(declarations('.groupBodyInner > *')?.get('margin-top')).toBe('2px')
    expect(declarations('.groupSection + .groupSection')?.get('margin-top')).toBe('4px')
  })

  it('animates group bodies through a 0fr->1fr grid track with a delayed visibility hide', () => {
    expect(declarations('.groupBody')?.get('display')).toBe('grid')
    expect(declarations('.groupBody')?.get('grid-template-rows')).toBe('0fr')
    expect(declarations('.groupBodyOpen')?.get('grid-template-rows')).toBe('1fr')
    // The base transition is asserted on the raw text: this helper merges
    // same-selector rules across media queries, so the reduce override
    // (`transition: none`) would mask it in the declaration map.
    expect(css).toContain('grid-template-rows var(--ds-transition-duration) var(--ds-ease-in-out)')
    const inner = declarations('.groupBodyInner')
    expect(inner?.get('min-height')).toBe('0')
    expect(inner?.get('overflow')).toBe('hidden')
    expect(inner?.get('visibility')).toBe('hidden')
    // Same media-merge caveat as the track transition above.
    expect(css).toContain('visibility 0s linear var(--ds-transition-duration)')
    expect(declarations('.groupBodyOpen .groupBodyInner')?.get('visibility')).toBe('visible')
    expect(declarations('.groupBodyInnerFree')?.get('overflow')).toBe('visible')
  })

  it('draws drag targets as a leading chevron joined to the insertion line', () => {
    const listTopMarker = declarations('.listTopDropIndicator')
    const workspaceMarker = declarations('.workspaceDropBefore::before')
    const sessionMarker = rowDeclarations('.sessionRow.dropBefore::before')
    expect(listTopMarker?.get('top')).toBe('-8px')
    expect(listTopMarker?.get('left')).toBe('0')
    expect(workspaceMarker?.get('left')).toBe('0')
    expect(sessionMarker?.get('left')).toBe('0')
    for (const marker of [listTopMarker, workspaceMarker, sessionMarker]) {
      expect(marker?.get('height')).toBe('12px')
      expect(marker?.get('background')).not.toContain('radial-gradient')
      expect(marker?.get('background')).toContain('55deg')
      expect(marker?.get('background')).toContain('125deg')
      expect(marker?.get('background')).toContain('calc(50% - 1px) calc(50% + 1px)')
      expect(marker?.get('background')).toContain('0 0 / 5px 7px')
      expect(marker?.get('background')).toContain('0 5px / 5px 7px')
      expect(marker?.get('background')).toContain('4px 5px / calc(100% - 4px) 2px')
    }
  })

  it('keeps the compact fade, overflow control, search field, and row heights', () => {
    expect(declarations('.fade')?.get('height')).toBe('24px')
    expect(declarations('.sessionOverflowButton')?.get('height')).toBe('28px')
    expect(declarations('.searchExpanded')?.get('height')).toBe('30px')
    expect(rowDeclarations('.projectRow')?.get('height')).toBe('34px')
    expect(rowDeclarations('.sessionRow')?.get('height')).toBe('32px')
    expect(rowDeclarations('.flatSessionRowWithoutStatus .title')?.get('margin-left')).toBe('0')
    expect(rowDeclarations('.searchResultRow')?.get('min-height')).toBe('48px')
    expect(rowDeclarations('.sessionRow.selected')?.get('background'))
      .toBe('var(--dsw-alias-interactive-bg-hover)')
  })

  it('reveals a clipped session title by scrolling it on row hover', () => {
    // Smooth versus reduced motion is pinned as a computed style in
    // apps/web/tests/sidebar-title-hover-scroll.e2e.ts: this helper merges
    // same-selector rules across media queries, so the reduce override would
    // mask the smooth declaration here.
    expect(rowDeclarations('.sessionRow .title')?.get('flex')).toBe('1')
    expect(rowDeclarations('.sessionRow:hover .title')?.get('text-overflow')).toBe('clip')
  })

  it('distinguishes the selected row with a leading brand bar beside the shared hover fill', () => {
    const bar = rowDeclarations('.selectedBar')
    expect(bar?.get('left')).toBe('0')
    expect(bar?.get('width')).toBe('3px')
    expect(bar?.get('background')).toBe('var(--dsw-alias-state-business-primary)')
    expect(bar?.get('pointer-events')).toBe('none')
  })

  it('cross-fades the folder into the expand chevron in the project leading slot', () => {
    expect(rowDeclarations('.lead')?.get('position')).toBe('relative')
    expect(rowDeclarations('.leadIcon')?.get('position')).toBe('absolute')
    expect(rowDeclarations('.chevron')?.get('opacity')).toBe('0')
    expect(rowDeclarations('.projectRow:hover .chevron')?.get('opacity')).toBe('1')
    expect(rowDeclarations('.projectRow:hover .folder')?.get('opacity')).toBe('0')
  })

  it('fades the trailing action overlay in over the seated timestamp', () => {
    const actions = rowDeclarations('.rowActions')
    expect(actions?.get('position')).toBe('absolute')
    expect(actions?.get('opacity')).toBe('0')
    expect(actions?.get('visibility')).toBe('hidden')
    expect(rowDeclarations('.sessionRow:hover .time')?.get('opacity')).toBe('0')
    expect(rowDeclarations('.sessionRow:hover .time')?.get('display')).toBeUndefined()
    expect(rowDeclarations('.iconButton')?.get('width')).toBe('20px')
    expect(rowDeclarations('.iconButton:hover')?.get('background'))
      .toBe('var(--dsw-alias-interactive-bg-hover)')
  })

  it('rotates the overflow chevron with its aria-expanded state and fills on hover', () => {
    expect(declarations(".sessionOverflowButton[aria-expanded='true'] .overflowChevron")?.get('transform'))
      .toBe('rotate(180deg)')
    expect(declarations('.sessionOverflowButton:hover')?.get('background'))
      .toBe('var(--dsw-alias-interactive-bg-hover)')
  })

  it('pins both rail controls to the shared left anchor during the column slide', () => {
    expect(declarations('.rail .sectionHeader')?.get('justify-content')).toBe('flex-start')
    expect(declarations('.rail .iconButton')?.get('width')).toBe('36px')
    expect(declarations('.rail .search')?.get('width')).toBe('36px')
  })
})
