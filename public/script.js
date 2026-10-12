const form = document.getElementById('downloadForm');
const urlInput = document.getElementById('urlInput');
const downloadBtn = document.getElementById('downloadBtn');
const status = document.getElementById('status');
const queueSection = document.getElementById('queueSection');
const queueList = document.getElementById('queueList');
const queueProgress = document.getElementById('queueProgress');
const clearQueueBtn = document.getElementById('clearQueueBtn');

const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
const supportsWebShare = () => !!navigator.share && isMobile;

const MAX_AUTO_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      ${item.state === 'error' ? `<button type="button" class="queue-retry" data-id="${item.id}">Reintentar</button>` : ''}
      ${item.file ? `<button type="button" class="queue-retry queue-save" data-id="${item.id}">Guardar</button>` : ''}
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

  queueList.querySelectorAll('.queue-retry').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const item = queue.find((i) => i.id === id);
      if (!item) return;
      item.state = 'esperando';
      item.message = '';
      renderQueue();
      processQueue();
    });
  });

  // En móvil el navegador solo deja compartir justo después de un toque del usuario, y la
  // descarga tarda: por eso el botón "Guardar" abre el menú de compartir (Guardar video).
  queueList.querySelectorAll('.queue-save').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = queue.find((i) => i.id === Number(btn.dataset.id));
      if (!item || !item.file) return;
      try {
        await navigator.share({ files: [item.file], title: 'Guardar video' });
        item.file = null;
        item.message = '';
        renderQueue();
      } catch (err) {
        if (err.name !== 'AbortError') descargarArchivo(item.file, item.file.name);
      }
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

    let lastError = null;
    let success = false;

    for (let attempt = 1; attempt <= MAX_AUTO_RETRIES && !success; attempt++) {
      if (attempt > 1) {
        next.message = `Reintentando… (${attempt}/${MAX_AUTO_RETRIES})`;
        renderQueue();
        await sleep(RETRY_DELAY_MS);
      }
      try {
        const pendingFile = await downloadOne(next.url);
        if (pendingFile) {
          next.file = pendingFile;
          next.message = 'Listo: toca Guardar';
        }
        success = true;
      } catch (err) {
        lastError = err;
        // Errores de validación (URL/plataforma inválida) son permanentes: no reintentar.
        if (err.retryable === false) break;
      }
    }

    if (success) {
      next.state = 'completado';
      if (!next.file) next.message = '';
    } else {
      next.state = 'error';
      next.message = (lastError && lastError.message) || 'Error al descargar';
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
    const fallback = response.status === 502 || response.status === 504
      ? 'El servidor tardó demasiado. Prueba con un video más corto.'
      : `Error al descargar (código ${response.status})`;
    const error = new Error(data.error || fallback);
    // 4xx = URL o plataforma inválida: no cambia entre reintentos, no vale la pena reintentar.
    error.retryable = response.status >= 500 && data.retryable !== false;
    throw error;
  }

  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="(.+?)"/);
  const filename = match ? match[1] : 'video.mp4';

  if (supportsWebShare()) {
    const file = new File([blob], filename, { type: 'video/mp4' });
    if (!navigator.canShare || navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Guardar video' });
        return null;
      } catch (shareErr) {
        if (shareErr.name === 'AbortError') return null; // el usuario canceló
        // NotAllowedError: pasó demasiado tiempo desde el toque del usuario. Se deja el
        // archivo pendiente para que lo guarde con el botón "Guardar".
        if (shareErr.name === 'NotAllowedError') return file;
      }
    }
  }

  descargarArchivo(blob, filename);
  return null;
}

function descargarArchivo(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Esperar antes de liberar el blob: Safari y Firefox lo necesitan para iniciar la descarga.
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
