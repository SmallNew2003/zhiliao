/** Committed install icon dimensions and the generator's SVG canvas and maskable background. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_ICON_VARIANTS, ICON_OUTPUT_DIRECTORY, TILE_SOURCE,
  maskableDocument, tileDocument,
} from '../scripts/render-app-icons.ts'
import { pngSize } from './png-size.ts'

describe('web install icons', () => {
  it('ships every declared variant at its declared edge', async () => {
    for (const variant of APP_ICON_VARIANTS) {
      expect(pngSize(await readFile(join(ICON_OUTPUT_DIRECTORY, variant.file))))
        .toEqual([variant.size, variant.size])
    }
  })

  it('keeps the tile artwork and squares only the maskable background', async () => {
    const source = await readFile(TILE_SOURCE, 'utf8')
    const tile = tileDocument(source)
    const maskable = maskableDocument(source)
    const artworkGroup = source.match(/<g id="tray-glyph"[^>]*>/u)![0]
    expect(tile).toContain('viewBox="0 0 1024 1024"')
    expect(tile).toContain(source.match(/<path\b[^>]*>/u)![0])
    expect(tile).toContain(source.match(/<defs>[\s\S]*<\/defs>/u)![0])
    // The tile ships the design as drawn; the maskable background drops the
    // corner rounding so a platform mask meets the gradient, not transparency.
    expect(tile).toContain(artworkGroup)
    expect(tile).toContain('rx="200"')
    expect(maskable).toContain(artworkGroup)
    expect(maskable).not.toMatch(/ rx="/u)
    expect(maskable).toContain('<rect width="1024" height="1024" fill="url(#opt-g3-bg)"/>')
    expect(maskable).toContain('<rect x="1" y="1" width="1022" height="1022" stroke="url(#rim-light)" stroke-width="2" fill="none"/>')
  })

  it('rejects non-PNG bytes and incomplete image headers', () => {
    expect(() => pngSize(Buffer.from('<svg/>'))).toThrow(/PNG IHDR/)
    expect(() => pngSize(Buffer.alloc(33))).toThrow(/PNG IHDR/)
  })

  it('fails loudly on a source without the tile it transforms', () => {
    expect(() => tileDocument('')).toThrow(/no root element/)
    expect(() => tileDocument('<svg></svg>')).toThrow(/no mark group/)
    expect(() => maskableDocument('<svg><g id="tray-glyph"></g></svg>'))
      .toThrow(/no rounded background/)
  })
})
