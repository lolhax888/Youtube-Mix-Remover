// YouTube Mix Remover - Background Script
// Strips all parameters from YouTube URLs except the video ID

// Cross-browser compatibility: use browser API if available, otherwise chrome API
const api = typeof browser !== 'undefined' ? browser : chrome;

// Store enabled state
let enabled = true;

// Load enabled state on startup
api.storage.sync.get(['enabled']).then((result) => {
  enabled = result.enabled !== false;
}).catch(() => {
  // If storage fails, default to enabled
  enabled = true;
});

// Listen for messages from popup
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'stateChanged') {
    enabled = message.enabled;
  }
  return true;
});

// Extract video ID from various YouTube URL formats
function extractVideoId(url) {
  try {
    const urlObj = new URL(url);

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
    const urlObj = new URL(originalUrl);

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

// Check if URL needs cleaning (has extra parameters beyond just v)
function needsCleaning(url) {
  try {
    const urlObj = new URL(url);

    if (urlObj.hostname === 'youtu.be') {
      // youtu.be URLs always need cleaning if they have any query params
      return urlObj.search.length > 0;
    }

    if (urlObj.hostname.includes('youtube.com')) {
      // For /watch URLs, check if there are params other than 'v'
      if (urlObj.pathname === '/watch') {
        const params = Array.from(urlObj.searchParams.keys());
        return params.length > 1 || !params.includes('v');
      }

      // For /shorts/ and /embed/, check if there are any query params
      if (urlObj.pathname.startsWith('/shorts/') || urlObj.pathname.startsWith('/embed/')) {
        return urlObj.search.length > 0;
      }
    }
  } catch (e) {
    return false;
  }

  return false;
}

// Handle web navigation - redirect before page loads
api.webNavigation.onBeforeNavigate.addListener((details) => {
  // Skip if extension is disabled
  if (!enabled) {
    return;
  }

  // Only handle main frame navigations
  if (details.frameId !== 0) {
    return;
  }

  const url = details.url;

  // Skip if URL doesn't need cleaning
  if (!needsCleaning(url)) {
    return;
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return;
  }

  const cleanUrl = buildCleanUrl(videoId, url);
  if (cleanUrl && cleanUrl !== url) {
    // Redirect to clean URL
    api.tabs.update(details.tabId, { url: cleanUrl });
  }
}, {
  url: [
    { hostContains: 'youtube.com' },
    { hostContains: 'youtu.be' }
  ]
});

// Handle clicks on links within YouTube pages (SPA behavior)
// Inject content script to intercept link clicks
api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('youtube.com')) {
    // Inject content script to handle SPA link clicks
    api.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    }).catch(err => {
      // Ignore errors (script might already be injected or not allowed)
    });
  }
});
