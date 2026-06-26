const form = document.getElementById('downloadForm');
const urlInput = document.getElementById('urlInput');
const downloadBtn = document.getElementById('downloadBtn');
const status = document.getElementById('status');
const loader = document.getElementById('loader');

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

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);

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

urlInput.addEventListener('paste', () => {
  setTimeout(() => {
    const url = urlInput.value.trim();
    if (url.includes('youtube.com') || url.includes('youtu.be') ||
        url.includes('tiktok.com') || url.includes('instagram.com') ||
        url.includes('facebook.com') || url.includes('fb.watch')) {
      form.dispatchEvent(new Event('submit'));
    }
  }, 10);
});
