// YouTube Mix Remover - background script
(function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  let enabled = true;

  if (!globalThis.YouTubeMixUrls && typeof importScripts === 'function') {
    importScripts('url-utils.js');
  }

  api.storage.sync.get(['enabled']).then((result) => {
    enabled = result.enabled !== false;
  }).catch(() => {});

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.enabled) enabled = changes.enabled.newValue !== false;
  });

  function isYouTubePage(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname === 'youtu.be' || /(^|\.)youtube\.com$/i.test(parsed.hostname);
    } catch (_) {
      return false;
    }
  }

  function injectContentScript(tabId, url) {
    if (!enabled || !isYouTubePage(url)) return;

    api.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    }).catch(() => {
      // The manifest content script handles normal page loads; this fallback
      // can fail on browser-owned pages or during tab teardown.
    });
  }

  function injectActiveTab() {
    api.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs[0];
      if (tab && tab.id != null && tab.url) injectContentScript(tab.id, tab.url);
    }).catch(() => {});
  }

  api.runtime.onMessage.addListener((message) => {
    if (message && message.action === 'inject-current-tab') injectActiveTab();
    return false;
  });

  api.tabs.onActivated.addListener((activeInfo) => {
    api.tabs.get(activeInfo.tabId).then((tab) => {
      if (tab.url) injectContentScript(activeInfo.tabId, tab.url);
    }).catch(() => {});
  });

  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
      injectContentScript(tabId, tab.url);
    }
  });

  api.webNavigation.onBeforeNavigate.addListener((details) => {
    if (!enabled || details.frameId !== 0) return;

    const cleanUrl = globalThis.YouTubeMixUrls.cleanMixUrl(details.url);
    if (cleanUrl && cleanUrl !== details.url) {
      api.tabs.update(details.tabId, { url: cleanUrl });
    }
  }, {
    url: [
      { hostContains: 'youtube.com' },
      { hostContains: 'youtu.be' }
    ]
  });
})();
