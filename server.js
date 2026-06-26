const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const downloadDir = path.join(os.homedir(), 'Downloads');

function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube';
  if (url.includes('tiktok.com')) return 'TikTok';
  if (url.includes('instagram.com')) return 'Instagram';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'Facebook';
  return null;
}

app.post('/api/download', (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL es requerida' });
  }

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({ error: 'Plataforma no soportada' });
  }

  const outputTemplate = path.join(downloadDir, '%(upload_date)s_%(id)s.%(ext)s');

  const command = `yt-dlp -f "bestvideo[vcodec^=avc]+bestaudio/best[vcodec^=avc]/hd/sd/best" --merge-output-format mp4 -o "${outputTemplate}" "${url}"`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error.message}`);
      return res.status(500).json({
        error: 'Error al descargar el video',
        details: error.message
      });
    }

    const match = stdout.match(/\[download\] Destination: (.+)/);
    const filePath = match ? match[1] : null;

    if (filePath && fs.existsSync(filePath)) {
      res.json({
        success: true,
        platform,
        message: `Video de ${platform} descargado en Descargas`,
        filePath
      });
    } else {
      res.json({
        success: true,
        platform,
        message: `Video de ${platform} descargado en tu carpeta de Descargas`
      });
    }
  });
});

app.listen(PORT, () => {
  console.log(`\n🎬 Descargador de videos corriendo en http://localhost:${PORT}`);
  console.log(`📁 Los videos se guardarán en: ${downloadDir}\n`);
});
