import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const html = execFileSync(
  'bundle',
  [
    'exec',
    'ruby',
    '-Ilib',
    '-e',
    'require "rails"; require "rails_charts"; puts RailsCharts::LineChart.new({"Monday" => 1}, id: "lifecycle-chart").js_code',
  ],
  { encoding: 'utf8' },
);
assert.match(
  html,
  /<div id="lifecycle-chart"[^>]*><\/div>\s*<script>/,
  'the lifecycle script is outside the ECharts-owned element',
);

const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'generated chart HTML includes a script');

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(callback);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name, callback) {
    this.listeners.get(name)?.delete(callback);
  }

  dispatch(name, target = this) {
    for (const callback of [...(this.listeners.get(name) || [])]) {
      callback({ target });
    }
  }

  listenerCount(name) {
    return this.listeners.get(name)?.size || 0;
  }
}

function createHarness({ supportsResizeObserver = true } = {}) {
  const browserWindow = new FakeEventTarget();
  const browserDocument = new FakeEventTarget();
  const connectedElements = new Set();
  const instances = new WeakMap();
  const resizeObservers = [];
  let chartElement = createChartElement();
  let initializationCount = 0;
  let disposalCount = 0;
  let resizeCount = 0;

  connectedElements.add(chartElement);

  browserDocument.documentElement = {
    contains: (element) => connectedElements.has(element),
    hasAttribute: () => false,
  };
  browserDocument.getElementById = (id) => {
    if (id !== 'lifecycle-chart') return null;
    return connectedElements.has(chartElement) ? chartElement : null;
  };

  if (supportsResizeObserver) {
    browserWindow.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.element = undefined;
        resizeObservers.push(this);
      }

      observe(element) {
        this.element = element;
      }

      disconnect() {
        this.element = undefined;
      }

      trigger() {
        if (this.element) this.callback([{ target: this.element }], this);
      }
    };
  }

  browserWindow.echarts = {
    getInstanceByDom: (element) => instances.get(element),
    init: (element) => {
      initializationCount += 1;
      element.innerHTML = '';

      const chart = {
        setOption: () => {},
        on: () => {},
        resize: () => {
          resizeCount += 1;
        },
        dispose: () => {
          disposalCount += 1;
          element.innerHTML = '';
          instances.delete(element);
        },
      };

      instances.set(element, chart);
      return chart;
    },
  };

  const activateScript = () => {
    globalThis.window = browserWindow;
    globalThis.document = browserDocument;
    globalThis.AbortController = undefined;
    vm.runInThisContext(script);
  };

  return {
    activateScript,
    browserDocument,
    browserWindow,
    containingFrame: { contains: (element) => element === chartElement },
    unrelatedFrame: { contains: () => false },
    disconnectChart: () => connectedElements.delete(chartElement),
    replaceChart: () => {
      connectedElements.delete(chartElement);
      chartElement = createChartElement();
      connectedElements.add(chartElement);
    },
    get chartElement() {
      return chartElement;
    },
    get disposalCount() {
      return disposalCount;
    },
    get activeResizeObserverCount() {
      return resizeObservers.filter((observer) => observer.element).length;
    },
    get initializationCount() {
      return initializationCount;
    },
    get resizeCount() {
      return resizeCount;
    },
    get resizeObserverCount() {
      return resizeObservers.length;
    },
    triggerResizeObservers: () => resizeObservers.forEach((observer) => observer.trigger()),
  };
}

function createChartElement() {
  return { innerHTML: '<span>ECharts replaces this content</span>' };
}

{
  const harness = createHarness();

  harness.activateScript();
  harness.browserWindow.dispatch('load');
  assert.equal(harness.initializationCount, 1, 'the first load initializes without AbortController');
  assert.equal(harness.chartElement.innerHTML, '', 'the ECharts double clears its owned element');
  assert.equal(harness.activeResizeObserverCount, 1, 'the chart container is observed after initialization');

  harness.triggerResizeObservers();
  assert.equal(harness.resizeCount, 1, 'a container resize resizes the existing chart');

  harness.browserWindow.dispatch('turbo:load');
  assert.equal(harness.initializationCount, 1, 'later load events reuse the existing chart instance');
  assert.equal(harness.resizeObserverCount, 1, 'later load events reuse the existing resize observer');

  harness.activateScript();
  assert.equal(harness.browserWindow.listenerCount('turbo:load'), 1, 'reevaluation replaces stale listeners');
  assert.equal(harness.activeResizeObserverCount, 0, 'reevaluation disconnects the stale resize observer');
  harness.browserWindow.dispatch('turbo:load');
  assert.equal(harness.initializationCount, 1, 'reevaluation reuses the existing chart instance');
  assert.equal(harness.activeResizeObserverCount, 1, 'reevaluation observes the retained chart once');

  harness.triggerResizeObservers();
  assert.equal(harness.resizeCount, 2, 'only the replacement observer resizes the retained chart');
}

{
  const harness = createHarness();

  harness.activateScript();
  harness.browserWindow.dispatch('load');
  harness.browserDocument.dispatch('turbo:before-frame-render', harness.unrelatedFrame);
  harness.browserDocument.dispatch('turbo:frame-render', harness.unrelatedFrame);
  assert.equal(harness.disposalCount, 0, 'unrelated frame events leave the chart alone');
  assert.equal(harness.initializationCount, 1, 'unrelated frame events do not initialize the chart');

  harness.browserDocument.dispatch('turbo:before-frame-render', harness.containingFrame);
  assert.equal(harness.disposalCount, 1, 'replacing the containing frame disposes the chart');
  assert.equal(harness.activeResizeObserverCount, 0, 'replacing the containing frame disconnects its observer');
  assert.equal(harness.browserWindow.RailsCharts.charts['lifecycle-chart'], undefined);
  assert.equal(harness.browserWindow.RailsCharts.listenerControllers['lifecycle-chart'], undefined);

  harness.browserWindow.dispatch('load');
  assert.equal(harness.initializationCount, 1, 'retired frame listeners no longer respond');

  harness.replaceChart();
  harness.activateScript();
  harness.browserDocument.dispatch('turbo:frame-render', harness.containingFrame);
  assert.equal(harness.initializationCount, 2, 'the replacement frame initializes a fresh chart');
}

{
  const harness = createHarness();

  harness.activateScript();
  harness.browserWindow.dispatch('load');
  harness.browserDocument.dispatch('turbo:before-cache');
  assert.equal(harness.activeResizeObserverCount, 0, 'cache preparation disconnects the resize observer');
  harness.browserDocument.dispatch('turbo:before-render');
  assert.equal(harness.disposalCount, 1, 'a promoted frame visit disposes the chart once');
  assert.equal(
    harness.browserWindow.listenerCount('turbo:load'),
    1,
    'a promoted frame visit keeps the owner listener while its element remains connected',
  );

  harness.browserDocument.dispatch('turbo:render');
  harness.browserWindow.dispatch('turbo:load');
  assert.equal(harness.initializationCount, 2, 'a promoted frame visit reinitializes after its no-render page visit');
  assert.equal(harness.activeResizeObserverCount, 1, 'a promoted frame visit observes the reinitialized chart');
}

{
  const harness = createHarness();

  harness.activateScript();
  harness.browserWindow.dispatch('load');
  harness.browserDocument.dispatch('turbo:before-cache');
  harness.browserDocument.dispatch('turbo:before-render');
  harness.disconnectChart();
  harness.browserDocument.dispatch('turbo:render');
  assert.equal(harness.disposalCount, 1, 'leaving a cached page disposes the chart');
  assert.equal(harness.browserWindow.listenerCount('turbo:load'), 0, 'a detached chart retires its listeners');

  harness.browserWindow.dispatch('turbo:load');
  assert.equal(harness.initializationCount, 1, 'the detached chart does not reinitialize on the next page');

  harness.replaceChart();
  harness.activateScript();
  harness.browserWindow.dispatch('turbo:load');
  assert.equal(harness.initializationCount, 2, 'restoring the cached script initializes a fresh chart');
}

{
  const harness = createHarness();

  harness.activateScript();
  harness.browserWindow.dispatch('load');
  harness.browserDocument.dispatch('turbo:before-cache');
  harness.browserDocument.dispatch('turbo:before-render');
  harness.browserDocument.dispatch('turbo:render');
  harness.browserWindow.dispatch('turbo:load');
  assert.equal(harness.disposalCount, 1, 'a permanent chart is disposed before its page render');
  assert.equal(harness.initializationCount, 2, 'a permanent chart reinitializes on its preserved element');
}

{
  const harness = createHarness();

  harness.activateScript();
  harness.browserWindow.dispatch('load');
  harness.browserDocument.dispatch('turbolinks:before-cache');
  harness.browserDocument.dispatch('turbolinks:before-render');
  harness.browserDocument.dispatch('turbolinks:render');
  harness.browserWindow.dispatch('turbolinks:load');
  assert.equal(harness.disposalCount, 1, 'Turbolinks cache preparation disposes the chart');
  assert.equal(harness.initializationCount, 2, 'Turbolinks reinitializes a preserved chart after rendering');
}

{
  const harness = createHarness({ supportsResizeObserver: false });

  harness.activateScript();
  harness.browserWindow.dispatch('load');
  assert.equal(harness.browserWindow.listenerCount('resize'), 1, 'older browsers register one resize fallback');

  harness.browserWindow.dispatch('resize');
  assert.equal(harness.resizeCount, 1, 'the window resize fallback resizes the existing chart');

  harness.activateScript();
  assert.equal(harness.browserWindow.listenerCount('resize'), 1, 'reevaluation replaces the resize fallback');

  harness.browserWindow.dispatch('resize');
  assert.equal(harness.resizeCount, 2, 'the replacement fallback resizes the retained chart');

  harness.browserDocument.dispatch('turbo:before-frame-render', harness.containingFrame);
  assert.equal(harness.browserWindow.listenerCount('resize'), 0, 'frame replacement retires the resize fallback');
}
