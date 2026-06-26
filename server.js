const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const tempDir = os.tmpdir();
const ytdlp = fs.existsSync('/app/yt-dlp') ? '/app/yt-dlp' : 'yt-dlp';

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

  const id = crypto.randomBytes(8).toString('hex');
  const outputPath = path.join(tempDir, `video_${id}.mp4`);

  const command = `${ytdlp} -f "bestvideo[vcodec^=avc]+bestaudio/best[vcodec^=avc]/hd/sd/best" --merge-output-format mp4 -o "${outputPath}" "${url}"`;

  exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error.message}`);
      return res.status(500).json({
        error: 'Error al descargar el video',
        details: error.message
      });
    }

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'No se encontró el archivo descargado' });
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="video_${platform.toLowerCase()}_${id}.mp4"`);
    res.setHeader('Content-Length', fs.statSync(outputPath).size);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);

    stream.on('end', () => {
      fs.unlink(outputPath, () => {});
    });

    stream.on('error', (err) => {
      console.error('Stream error:', err);
      fs.unlink(outputPath, () => {});
    });
  });
});

app.listen(PORT, () => {
  console.log(`\n🎬 Descargador de videos corriendo en http://localhost:${PORT}\n`);
});
