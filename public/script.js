const form = document.getElementById('downloadForm');
const urlInput = document.getElementById('urlInput');
const downloadBtn = document.getElementById('downloadBtn');
const status = document.getElementById('status');
const loader = document.getElementById('loader');

const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const url = urlInput.value.trim();
  if (!url) return;

  downloadBtn.disabled = true;
  status.classList.add('hidden');
  loader.classList.remove('hidden');
  loader.innerHTML = '<span></span><span></span><span></span>';

  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    if (!response.ok) {
      let message = `Error al descargar (código ${response.status})`;
      try {
        const data = await response.json();
        if (data.error) message = data.error;
      } catch (_) {
        if (response.status === 502 || response.status === 504) {
          message = 'El servidor tardó demasiado. Prueba con un video más corto o intenta de nuevo.';
        }
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="(.+?)"/);
    const filename = match ? match[1] : 'video.mp4';
    const file = new File([blob], filename, { type: 'video/mp4' });

    loader.classList.add('hidden');
    urlInput.value = '';

    // En móviles, compartir permite "Guardar video" directo en la galería.
    // El navegador exige que el usuario toque un botón justo antes de
    // compartir, así que mostramos un botón cuando el video ya está listo.
    if (isMobile && navigator.canShare && navigator.canShare({ files: [file] })) {
      mostrarBotonGuardar(file, blob, filename);
    } else {
      descargarArchivo(blob, filename);
      mostrarExito('✅ <strong>Video descargado correctamente</strong>');
    }

  } catch (error) {
    loader.classList.add('hidden');
    status.classList.remove('hidden', 'success', 'info');
    status.classList.add('error');
    status.textContent = `❌ ${error.message}`;
  } finally {
    downloadBtn.disabled = false;
  }
});

function mostrarExito(html) {
  status.classList.remove('hidden', 'error', 'info');
  status.classList.add('success');
  status.innerHTML = html;
}

function mostrarBotonGuardar(file, blob, filename) {
  mostrarExito('✅ <strong>Video listo</strong><br><button type="button" class="save-btn">Guardar en galería</button>');
  status.querySelector('.save-btn').addEventListener('click', async () => {
    try {
      await navigator.share({ files: [file], title: 'Guardar video' });
    } catch (err) {
      if (err.name === 'AbortError') return; // el usuario canceló
      descargarArchivo(blob, filename);
    }
  });
}

function descargarArchivo(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Esperar antes de liberar el blob: Safari lo necesita para iniciar la descarga.
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
