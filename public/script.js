const form = document.getElementById('downloadForm');
const urlInput = document.getElementById('urlInput');
const downloadBtn = document.getElementById('downloadBtn');
const status = document.getElementById('status');
const loader = document.getElementById('loader');

const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
const supportsWebShare = navigator.share && isMobile;

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
      const data = await response.json();
      throw new Error(data.error || 'Error al descargar');
    }

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="(.+?)"/);
    const filename = match ? match[1] : 'video.mp4';

    // En móviles, usar Web Share API para guardar directo a galería
    if (supportsWebShare) {
      try {
        const file = new File([blob], filename, { type: 'video/mp4' });
        await navigator.share({
          files: [file],
          title: 'Guardar video',
          text: filename
        });
      } catch (shareErr) {
        // Si Web Share falla, usar descarga estándar
        descargarArchivo(blob, filename);
      }
    } else {
      // En escritorio o si Web Share no está disponible
      descargarArchivo(blob, filename);
    }

    loader.classList.add('hidden');
    status.classList.remove('hidden', 'error', 'info');
    status.classList.add('success');
    status.innerHTML = `✅ <strong>Video descargado correctamente</strong>`;
    urlInput.value = '';

  } catch (error) {
    loader.classList.add('hidden');
    status.classList.remove('hidden', 'success', 'info');
    status.classList.add('error');
    status.innerHTML = `❌ ${error.message}`;
  } finally {
    downloadBtn.disabled = false;
  }
});

function descargarArchivo(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
