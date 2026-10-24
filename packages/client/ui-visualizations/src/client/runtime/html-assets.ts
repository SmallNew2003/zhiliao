/** Lazy, self-contained Bootstrap styling and bundled Popper/control code. */
import css from 'bootstrap/dist/css/bootstrap.min.css?raw'
import script from 'bootstrap/dist/js/bootstrap.bundle.min.js?raw'

/** Frozen source bytes; no library code runs in the application document. */
export const assets = Object.freeze({ css: Object.freeze([css]), scripts: Object.freeze([script]) })
