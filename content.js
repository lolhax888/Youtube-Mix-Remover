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

  const scriptVersion = '4.0.6';
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
  let pendingQueueBefore = null;
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
    const element = target instanceof Element ? target : null;
    const renderer = element && element.closest(
      'ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer'
    );
    const link = renderer && renderer.querySelector('a[href*="watch"]');
    return link ? urls.getVideoId(link.href) : null;
  }

  function isVideoMenuButton(target) {
    const element = target instanceof Element ? target : null;
    if (!element) return false;
    const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`;
    return /more|menu|action/i.test(label);
  }

  function rememberQueueSource(target) {
    if (!isVideoMenuButton(target)) return;
    const id = sourceVideoId(target);
    if (id) {
      pendingQueueSource = id;
      pendingQueueSourceAt = Date.now();
      pendingQueueBefore = queueSnapshot();
    }
  }

  function handleNavigationClick(event) {
    if (!enabled || event.button !== 0 || event.defaultPrevented) return;

    const target = event.target instanceof Element ? event.target : null;
    const anchor = target && target.closest('a[href]');
    if (!anchor || !urls.isYouTubeUrl(anchor.href)) return;

    const cleanUrl = urls.cleanMixUrl(anchor.href);
    if (!cleanUrl) return;

    pendingNavigationBefore = queueSnapshot();
    pendingNavigationVideoId = urls.getVideoId(anchor.href);
    pendingNavigationAt = Date.now();
    anchor.href = cleanUrl;
    anchor.setAttribute('href', cleanUrl);
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
    const menuButton = Array.from(item.querySelectorAll('button, yt-icon-button, tp-yt-paper-icon-button'))
      .find((button) => /more|menu|action/i.test(
        `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`
      ));
    if (!menuButton) return false;

    menuButton.click();
    const remove = Array.from(document.querySelectorAll(
      'ytd-menu-service-item-renderer, tp-yt-paper-item, [role="menuitem"]'
    )).find((entry) => /remove\s+from\s+queue/i.test(entry.textContent || ''));
    if (!remove) return false;

    remove.click();
    return true;
  }

  function removeQueueItems(items, index) {
    if (index >= items.length || !enabled) return;
    if (clickRemoveFromQueue(items[index])) {
      window.setTimeout(() => removeQueueItems(items, index + 1), 350);
    } else {
      removeQueueItems(items, index + 1);
    }
  }

  function isQueueAction(target) {
    const element = target instanceof Element ? target : null;
    if (!element) return false;
    const label = [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent]
      .filter(Boolean).join(' ').toLowerCase();
    return /add\s+to\s+(?:the\s+)?queue/.test(label);
  }

  function handleQueueClick(event) {
    if (!enabled || !isQueueAction(event.target)) return;

    const before = pendingQueueBefore || queueSnapshot();
    const directSourceId = sourceVideoId(event.target);
    const selectedId = directSourceId || (
      Date.now() - pendingQueueSourceAt < 3000 ? pendingQueueSource : null
    );
    pendingQueueBefore = null;
    cleanQueueAfterAdd(before, selectedId);
  }

  function cleanQueueAfterAdd(before, selectedId) {
    const deadline = Date.now() + 5000;
    const removing = new Set();

    function inspect() {
      if (!enabled) return;
      const items = queueItems();
      const newItems = items.filter((item) => {
        const id = itemVideoId(item);
        return id && !before.has(id) && id !== selectedId && !removing.has(id);
      });

      newItems.forEach((item) => {
        const id = itemVideoId(item);
        if (clickRemoveFromQueue(item) && id) removing.add(id);
      });

      if (Date.now() < deadline) window.setTimeout(inspect, 250);
    }

    window.setTimeout(inspect, 300);
  }

  document.addEventListener('click', handleNavigationClick, true);
  document.addEventListener('click', rememberQueueSource, true);
  document.addEventListener('click', handleQueueClick, true);
  document.addEventListener('yt-page-data-fetched', handlePageDataFetched, true);
  document.addEventListener('yt-navigate-finish', handleNavigationFinished, true);
  document.addEventListener('yt-navigate-start', handleYouTubeNavigation, true);
})();
