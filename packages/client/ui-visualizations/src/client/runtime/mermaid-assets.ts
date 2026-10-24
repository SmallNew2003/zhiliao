/** Lazy standalone Mermaid build with its embedded diagram renderers. */
import script from 'mermaid/dist/mermaid.min.js?raw'

/** Frozen source bytes executed only inside the opaque document. */
export const assets = Object.freeze({ css: Object.freeze([] as string[]), scripts: Object.freeze([script]) })
