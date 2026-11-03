/**
 * Render the install icons of the Web application from the official
 * application tile.
 *
 * A browser installs a Web App only with a raster 192px and a 512px icon, masks
 * the icon it puts on the home screen, and has no manifest support for iOS,
 * which reads `apple-touch-icon` instead. The bare brand mark is drawn on a
 * transparent canvas, so handed to a launcher directly it would leave the
 * corners transparent. This script rasterizes the application tile
 * (`apps/desktop/resources/icon.svg`, the artwork the desktop application
 * ships) into the committed PNGs under `public/`. Every variant paints an
 * opaque backdrop behind the rounded tile, because a launcher expects a square
 * image; the maskable variant additionally scales the whole tile inside the
 * safe zone a platform mask may crop, so neither the gradient nor the mark
 * meets the mask.
 *
 * The committed PNGs are the output; rerun
 * `pnpm --filter @deepseek-ai/dsh-web-frontend run render:app-icons` after the
 * tile artwork changes.
 * @module render-app-icons
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** Vector source owned by the desktop application; the whole canvas is the tile. */
export const TILE_SOURCE = fileURLToPath(new URL('../../desktop/resources/icon.svg', import.meta.url))

/** Directory the generated PNGs are committed to. */
export const ICON_OUTPUT_DIRECTORY = fileURLToPath(new URL('../public/', import.meta.url))

/** Tile edge in source units; every render density is expressed against it. */
const TILE_EDGE = 1024

/** Tile centre in source units, the fixed point of the maskable scale. */
const TILE_CENTER = { x: TILE_EDGE / 2, y: TILE_EDGE / 2 } as const

/** Density at which the source's own 1:1 scale renders. */
const SOURCE_DENSITY = 72

/** Samples per output pixel along each axis before reduction. */
const RENDER_SCALE = 4

/**
 * Fraction of a maskable icon the tile keeps: the platform may crop the border
 * outside it. The rounded tile's ink reaches 0.431 of its edge from the centre,
 * so 0.82 shrinks the mark well inside a circular mask that shows the central
 * 0.8 of the icon; `pwa-manifest.e2e.ts` checks the rasterized scale.
 */
export const MASKABLE_ARTWORK_SCALE = 0.82

/** Root element of the source document, rewritten so the canvas is exactly the tile. */
const SOURCE_ROOT = /^<svg[^>]*>/u

/** Closing element of the source document. */
const SOURCE_CLOSE = /<\/svg>\s*$/u

/** Marker of the mark group, which proves the source is the application tile. */
const TILE_ARTWORK_MARKER = 'id="tray-glyph"'

/** Opaque backdrop behind the rounded tile; a launcher icon has no transparent corners. */
const TILE_BACKDROP = `<rect width="${String(TILE_EDGE)}" height="${String(TILE_EDGE)}" fill="#FFFFFF"/>`

/** One committed install icon: the manifest or link member it serves and its edge in pixels. */
export interface AppIconVariant {
  /** File name inside `public/`. */
  readonly file: string
  /** Square edge in pixels. */
  readonly size: number
  /** Which rendering the platform receives. */
  readonly kind: 'tile' | 'maskable'
}

/**
 * Install icons the Web application ships. Chrome requires the 192px and 512px
 * raster pair to offer installation, prefers a maskable icon for the home
 * screen, and iOS reads the touch icon alone.
 */
export const APP_ICON_VARIANTS: readonly AppIconVariant[] = [
  { file: 'icon-192.png', size: 192, kind: 'tile' },
  { file: 'icon-512.png', size: 512, kind: 'tile' },
  { file: 'icon-maskable-512.png', size: 512, kind: 'maskable' },
  { file: 'apple-touch-icon.png', size: 180, kind: 'tile' },
]

/** The cropped 1:1 root every variant shares, at the tile's own square extent. */
function croppedRoot(): string {
  return `<svg width="${String(TILE_EDGE)}" height="${String(TILE_EDGE)}"`
    + ` viewBox="0 0 ${String(TILE_EDGE)} ${String(TILE_EDGE)}"`
    + ' fill="none" xmlns="http://www.w3.org/2000/svg">'
}

/** A scale about the tile centre, so a masked crop stays symmetric. */
function aboutCenter(scale: number): string {
  return `translate(${String(TILE_CENTER.x)} ${String(TILE_CENTER.y)}) scale(${String(scale)})`
    + ` translate(${String(-TILE_CENTER.x)} ${String(-TILE_CENTER.y)})`
}

/** The source's drawing elements, without its root. */
function sourceBody(source: string): string {
  const trimmed = source.trim()
  const root = SOURCE_ROOT.exec(trimmed)
  if (root === null) throw new Error('app icons: the tile source has no root element')
  const close = SOURCE_CLOSE.exec(trimmed)
  if (close === null) throw new Error('app icons: the tile source has no closing element')
  if (!trimmed.includes(TILE_ARTWORK_MARKER)) throw new Error('app icons: the tile source has no artwork group')
  return trimmed.slice(root[0].length, close.index)
}

/** Compose the icon so the canvas is exactly the tile over an opaque backdrop. */
function assemble(body: string, artworkTransform?: string): string {
  const drawing = artworkTransform === undefined ? body : `<g transform="${artworkTransform}">${body}</g>`
  return `${croppedRoot()}${TILE_BACKDROP}${drawing}</svg>`
}

/**
 * Rewrite the tile source so the icon canvas is exactly the tile.
 * @param source - complete `icon.svg` document.
 * @returns an SVG document whose 1024-unit square is the tile with opaque corners.
 */
export function tileDocument(source: string): string {
  return assemble(sourceBody(source))
}

/**
 * Rewrite the tile source into a maskable icon. The tile keeps its own gradient
 * and extent, so the icon's border is the real tile rather than an extension;
 * the whole tile scales into the safe zone a platform mask may crop, leaving
 * neither a cropped mark nor a seam between the tile and the backdrop.
 * @param source - complete `icon.svg` document.
 * @returns an SVG document whose artwork survives a circular mask whole.
 */
export function maskableDocument(source: string): string {
  return assemble(sourceBody(source), aboutCenter(MASKABLE_ARTWORK_SCALE))
}

/**
 * Rasterize one rewritten document at a square edge.
 * @param document - output of {@link tileDocument} or {@link maskableDocument}.
 * @param size - square edge in pixels.
 * @returns the PNG bytes.
 */
async function renderPng(document: string, size: number): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  const renderSize = Math.max(TILE_EDGE, size * RENDER_SCALE)
  // A separate raster preserves the source's filters at full resolution and
  // prevents SVG resize optimizations from bypassing the downsampling step.
  const raster = await sharp(Buffer.from(document), { density: SOURCE_DENSITY * renderSize / TILE_EDGE })
    .png()
    .toBuffer()
  return sharp(raster)
    .resize(size, size, { kernel: 'lanczos3' })
    .png()
    .toBuffer()
}

function documentForVariant(source: string, kind: AppIconVariant['kind']): string {
  switch (kind) {
    case 'tile': return tileDocument(source)
    case 'maskable': return maskableDocument(source)
    default: return assertNever(kind)
  }
}

/**
 * Render every install icon from the tile source.
 * @param source - complete `icon.svg` document.
 * @returns one PNG per {@link APP_ICON_VARIANTS} entry, in declaration order.
 */
export async function renderAppIcons(source: string): Promise<readonly { variant: AppIconVariant; png: Buffer }[]> {
  return Promise.all(APP_ICON_VARIANTS.map(async variant => ({
    variant,
    png: await renderPng(
      documentForVariant(source, variant.kind),
      variant.size,
    ),
  })))
}

async function main(): Promise<void> {
  const icons = await renderAppIcons(await readFile(TILE_SOURCE, 'utf8'))
  await Promise.all(icons.map(async ({ variant, png }) => {
    await writeFile(resolve(ICON_OUTPUT_DIRECTORY, variant.file), png)
  }))
  console.info(`app icons: wrote ${icons.map(icon => icon.variant.file).join(', ')} to ${ICON_OUTPUT_DIRECTORY}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
