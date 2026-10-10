// YouTube Mix Remover - page content script
(function () {
  'use strict';

  function createUrlTools() {
    const videoIdPattern = /^[a-zA-Z0-9_-]{11}$/;
    const radioPattern = /^RD[A-Z0-9_-]*$/i;

    function parse(value) {
      try {
        return new URL(value, window.location.origin);
      } catch (_) {
        return null;
      }
    }

    function getVideoId(value) {
      const parsed = parse(value);
      if (!parsed) return null;
      if (parsed.hostname === 'youtu.be') {
        const id = parsed.pathname.split('/').filter(Boolean)[0];
        return videoIdPattern.test(id || '') ? id : null;
      }
      const queryId = parsed.searchParams.get('v');
      if (parsed.pathname === '/watch' && videoIdPattern.test(queryId || '')) return queryId;
      const pathMatch = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
      return pathMatch ? pathMatch[1] : null;
    }

    function isYouTubeUrl(value) {
      const parsed = parse(value);
      return Boolean(parsed && (parsed.hostname === 'youtu.be' || /(^|\.)youtube\.com$/i.test(parsed.hostname)));
    }

    function isRadioList(value) {
      return Boolean(value && radioPattern.test(value));
    }

    function isUnwantedMix(value) {
      const parsed = parse(value);
      if (!parsed || !getVideoId(parsed.href)) return false;
      const list = parsed.searchParams.get('list');
      return isRadioList(list) || (parsed.searchParams.get('start_radio') === '1' && !list);
    }

    function cleanMixUrl(value) {
      const parsed = parse(value);
      if (!parsed || !isUnwantedMix(parsed.href)) return null;
      ['list', 'index', 'start_radio', 'shuffle'].forEach((key) => parsed.searchParams.delete(key));
      return parsed.href;
    }

    function hasExplicitPlaylist(value) {
      const parsed = parse(value);
      const list = parsed && parsed.searchParams.get('list');
      return Boolean(list && !isRadioList(list));
    }

    return { cleanMixUrl, getVideoId, hasExplicitPlaylist, isRadioList, isYouTubeUrl };
  }

  const urls = window.YouTubeMixUrls || createUrlTools();
  if (!window.YouTubeMixUrls) window.YouTubeMixUrls = urls;

  const scriptVersion = '4.0.8';
  const alreadyLoaded = window.__youtubeMixRemoverLoadedVersion === scriptVersion;
  window.__youtubeMixRemoverLoadedVersion = scriptVersion;

  let enabled = true;
  const api = typeof browser !== 'undefined' ? browser : chrome;

  api.storage.sync.get(['enabled']).then((result) => {
    enabled = result.enabled !== false;
  }).catch(() => {});

  if (alreadyLoaded) return;

  if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.enabled) enabled = changes.enabled.newValue !== false;
    });
  }

  function endpointUrl(endpoint) {
    if (!endpoint) return null;
    if (typeof endpoint === 'string') return endpoint;
    if (typeof endpoint.url === 'string') return endpoint.url;

    const watch = endpoint.watchEndpoint;
    if (!watch || !watch.videoId) return null;

    const url = new URL(`https://www.youtube.com/watch?v=${watch.videoId}`);
    if (watch.playlistId) url.searchParams.set('list', watch.playlistId);
    if (watch.index != null) url.searchParams.set('index', watch.index);
    if (watch.params && /start_radio=1/.test(watch.params)) {
      url.searchParams.set('start_radio', '1');
    }
    return url.href;
  }

  function replaceEndpointUrl(endpoint, value) {
    if (!endpoint || !value || typeof endpoint === 'string') return false;
    if (typeof endpoint.url === 'string') {
      endpoint.url = value;
      return true;
    }

    const watch = endpoint.watchEndpoint;
    if (!watch || !watch.videoId) return false;

    try {
      const parsed = new URL(value);
      delete watch.playlistId;
      delete watch.index;
      delete watch.params;
      if (endpoint.commandMetadata && endpoint.commandMetadata.webCommandMetadata) {
        endpoint.commandMetadata.webCommandMetadata.url = parsed.pathname + parsed.search;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  let pendingQueueSource = null;
  let pendingQueueSourceAt = 0;
  let pendingNavigationBefore = null;
  let pendingNavigationVideoId = null;
  let pendingNavigationAt = 0;
  let navigationQueueObserver = null;

  function queueItems() {
    return Array.from(document.querySelectorAll('ytd-playlist-panel-video-renderer'));
  }

  function itemVideoId(item) {
    const link = item.querySelector('a[href*="watch"]');
    return link ? urls.getVideoId(link.href) : null;
  }

  function queueSnapshot() {
    return new Set(queueItems().map(itemVideoId).filter(Boolean));
  }

  function sourceVideoId(target) {
    const selector = 'ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, yt-lockup-view-model';
    const path = target && typeof target.composedPath === 'function' ? target.composedPath() : [];
    const element = target instanceof Element ? target : target && target.target instanceof Element ? target.target : null;
    const renderer = path.find((node) => node instanceof Element && node.matches(selector)) ||
      (element && element.closest(selector));
    const link = renderer && renderer.querySelector('a[href*="watch"]');
    return link ? urls.getVideoId(link.href) : null;
  }

  function isVideoMenuButton(target) {
    const path = target && typeof target.composedPath === 'function' ? target.composedPath() : [];
    const element = target instanceof Element ? target : target && target.target instanceof Element ? target.target : null;
    const elements = path.filter((node) => node instanceof Element);
    if (element && !elements.includes(element)) elements.unshift(element);
    return elements.some((node) => {
      const button = node.closest('button, yt-icon-button, tp-yt-paper-icon-button, [role="button"]') || node;
      const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`;
      return /more|menu|action/i.test(label);
    });
  }

  function rememberQueueSource(event) {
    if (!isVideoMenuButton(event)) {
      if (!isQueueAction(event)) {
        pendingQueueSource = null;
        pendingQueueSourceAt = 0;
      }
      return;
    }
    const id = sourceVideoId(event);
    if (id) {
      pendingQueueSource = id;
      pendingQueueSourceAt = Date.now();
    }
  }

  function handleNavigationClick(event) {
    if (!enabled || event.button !== 0 || event.defaultPrevented) return;

    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const anchor = path.find((node) => node instanceof Element && node.matches('a[href]')) ||
      path.map((node) => node instanceof Element ? node.closest('a[href]') : null).find(Boolean) ||
      (event.target instanceof Element ? event.target.closest('a[href]') : null);
    if (!anchor || !urls.isYouTubeUrl(anchor.href)) return;

    const cleanUrl = urls.cleanMixUrl(anchor.href);
    if (!cleanUrl) return;

    pendingNavigationBefore = queueSnapshot();
    pendingNavigationVideoId = urls.getVideoId(anchor.href);
    pendingNavigationAt = Date.now();
    anchor.href = cleanUrl;
    anchor.setAttribute('href', cleanUrl);

    const modifiedClick = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
    const target = anchor.getAttribute('target');
    if (!modifiedClick && (!target || target.toLowerCase() === '_self')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.location.assign(cleanUrl);
    }
  }

  function cleanUnwantedNavigationPanel(before, selectedId) {
    if (!selectedId || Date.now() - pendingNavigationAt > 12000) return false;

    const panels = Array.from(document.querySelectorAll('ytd-playlist-panel-renderer'));
    if (!panels.length) return false;

    if (!before.size) {
      panels.forEach((panel) => panel.remove());
      return true;
    }

    const extras = queueItems().filter((item) => {
      const id = itemVideoId(item);
      return id && !before.has(id) && id !== selectedId;
    });
    if (extras.length) removeQueueItems(extras, 0);
    return extras.length > 0;
  }

  function startNavigationPanelCleanup() {
    if (!pendingNavigationVideoId) return;
    if (navigationQueueObserver) navigationQueueObserver.disconnect();

    const selectedId = pendingNavigationVideoId;
    const before = pendingNavigationBefore || new Set();
    const startedAt = pendingNavigationAt;

    const inspect = () => {
      if (Date.now() - startedAt >= 12000) {
        navigationQueueObserver.disconnect();
        navigationQueueObserver = null;
        if (pendingNavigationVideoId === selectedId) {
          pendingNavigationBefore = null;
          pendingNavigationVideoId = null;
        }
        return;
      }
      cleanUnwantedNavigationPanel(before, selectedId);
    };

    navigationQueueObserver = new MutationObserver(inspect);
    navigationQueueObserver.observe(document.documentElement, { childList: true, subtree: true });
    inspect();
    window.setTimeout(inspect, 250);
    window.setTimeout(inspect, 1000);
    window.setTimeout(inspect, 3000);
    window.setTimeout(inspect, 7000);
  }

  function sanitizeMixData(value, seen) {
    if (!value || typeof value !== 'object') return 0;
    const visited = seen || new Set();
    if (visited.has(value)) return 0;
    visited.add(value);

    let changed = 0;
    if (Array.isArray(value)) {
      value.forEach((item) => { changed += sanitizeMixData(item, visited); });
      return changed;
    }

    Object.keys(value).forEach((key) => {
      const item = value[key];
      const lowerKey = key.toLowerCase();
      if ((lowerKey === 'playlistid' || lowerKey === 'listid' || lowerKey === 'list')
          && typeof item === 'string' && urls.isRadioList(item)) {
        delete value[key];
        changed += 1;
        return;
      }
      if (lowerKey === 'params' && typeof item === 'string' && /start_radio=1/i.test(item)) {
        delete value[key];
        changed += 1;
        return;
      }
      if (typeof item === 'string' && (lowerKey === 'url' || lowerKey === 'canonicalbaseurl')) {
        const cleaned = urls.cleanMixUrl(item);
        if (cleaned && cleaned !== item) {
          value[key] = cleaned;
          changed += 1;
          return;
        }
      }
      changed += sanitizeMixData(item, visited);
    });
    return changed;
  }

  function cleanNavigationQueue() {
    if (!pendingNavigationBefore || Date.now() - pendingNavigationAt > 10000) return;
    const before = pendingNavigationBefore;
    const selectedId = pendingNavigationVideoId;
    pendingNavigationBefore = null;
    pendingNavigationVideoId = null;
    cleanQueueAfterAdd(before, selectedId);
  }

  function handlePageDataFetched(event) {
    if (event.detail && event.detail.pageData) sanitizeMixData(event.detail.pageData);
    cleanUnwantedNavigationPanel(pendingNavigationBefore || new Set(), pendingNavigationVideoId);
  }

  function handleNavigationFinished() {
    window.setTimeout(cleanNavigationQueue, 350);
    startNavigationPanelCleanup();
  }

  function handleYouTubeNavigation(event) {
    if (!enabled || !event.detail || !event.detail.endpoint) return;

    const endpoint = event.detail.endpoint;
    const originalUrl = endpointUrl(endpoint) || event.detail.url || null;
    const cleanUrl = originalUrl && urls.cleanMixUrl(originalUrl);
    const rewrittenEndpoint = cleanUrl && replaceEndpointUrl(endpoint, cleanUrl);
    if (cleanUrl && typeof event.detail.url === 'string') event.detail.url = cleanUrl;

    if (cleanUrl && !rewrittenEndpoint && typeof event.detail.url !== 'string') {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.location.assign(cleanUrl);
    }
  }

  function clickRemoveFromQueue(item) {
    const menuButton = item.querySelector('button[aria-label="Action menu"]') ||
      Array.from(item.querySelectorAll('button, yt-icon-button, tp-yt-paper-icon-button'))
        .find((button) => /more|menu|action/i.test(
          `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`
        ));
    if (!menuButton) return Promise.resolve(false);

    return new Promise((resolve) => {
      let settled = false;
      let removalStarted = false;
      let removalObserver = null;
      let removalTimeout = null;
      const timeout = window.setTimeout(() => finish(false), 2500);
      const poll = window.setInterval(inspect, 100);
      const observer = new MutationObserver(inspect);
      observer.observe(document, { childList: true, subtree: true });

      function finish(removed) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.clearInterval(poll);
        observer.disconnect();
        if (removalObserver) removalObserver.disconnect();
        if (removalTimeout) window.clearTimeout(removalTimeout);
        const menuOpen = menuButton.getAttribute('aria-expanded') === 'true' ||
          Array.from(document.querySelectorAll('ytd-menu-popup-renderer, tp-yt-paper-listbox, [role="menu"]'))
            .some((menu) => menu.getClientRects().length > 0);
        if (!removed && menuOpen) {
          menuButton.click();
        }
        resolve(removed);
      }

      function inspect() {
        if (settled || removalStarted) return;
        const remove = Array.from(document.querySelectorAll(
          'ytd-menu-service-item-renderer, tp-yt-paper-item, [role="menuitem"]'
        )).find((entry) => entry.getClientRects().length > 0 &&
          /remove\s+from\s+(?:the\s+)?(?:queue|playlist)/i.test(entry.textContent || '')
        );
        if (remove) {
          removalStarted = true;
          window.clearInterval(poll);
          observer.disconnect();
          const action = remove.matches('tp-yt-paper-item, [role="menuitem"]')
            ? remove
            : remove.querySelector('tp-yt-paper-item, [role="menuitem"]') || remove;
          removalObserver = new MutationObserver(() => {
            if (!item.isConnected) {
              finish(true);
            }
          });
          removalObserver.observe(document, { childList: true, subtree: true });
          action.click();
          removalTimeout = window.setTimeout(() => {
            finish(!item.isConnected);
          }, 500);
        }
      }

      menuButton.click();
      inspect();
    });
  }

  function removeQueueItems(items, index) {
    if (index >= items.length || !enabled) return;
    clickRemoveFromQueue(items[index]).then(() => {
      window.setTimeout(() => removeQueueItems(items, index + 1), 350);
    });
  }

  function isQueueAction(target) {
    const path = target && typeof target.composedPath === 'function' ? target.composedPath() : [];
    const element = target instanceof Element ? target : target && target.target instanceof Element ? target.target : null;
    const elements = path.filter((node) => node instanceof Element);
    if (element && !elements.includes(element)) elements.unshift(element);
    return elements.some((node) => /add\s+to\s+(?:the\s+)?queue/i.test(
      [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent]
        .filter(Boolean).join(' ')
    ));
  }

  function handleQueueClick(event) {
    if (!enabled || !isQueueAction(event)) return;

    const before = queueSnapshot();
    const directSourceId = sourceVideoId(event);
    const sourceIsFresh = pendingQueueSource && Date.now() - pendingQueueSourceAt < 15000;
    const selectedId = directSourceId || (sourceIsFresh ? pendingQueueSource : null);
    pendingQueueSource = null;
    pendingQueueSourceAt = 0;
    if (!selectedId) return;
    cleanQueueAfterAdd(before, selectedId);
  }

  function cleanQueueAfterAdd(before, selectedId) {
    const deadline = Date.now() + 5000;
    const attempts = new Map();
    const inFlight = new Set();

    function inspect() {
      if (!enabled) return;
      const items = queueItems();
      const newItems = items.filter((item) => {
        const id = itemVideoId(item);
        return id && !before.has(id) && id !== selectedId &&
          !inFlight.has(id) && (attempts.get(id) || 0) < 2;
      });

      newItems.forEach((item) => {
        const id = itemVideoId(item);
        if (!id) return;
        attempts.set(id, (attempts.get(id) || 0) + 1);
        inFlight.add(id);
        clickRemoveFromQueue(item).then((removed) => {
          inFlight.delete(id);
          if (!removed && attempts.get(id) < 2 && Date.now() < deadline) {
            window.setTimeout(inspect, 350);
          }
        });
      });

      if (Date.now() < deadline) window.setTimeout(inspect, 250);
    }

    window.setTimeout(inspect, 300);
  }

  window.addEventListener('click', handleNavigationClick, true);
  document.addEventListener('click', rememberQueueSource, true);
  document.addEventListener('click', handleQueueClick, true);
  document.addEventListener('yt-page-data-fetched', handlePageDataFetched, true);
  document.addEventListener('yt-navigate-finish', handleNavigationFinished, true);
  document.addEventListener('yt-navigate-start', handleYouTubeNavigation, true);
})();
