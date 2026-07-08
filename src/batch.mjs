export function chunkItems(items, { size = 60 } = {}) {
  if (!Array.isArray(items)) throw new TypeError('chunkItems: items must be an array');
  const n = Math.max(1, Math.floor(Number(size) || items.length || 1));
  const chunks = [];
  for (let i = 0; i < items.length; i += n) chunks.push(items.slice(i, i + n));
  return chunks;
}

export function buildIndexedJsonBatch(items, {
  model,
  chunkSize = 60,
  makePrompt,
  maxTokens = 384,
  temperature = 0,
  responseFormat = { type: 'json_object' },
} = {}) {
  if (!model) throw new Error('buildIndexedJsonBatch: model is required');
  if (typeof makePrompt !== 'function') throw new TypeError('buildIndexedJsonBatch: makePrompt must be a function');
  const chunks = chunkItems(items, { size: chunkSize });
  const requests = chunks.map((chunk, chunkIndex) => ({
    model,
    temperature,
    max_tokens: maxTokens,
    response_format: responseFormat,
    messages: [{
      role: 'user',
      content: makePrompt(chunk, { chunkIndex, offset: chunkIndex * Math.max(1, Math.floor(Number(chunkSize) || 1)) }),
    }],
  }));
  return { chunks, requests };
}

export function parseIndexedJsonList(text, labels, { key = 'matches' } = {}) {
  if (!Array.isArray(labels)) throw new TypeError('parseIndexedJsonList: labels must be an array');
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const json = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  let parsed;
  try { parsed = JSON.parse(json); } catch { throw new Error('parseIndexedJsonList: response is not JSON'); }
  const values = parsed?.[key];
  if (!Array.isArray(values)) throw new Error(`parseIndexedJsonList: response is missing ${key}[]`);

  const indexes = new Set();
  const exact = new Set();
  for (const item of values) {
    if (Number.isInteger(item) && item >= 0 && item < labels.length) {
      indexes.add(item);
      continue;
    }
    const s = String(item).trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (n >= 0 && n < labels.length) indexes.add(n);
      continue;
    }
    const numbered = s.match(/^(\d+)\.\s*(.+)$/);
    if (numbered) {
      const n = Number(numbered[1]);
      if (n >= 0 && n < labels.length && labels[n] === numbered[2].trim()) indexes.add(n);
      continue;
    }
    exact.add(s);
  }
  return labels.filter((label, index) => indexes.has(index) || exact.has(label));
}
