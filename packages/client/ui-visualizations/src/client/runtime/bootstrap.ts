/** Trusted document bootstrap; all capabilities remain private to its closure. */
export const bootstrapSource = String.raw`
(async () => {
  const payload = __DSH_PAYLOAD__;
  const offline = __DSH_OFFLINE__;
  let port, svg, theme = payload.theme, disposed = false, scheduled = false, ready = false, failed = false;
  const loaded = document.readyState === 'complete' ? Promise.resolve()
    : new Promise(resolve => addEventListener('load', resolve, { once: true }));
  const urls = new Set(), charts = [];
  const nativePost = MessagePort.prototype.postMessage;
  const send = message => { if (port && !disposed) nativePost.call(port, { generation: payload.generation, ...message }); };
  const failure = error => {
    failed = true;
    send({ type: 'error', error: String(error && error.message || error).slice(0, 1024) });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer && observer.disconnect();
    charts.forEach(entry => { entry.observer.disconnect(); entry.chart.dispose(); });
    urls.forEach(url => URL.revokeObjectURL(url)); urls.clear();
    if (port) { port.onmessage = null; port.close(); }
  };
  addEventListener('pagehide', dispose, { once: true });
  addEventListener('error', event => failure(event.error || event.message));
  addEventListener('unhandledrejection', event => failure(event.reason));
  addEventListener('keydown', event => {
    if (event.isTrusted && event.key === 'Escape' && !event.repeat) send({ type: 'escape' });
  }, { capture: true });
  const colors = () => theme.colorScheme === 'dark'
    ? [theme.accent, '#73c0de', '#91cc75', '#fac858', '#ee6666', '#9a60b4']
    : [theme.accent, '#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de'];
  const defaults = () => ({ color: colors(), backgroundColor: theme.background,
    textStyle: { color: theme.foreground, fontFamily: theme.fontFamily, fontSize: theme.fontSize } });
  const updateTheme = next => {
    theme = next;
    document.documentElement.setAttribute('data-bs-theme', theme.colorScheme);
    const style = document.documentElement.style;
    style.setProperty('--bs-body-bg', theme.background);
    style.setProperty('--bs-body-color', theme.foreground);
    style.setProperty('--bs-primary', theme.accent);
    style.setProperty('--bs-link-color', theme.accent);
    style.setProperty('--bs-body-font-family', theme.fontFamily);
    style.setProperty('--bs-body-font-size', theme.fontSize + 'px');
    style.colorScheme = theme.colorScheme;
    charts.forEach(entry => {
      if (entry.chart.isDisposed()) return;
      entry.chart.setTheme(defaults());
    });
  };
  const chartNames = () => charts.filter(entry => !entry.chart.isDisposed()).map(entry => entry.id);
  Object.defineProperty(window, 'dsh', { value: Object.freeze({
    chart: (element, option) => {
      if (!window.echarts) throw new Error('Declare libs=echarts before calling dsh.chart');
      if (charts.length >= 64) throw new Error('The chart export catalog is full');
      const chart = window.echarts.init(element, defaults());
      chart.setOption(option);
      const observer = new ResizeObserver(() => { if (!chart.isDisposed()) chart.resize(); });
      observer.observe(element);
      const id = String(charts.length + 1);
      charts.push({ id, chart, observer });
      if (ready) send({ type: 'charts', charts: chartNames() });
      return chart;
    }
  }), configurable: false, writable: false });
  const observeHeight = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; send({ type: 'height', height: document.body.scrollHeight }); });
  };
  const observer = new ResizeObserver(observeHeight);
  const script = text => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/javascript' })); urls.add(url);
    const element = document.createElement('script'); element.src = url; element.async = false;
    element.onload = resolve; element.onerror = () => reject(new Error('Runtime asset failed to load'));
    document.head.append(element);
  });
  const run = async () => {
    await loaded;
    if (disposed || failed) return;
    for (const css of payload.assets.css) {
      const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    }
    const style = document.createElement('style');
    style.textContent = 'html{overflow:auto}body{margin:0;padding:12px;min-height:0}svg{max-width:100%;height:auto}';
    document.head.append(style);
    for (const bytes of payload.assets.scripts) {
      await script(bytes);
      if (disposed || failed) return;
    }
    updateTheme(theme);
    if (payload.language === 'mermaid') {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict',
        theme: theme.colorScheme === 'dark' ? 'dark' : 'default', flowchart: { htmlLabels: false } });
      const result = await window.mermaid.render('dsh-diagram', payload.source);
      svg = result.svg;
      document.body.innerHTML = svg;
    } else {
      const parsed = new DOMParser().parseFromString(payload.source, 'text/html');
      const scripts = [];
      const append = (node, target) => {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'SCRIPT') {
          const marker = document.createComment(''); target.append(marker);
          scripts.push({ node, marker });
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'BASE' || node.tagName === 'META') return;
          const element = document.importNode(node, false); target.append(element);
          for (const child of node.childNodes) append(child, element);
        } else { target.append(document.importNode(node, false)); }
      };
      for (const node of parsed.head.childNodes) append(node, document.head);
      for (const node of parsed.body.childNodes) append(node, document.body);
      for (const { node, marker } of scripts) {
        const element = document.createElement('script');
        for (const attribute of node.attributes) element.setAttribute(attribute.name, attribute.value);
        element.textContent = node.textContent;
        const type = element.type.trim().toLowerCase();
        let moduleUrl;
        if (type === 'module' && !element.hasAttribute('src')) {
          moduleUrl = URL.createObjectURL(new Blob([element.textContent], { type: 'application/javascript' }));
          urls.add(moduleUrl); element.textContent = ''; element.src = moduleUrl;
        }
        const pending = type === 'module' || (element.hasAttribute('src')
          && (!type || /^(?:text|application)\/(?:javascript|ecmascript)$/.test(type)))
          ? new Promise((resolve, reject) => {
            element.addEventListener('load', resolve, { once: true });
            element.addEventListener('error', () => reject(new Error('Authored script failed to load')), { once: true });
          }) : undefined;
        marker.replaceWith(element);
        try { if (pending) await pending; }
        finally { if (moduleUrl) { URL.revokeObjectURL(moduleUrl); urls.delete(moduleUrl); } }
        if (disposed || failed) return;
      }
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    }
    if (disposed || failed) return;
    observer.observe(document.body); observeHeight();
    const title = (document.title || document.querySelector('h1,h2,h3,caption')?.textContent || '').trim().slice(0, 128);
    ready = true;
    send({ type: 'ready', title, charts: chartNames() });
  };
  const handle = async event => {
    const request = event.data;
    if (!request || request.generation !== payload.generation || disposed) return;
    if (request.type === 'theme') { updateTheme(request.theme); return; }
    if (request.type !== 'export' || typeof request.requestId !== 'string' || request.requestId.length > 64) return;
    try {
      if (request.format === 'svg' && payload.language === 'mermaid' && svg) {
        send({ type: 'export', requestId: request.requestId, mime: 'image/svg+xml', data: svg });
      } else if (request.format === 'png' && payload.language === 'html') {
        const entry = charts.find(entry => entry.id === request.chart && !entry.chart.isDisposed());
        if (!entry) throw new Error('Selected chart is unavailable');
        send({ type: 'export', requestId: request.requestId, mime: 'image/png', data: entry.chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: theme.background }) });
      }
    } catch (error) { failure(error); }
  };
  if (offline) { await run(); return; }
  const initialize = event => {
    if (event.source !== parent || event.data?.type !== 'dsh-preview-init' || event.data.generation !== payload.generation || event.ports.length !== 1) return;
    event.stopImmediatePropagation();
    removeEventListener('message', initialize);
    port = event.ports[0]; port.onmessage = handle; port.start();
    void run().catch(failure);
  };
  addEventListener('message', initialize);
})().catch(error => { document.body.textContent = String(error && error.message || error); });
`
