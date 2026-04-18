document.addEventListener('DOMContentLoaded', async () => {
  const toggle = document.getElementById('toggle');
  const status = document.getElementById('status');

  // Load current state
  const result = await chrome.storage.sync.get(['enabled']);
  const isEnabled = result.enabled !== false; // Default to enabled

  toggle.checked = isEnabled;
  updateStatus(isEnabled);

  toggle.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    await chrome.storage.sync.set({ enabled });
    updateStatus(enabled);

    // Notify background script of state change
    await chrome.runtime.sendMessage({ action: 'stateChanged', enabled });
  });

  function updateStatus(enabled) {
    status.textContent = enabled ? 'Extension is ON' : 'Extension is OFF';
    status.style.color = enabled ? '#28a745' : '#dc3545';
  }
});
