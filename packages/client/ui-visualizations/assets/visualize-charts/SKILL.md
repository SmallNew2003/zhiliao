---
name: visualize-charts
description: Create inline ECharts data charts in assistant replies, including interactive comparisons and PNG export through dsh.chart.
---

# Inline charts

Use a chart to explain quantitative comparisons, trends or distributions. Choose axes, units, labels and a chart type that match the supplied data; do not invent measurements. For publication-ready scientific figures or other export formats, create a separate file artifact.

Emit a top-level assistant fence opened with `html preview runtime={{runtime}} libs=echarts` and explicitly close it. Ordinary, nested or unclosed fences do not execute. Include all data inline; remote resources, fetch, package installation, external module imports, workers, filesystem access, parent DOM and Host operations are unavailable. Author plain HTML, CSS and JavaScript, without JSX.

The document supplies Bootstrap {{bootstrap}} CSS and native `bootstrap`, plus ECharts {{echarts}} as native `echarts`. Mermaid {{mermaid}} belongs in a separate `mermaid preview runtime={{runtime}}` fence using visualize-diagrams. Use responsive Bootstrap panels and give each chart container an explicit height and available width.

Call `dsh.chart(element, option)` to create an exportable chart. The immutable helper applies theme colors, typography, spacing, axes and tooltip defaults, then your explicit ECharts options override those defaults. It returns the native ECharts instance for ordinary chart APIs and owns resize and disposal. Theme changes retain the instance and interactions. Native `echarts.init` is available, but charts created directly have no viewer PNG export. Use ECharts option objects and inline datasets rather than loading libraries yourself.

```html preview runtime={{runtime}} libs=echarts
<!doctype html>
<html><head><title>Quarterly sales</title></head>
<body class="container-fluid p-3">
  <h2 class="h5">Sales by quarter</h2>
  <div id="sales" style="width:100%;height:320px" role="img" aria-label="Sales rise from 12 to 24 thousand units"></div>
  <script>
    dsh.chart(document.getElementById('sales'), {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: ['Q1', 'Q2', 'Q3', 'Q4'] },
      yAxis: { type: 'value', name: 'Thousands of units' },
      series: [{ name: 'Sales', type: 'bar', data: [12, 18, 16, 24] }]
    });
  </script>
</body></html>
```

Initialize immediately or in a `DOMContentLoaded` listener; that authored initialization event follows supported scripts while `document.readyState` is `complete`. Keep expensive processing bounded. Inputs, filters and chart interactions are transient: Source/Preview and enlargement retain an active frame, while Reload, eviction and reopening restore authored initial state. No interaction submits data to the assistant.

The viewer downloads PNG only for helper-owned charts, with a chooser when there are several. Original source and offline HTML are also available; offline HTML embeds packaged dependencies and restores initial data. Arbitrary HTML screenshots, PDF and chart SVG exports are unavailable. Exports require a user action and use a sanitized title with `YYYYMMDD` and a sequence for repeated names. Summarize the meaningful result in surrounding prose so the explanation remains useful outside the preview.
