const form = document.getElementById('downloadForm');
const urlInput = document.getElementById('urlInput');
const downloadBtn = document.getElementById('downloadBtn');
const status = document.getElementById('status');
const queueSection = document.getElementById('queueSection');
const queueList = document.getElementById('queueList');
const queueProgress = document.getElementById('queueProgress');
const clearQueueBtn = document.getElementById('clearQueueBtn');

const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
const supportsWebShare = navigator.share && isMobile;

// Cada item: { id, url, state: 'esperando'|'descargando'|'completado'|'error', message }
let queue = [];
let processing = false;
let nextId = 1;

const STATE_LABEL = {
  esperando: { icon: '⏳', text: 'En espera' },
  descargando: { icon: '⬇️', text: 'Descargando…' },
  completado: { icon: '✅', text: 'Completado' },
  error: { icon: '❌', text: 'Error' },
};

form.addEventListener('submit', (e) => {
  e.preventDefault();

  const lines = urlInput.value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return;

  for (const url of lines) {
    queue.push({ id: nextId++, url, state: 'esperando', message: '' });
  }

  urlInput.value = '';
  status.classList.add('hidden');
  renderQueue();
  processQueue();
});

clearQueueBtn.addEventListener('click', () => {
  queue = queue.filter((item) => item.state !== 'completado' && item.state !== 'error');
  renderQueue();
});

function renderQueue() {
  if (queue.length === 0) {
    queueSection.classList.add('hidden');
    return;
  }

  queueSection.classList.remove('hidden');
  queueList.innerHTML = '';

  for (const item of queue) {
    const li = document.createElement('li');
    li.className = `queue-item queue-item--${item.state}`;

    const info = STATE_LABEL[item.state];
    const canRemove = item.state === 'esperando' || item.state === 'error' || item.state === 'completado';

    li.innerHTML = `
      <span class="queue-icon">${info.icon}</span>
      <span class="queue-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span>
      <span class="queue-state">${item.message ? escapeHtml(item.message) : info.text}</span>
      ${canRemove ? `<button type="button" class="queue-remove" data-id="${item.id}" aria-label="Quitar">✕</button>` : ''}
    `;

    queueList.appendChild(li);
  }

  queueList.querySelectorAll('.queue-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      queue = queue.filter((item) => item.id !== id);
      renderQueue();
    });
  });

  const done = queue.filter((i) => i.state === 'completado' || i.state === 'error').length;
  queueProgress.textContent = `${done}/${queue.length} procesados`;

  const hasFinished = queue.some((i) => i.state === 'completado' || i.state === 'error');
  clearQueueBtn.classList.toggle('hidden', !hasFinished);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  downloadBtn.disabled = false; // se puede seguir agregando mientras procesa

  let next;
  while ((next = queue.find((i) => i.state === 'esperando'))) {
    next.state = 'descargando';
    next.message = '';
    renderQueue();

    try {
      await downloadOne(next.url);
      next.state = 'completado';
      next.message = '';
    } catch (err) {
      next.state = 'error';
      next.message = err.message || 'Error al descargar';
    }

    renderQueue();
  }

  processing = false;
}

async function downloadOne(url) {
  const response = await fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Error al descargar');
  }

  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="(.+?)"/);
  const filename = match ? match[1] : 'video.mp4';

  if (supportsWebShare) {
    try {
      const file = new File([blob], filename, { type: 'video/mp4' });
      await navigator.share({ files: [file], title: 'Guardar video', text: filename });
      return;
    } catch (shareErr) {
      // si el usuario cancela o falla, usar descarga estándar
    }
  }

  descargarArchivo(blob, filename);
}

function descargarArchivo(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
