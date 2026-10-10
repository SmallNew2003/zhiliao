---
name: visualize-html
description: Create inline interactive HTML panels, comparisons and simulations in assistant replies using the packaged visualization runtime.
---

# Inline HTML

Use a panel when controls or a compact visual explanation help the user understand an answer. Use ordinary prose for a simple fact or one-step action. For data charts load visualize-charts; for Mermaid diagrams load visualize-diagrams.

Emit a top-level assistant fence opened with `html preview runtime={{runtime}}` and explicitly close it with a matching fence. Nested fences, ordinary HTML fences and unclosed fences do not execute. Write plain HTML, CSS and JavaScript; JSX, package installation and imports from external packages are unavailable.

The runtime supplies Bootstrap {{bootstrap}} CSS and the native `bootstrap` global, including its bundled Popper support. Use Bootstrap classes such as `container-fluid`, `card`, `card-body`, `row`, `col`, `btn`, `form-control`, `form-select`, `table` and `alert`. Public theme colors and typography follow the application theme. Prefer responsive widths and readable contrast; avoid fixed wide layouts. ECharts {{echarts}} requires `libs=echarts` and visualize-charts. Mermaid {{mermaid}} uses its own marked fence and visualize-diagrams.

Include all data inline. The isolated document has no Host operations, parent DOM access, filesystem access, fetch, remote images/fonts/scripts/styles, workers, nested frames or forms that submit. Do not assume the user's logged-in browser, a network connection or an application callback. Local DOM events and native browser controls can update only the preview.

Initialize immediately or in a `DOMContentLoaded` listener. The runtime dispatches that authored initialization event after supported scripts finish; `document.readyState` is already `complete`. Keep interactions deterministic and lightweight. Inputs, filters and DOM edits are transient: Source/Preview and enlargement retain an active document, while Reload, eviction and reopening restore authored initial values. Do not imply that inputs are saved or submitted to the assistant.

```html preview runtime={{runtime}}
<!doctype html>
<html><head><title>Cost comparison</title></head>
<body class="container-fluid p-3">
  <section class="card"><div class="card-body">
    <h2 class="h5">Monthly cost</h2>
    <label for="units" class="form-label">Units</label>
    <input id="units" class="form-control" type="range" min="1" max="100" value="20">
    <output id="cost" class="d-block mt-3" aria-live="polite"></output>
  </div></section>
  <script>
    const units = document.getElementById('units');
    const cost = document.getElementById('cost');
    function update() { cost.textContent = `${units.value} units: $${Number(units.value) * 3}`; }
    units.addEventListener('input', update);
    update();
  </script>
</body></html>
```

The viewer offers original source and offline HTML downloads. Offline HTML embeds packaged dependencies and restores authored initial state; it executes in the user's browser when opened. Arbitrary HTML has no PNG/PDF export. If the user needs a shareable scientific figure, a document, saved input or another format, produce a separate file artifact using the appropriate tools. Export titles become sanitized filenames with a `YYYYMMDD` suffix, plus a sequence for repeated names.
