// YouTube Mix Remover - Content Script
// Intercepts link clicks within YouTube SPA and cleans URLs

(function() {
  'use strict';

  // Cross-browser compatibility: use browser API if available, otherwise chrome API
  const api = typeof browser !== 'undefined' ? browser : chrome;

  // Check if extension is enabled
  function isEnabled() {
    return new Promise((resolve) => {
      api.storage.sync.get(['enabled']).then((result) => {
        resolve(result.enabled !== false);
      }).catch(() => {
        // If storage fails, default to enabled
        resolve(true);
      });
    });
  }

  // Extract video ID from various YouTube URL formats
  function extractVideoId(url) {
    try {
      const urlObj = new URL(url, window.location.origin);

      // Handle youtu.be short URLs
      if (urlObj.hostname === 'youtu.be') {
        return urlObj.pathname.slice(1).split('?')[0].split('&')[0];
      }

      // Handle youtube.com/watch?v=VIDEO_ID
      if (urlObj.hostname.includes('youtube.com')) {
        const videoId = urlObj.searchParams.get('v');
        if (videoId) {
          return videoId;
        }

        // Handle /shorts/VIDEO_ID
        const shortsMatch = urlObj.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
        if (shortsMatch) {
          return shortsMatch[1];
        }

        // Handle /embed/VIDEO_ID
        const embedMatch = urlObj.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
        if (embedMatch) {
          return embedMatch[1];
        }
      }
    } catch (e) {
      console.error('Error parsing URL:', e);
    }

    return null;
  }

  // Build clean YouTube URL with only video ID
  function buildCleanUrl(videoId, originalUrl) {
    try {
      const urlObj = new URL(originalUrl, window.location.origin);

      // For youtu.be URLs, convert to youtube.com/watch?v= format
      if (urlObj.hostname === 'youtu.be') {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }

      // For youtube.com URLs, keep the path but strip all params except v
      if (urlObj.hostname.includes('youtube.com')) {
        // Check if it's a shorts or embed URL
        if (urlObj.pathname.startsWith('/shorts/')) {
          return `https://www.youtube.com/shorts/${videoId}`;
        }
        if (urlObj.pathname.startsWith('/embed/')) {
          return `https://www.youtube.com/embed/${videoId}`;
        }

        // Default to /watch?v= format
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    } catch (e) {
      console.error('Error building clean URL:', e);
    }

    return null;
  }

  // Check if URL needs cleaning
  function needsCleaning(url) {
    try {
      const urlObj = new URL(url, window.location.origin);

      if (urlObj.hostname === 'youtu.be') {
        return urlObj.search.length > 0;
      }

      if (urlObj.hostname.includes('youtube.com')) {
        if (urlObj.pathname === '/watch') {
          const params = Array.from(urlObj.searchParams.keys());
          return params.length > 1 || !params.includes('v');
        }

        if (urlObj.pathname.startsWith('/shorts/') || urlObj.pathname.startsWith('/embed/')) {
          return urlObj.search.length > 0;
        }
      }
    } catch (e) {
      return false;
    }

    return false;
  }

  // Handle click events on anchor tags
  async function handleClick(event) {
    // Check if extension is enabled
    const enabled = await isEnabled();
    if (!enabled) {
      return;
    }

    const anchor = event.target.closest('a');
    if (!anchor) {
      return;
    }

    const href = anchor.href;
    if (!href) {
      return;
    }

    // Check if it's a YouTube URL
    try {
      const urlObj = new URL(href, window.location.origin);
      const isYouTube = urlObj.hostname.includes('youtube.com') || urlObj.hostname === 'youtu.be';

      if (!isYouTube) {
        return;
      }
    } catch (e) {
      return;
    }

    // Check if URL needs cleaning
    if (!needsCleaning(href)) {
      return;
    }

    const videoId = extractVideoId(href);
    if (!videoId) {
      return;
    }

    const cleanUrl = buildCleanUrl(videoId, href);
    if (!cleanUrl) {
      return;
    }

    // Prevent default navigation
    event.preventDefault();
    event.stopPropagation();

    // Navigate to clean URL
    window.location.href = cleanUrl;
  }

  // Use event delegation to capture all clicks
  document.addEventListener('click', handleClick, true);

  // Also handle YouTube's custom navigation (yt-navigate-start)
  document.addEventListener('yt-navigate-start', async function(event) {
    // Check if extension is enabled
    const enabled = await isEnabled();
    if (!enabled) {
      return;
    }

    if (event.detail && event.detail.endpoint) {
      let url = null;

      // Handle different endpoint formats
      if (typeof event.detail.endpoint === 'string') {
        url = event.detail.endpoint;
      } else if (event.detail.endpoint.url) {
        url = event.detail.endpoint.url;
      } else if (event.detail.endpoint.watchEndpoint && event.detail.endpoint.watchEndpoint.videoId) {
        // Reconstruct URL from watchEndpoint
        const videoId = event.detail.endpoint.watchEndpoint.videoId;
        url = `https://www.youtube.com/watch?v=${videoId}`;
      }

      if (url && typeof url === 'string' && needsCleaning(url)) {
        const videoId = extractVideoId(url);
        if (videoId) {
          const cleanUrl = buildCleanUrl(videoId, url);
          if (cleanUrl && cleanUrl !== url) {
            event.preventDefault();
            event.stopPropagation();
            window.location.href = cleanUrl;
          }
        }
      }
    }
  }, true);

  console.log('YouTube Mix Remover: Content script loaded');
})();
