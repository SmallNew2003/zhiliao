/**
 * Render the install icons of the Web application from the official
 * application tile.
 *
 * A browser installs a Web App only with a raster 192px and a 512px icon, masks
 * the icon it puts on the home screen, and has no manifest support for iOS,
 * which reads `apple-touch-icon` instead. The tile (`apps/desktop/resources/icon.svg`,
 * the artwork the desktop application ships) draws the 知了 mark — white strokes
 * with an orange dot — over a gradient that fills the canvas edge to edge, with
 * rounded corners the design owns. The mark reaches 0.379 of the tile edge from
 * the centre, inside the 0.4 radius a platform mask is guaranteed to show, so no
 * variant scales the artwork. The maskable variant only squares the tile's
 * rounded corners: a platform mask may crop past the tile's own rounding, and a
 * full-bleed background keeps every mask meeting the gradient rather than
 * transparency.
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

/** Vector source owned by the desktop application; 1024 units square, the tile filling it. */
export const TILE_SOURCE = fileURLToPath(new URL('../../desktop/resources/icon.svg', import.meta.url))

/** Directory the generated PNGs are committed to. */
export const ICON_OUTPUT_DIRECTORY = fileURLToPath(new URL('../public/', import.meta.url))

/** Tile edge in source units; the tile fills its canvas, and every render density is expressed against this edge. */
const TILE_EDGE = 1024

/** Density at which the source's own 1:1 scale renders. */
const SOURCE_DENSITY = 72

/** Samples per output pixel along each axis before reduction. */
const RENDER_SCALE = 4

/** Radius a platform mask is guaranteed to show, as a fraction of the icon edge. */
export const MASKABLE_SAFE_RADIUS_RATIO = 0.4

/** Root element of the source document, rewritten so the icon canvas is exactly the tile. */
const SOURCE_ROOT = /^<svg[^>]*>/u

/** The mark group inside the tile; the anchor a source is validated against and no transform rewrites. */
const TILE_ARTWORK_GROUP = '<g id="tray-glyph"'

/** The tile's gradient background; a maskable icon squares its corners. */
const TILE_BACKGROUND_RECT = '<rect width="1024" height="1024" rx="200" fill="url(#opt-g3-bg)"/>'

/** The tile's rim light along its border; squared together with the background. */
const TILE_RIM_RECT = '<rect x="1" y="1" width="1022" height="1022" rx="199" stroke="url(#rim-light)" stroke-width="2" fill="none"/>'

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

/** The 1:1 root every variant shares, at the tile's own square extent. */
function tileRoot(): string {
  return `<svg width="${String(TILE_EDGE)}" height="${String(TILE_EDGE)}"`
    + ` viewBox="0 0 ${String(TILE_EDGE)} ${String(TILE_EDGE)}"`
    + ' fill="none" xmlns="http://www.w3.org/2000/svg">'
}

/** Replace the source root so the icon canvas is exactly the tile. */
function reparent(source: string): string {
  const trimmed = source.trim()
  const root = SOURCE_ROOT.exec(trimmed)
  if (root === null) throw new Error('app icons: the tile source has no root element')
  if (!trimmed.includes(TILE_ARTWORK_GROUP)) throw new Error('app icons: the tile source has no mark group')
  return `${tileRoot()}${trimmed.slice(root[0].length)}`
}

/** Drop a rect's corner rounding, keeping every other attribute. */
function squared(rect: string): string {
  return rect.replace(/ rx="\d+"/u, '')
}

/**
 * Rewrite the tile source so the icon canvas is exactly the tile.
 * @param source - complete `icon.svg` document.
 * @returns an SVG document whose 1024-unit square is the tile as drawn.
 */
export function tileDocument(source: string): string {
  return reparent(source)
}

/**
 * Rewrite the tile source into a maskable icon. The mark already fits the
 * radius a platform mask is guaranteed to show, so the artwork keeps the
 * tile's own scale; the background loses its corner rounding so a mask meets
 * the gradient instead of the tile's transparent corners.
 * @param source - complete `icon.svg` document.
 * @returns an SVG document whose background bleeds to the full square.
 */
export function maskableDocument(source: string): string {
  const tile = reparent(source)
  if (!tile.includes(TILE_BACKGROUND_RECT) || !tile.includes(TILE_RIM_RECT)) {
    throw new Error('app icons: the tile source has no rounded background to square')
  }
  return tile
    .replace(TILE_BACKGROUND_RECT, squared(TILE_BACKGROUND_RECT))
    .replace(TILE_RIM_RECT, squared(TILE_RIM_RECT))
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
