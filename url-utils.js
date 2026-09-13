/* Shared URL rules for YouTube Mix Remover. */
(function (root) {
  'use strict';

  const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
  const RADIO_LIST = /^RD[A-Z0-9_-]*$/i;

  function parse(value) {
    try {
      return new URL(value, root.location && root.location.origin ? root.location.origin : 'https://www.youtube.com');
    } catch (_) {
      return null;
    }
  }

  function isYouTubeUrl(url) {
    const parsed = parse(url);
    if (!parsed) return false;
    return parsed.hostname === 'youtu.be' || /(^|\.)youtube\.com$/i.test(parsed.hostname);
  }

  function getVideoId(url) {
    const parsed = parse(url);
    if (!parsed) return null;

    if (parsed.hostname === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      return VIDEO_ID.test(id || '') ? id : null;
    }

    const queryId = parsed.searchParams.get('v');
    if (parsed.pathname === '/watch' && VIDEO_ID.test(queryId || '')) return queryId;

    const pathMatch = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
    return pathMatch ? pathMatch[1] : null;
  }

  function isRadioList(value) {
    return Boolean(value && RADIO_LIST.test(value));
  }

  function hasExplicitPlaylist(url) {
    const parsed = parse(url);
    const list = parsed && parsed.searchParams.get('list');
    return Boolean(list && !isRadioList(list));
  }

  function isUnwantedMix(url) {
    const parsed = parse(url);
    if (!parsed || !getVideoId(parsed.href)) return false;

    const list = parsed.searchParams.get('list');
    const startRadio = parsed.searchParams.get('start_radio') === '1';
    return isRadioList(list) || (startRadio && !list);
  }

  function cleanMixUrl(url) {
    const parsed = parse(url);
    if (!parsed || !isUnwantedMix(parsed.href)) return null;

    ['list', 'index', 'start_radio', 'shuffle'].forEach((key) => parsed.searchParams.delete(key));
    return parsed.href;
  }

  root.YouTubeMixUrls = {
    cleanMixUrl,
    getVideoId,
    hasExplicitPlaylist,
    isRadioList,
    isUnwantedMix,
    isYouTubeUrl,
    parse
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
