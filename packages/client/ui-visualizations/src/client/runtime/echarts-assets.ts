/** Lazy, self-contained classic ECharts browser build. */
import script from 'echarts/dist/echarts.min.js?raw'

/** Frozen source bytes executed only inside the authored document. */
export const assets = Object.freeze({ css: Object.freeze([] as string[]), scripts: Object.freeze([script]) })
