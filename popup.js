document.addEventListener('DOMContentLoaded', async () => {
  const toggle = document.getElementById('toggle');
  const status = document.getElementById('status');
  const api = typeof browser !== 'undefined' ? browser : chrome;

  const result = await api.storage.sync.get(['enabled']);
  const isEnabled = result.enabled !== false;
  toggle.checked = isEnabled;
  updateStatus(isEnabled);

  toggle.addEventListener('change', async (event) => {
    const enabled = event.target.checked;
    await api.storage.sync.set({ enabled });
    updateStatus(enabled);
    if (enabled) {
      try {
        await api.runtime.sendMessage({ action: 'inject-current-tab' });
      } catch (_) {
        // The current tab may not be scriptable on browser-owned pages.
      }
    }
  });

  function updateStatus(enabled) {
    status.textContent = enabled ? 'Extension is ON' : 'Extension is OFF';
    status.style.color = enabled ? '#28a745' : '#dc3545';
  }
});
