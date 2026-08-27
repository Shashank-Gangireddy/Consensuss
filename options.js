// options.js

const $ = id => document.getElementById(id);

const DEFAULT_PRICING = {
  openai: { input: 0.15, output: 0.60 },
  anthropic: { input: 0.80, output: 4.00 },
  gemini: { input: 0.075, output: 0.30 }
};

async function load() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = settings || {};
  $('provider').value = s.provider || 'openai';
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model || '';
  $('sendLimit').value = s.sendLimit || 60;
  const auto = s.sendLimitAuto !== false; // default true (Auto) — matches the new dynamic-scaling default behavior
  $('sendLimitMode').value = auto ? 'auto' : 'manual';
  $('sendLimitManualRow').classList.toggle('hidden', auto);

  const pricing = { ...DEFAULT_PRICING, ...(s.pricing || {}) };
  $('priceOpenaiIn').value = pricing.openai.input;
  $('priceOpenaiOut').value = pricing.openai.output;
  $('priceAnthropicIn').value = pricing.anthropic.input;
  $('priceAnthropicOut').value = pricing.anthropic.output;
  $('priceGeminiIn').value = pricing.gemini.input;
  $('priceGeminiOut').value = pricing.gemini.output;
}

$('sendLimitMode').addEventListener('change', () => {
  $('sendLimitManualRow').classList.toggle('hidden', $('sendLimitMode').value !== 'manual');
});

$('saveBtn').addEventListener('click', async () => {
  const settings = {
    provider: $('provider').value,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    sendLimitAuto: $('sendLimitMode').value === 'auto',
    sendLimit: Math.max(10, Math.min(200, Number($('sendLimit').value) || 60)),
    pricing: {
      openai: { input: Number($('priceOpenaiIn').value), output: Number($('priceOpenaiOut').value) },
      anthropic: { input: Number($('priceAnthropicIn').value), output: Number($('priceAnthropicOut').value) },
      gemini: { input: Number($('priceGeminiIn').value), output: Number($('priceGeminiOut').value) }
    }
  };
  await chrome.storage.local.set({ settings });
  $('status').textContent = 'Saved.';
  setTimeout(() => ($('status').textContent = ''), 2000);
});

$('dashboardBtn').addEventListener('click', () =>
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })
);

async function fetchModels(provider, apiKey) {
  if (!apiKey) throw new Error('Enter an API key first.');

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data
      .map(m => m.id)
      .filter(id => /^(gpt-|o1|o3|o4|chatgpt-)/.test(id))
      .sort();
  }

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      }
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }

  if (provider === 'gemini') {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .sort();
  }

  throw new Error('Unknown provider');
}

$('fetchModelsBtn').addEventListener('click', async () => {
  const provider = $('provider').value;
  const apiKey = $('apiKey').value.trim();
  const statusEl = $('modelFetchStatus');
  $('fetchModelsBtn').disabled = true;
  statusEl.textContent = 'Fetching…';
  statusEl.style.color = '#666';
  try {
    const models = await fetchModels(provider, apiKey);
    const list = $('modelList');
    list.innerHTML = '';
    models.forEach(id => {
      const opt = document.createElement('option');
      opt.value = id;
      list.appendChild(opt);
    });
    statusEl.textContent = models.length
      ? `Found ${models.length} models — start typing in the field above to see suggestions, or pick one.`
      : 'No models returned for this key.';
    statusEl.style.color = '#0b7a2b';
  } catch (e) {
    statusEl.textContent = 'Failed: ' + e.message;
    statusEl.style.color = '#a11212';
  }
  $('fetchModelsBtn').disabled = false;
});

// "Test API Key" — a direct, minimal live call against the SELECTED
// provider using whatever is CURRENTLY TYPED in the key field (not
// necessarily what's saved yet), so a user can verify a freshly-pasted key
// before hitting Save, or re-confirm a saved one is still live right now.
// Reuses fetchModels() as the cheapest available live-auth check per
// provider (a models-list call, not a paid generation call) and reports
// the raw error body back verbatim — the whole point is to stop guessing
// and show the actual provider response.
$('testKeyBtn').addEventListener('click', async () => {
  const provider = $('provider').value;
  const apiKey = $('apiKey').value.trim();
  const statusEl = $('testKeyStatus');
  if (!apiKey) {
    statusEl.textContent = 'Enter an API key first.';
    statusEl.style.color = '#a11212';
    return;
  }
  $('testKeyBtn').disabled = true;
  statusEl.textContent = 'Testing…';
  statusEl.style.color = '#666';
  try {
    const models = await fetchModels(provider, apiKey);
    statusEl.textContent = `✓ Key is valid for ${provider} — ${models.length} model(s) visible to this key.`;
    statusEl.style.color = '#0b7a2b';
  } catch (e) {
    statusEl.textContent = `✗ Key test failed: ${e.message}`;
    statusEl.style.color = '#a11212';
  }
  $('testKeyBtn').disabled = false;
});

load();
