// Actualización de yt-dlp para la app de escritorio.
//
// El binario que va dentro del .app se congela el día del build, pero las plataformas cambian
// cada pocas semanas y cada cambio deja la app rota hasta el siguiente DMG (TikTok se rompió
// así el 2026-08-10). Railway no sufre esto porque su Dockerfile descarga la última versión en
// cada deploy; aquí replicamos ese "siempre al día" guardando una copia actualizable en
// userData y usándola con preferencia sobre la empaquetada.
//
// No se toca nunca el binario de dentro del .app: no hay permiso de escritura en
// /Applications y modificarlo invalidaría el bundle. La copia de userData es solo del usuario.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

const RELEASE_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const ASSET_NAME = 'yt-dlp_macos';
const SUMS_NAME = 'SHA2-256SUMS';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// GitHub rechaza las peticiones sin User-Agent.
const UA = 'descargador-videos (+https://github.com/hgpublicreativa-ux/descargador-videos)';

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Demasiadas redirecciones'));
    https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      // Los assets de release redirigen a objects.githubusercontent.com.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} en ${url}`));
      }
      resolve(res);
    }).on('error', reject);
  });
}

async function getText(url) {
  const res = await get(url);
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Descarga a disco calculando el sha256 al vuelo, para no leer 38 MB dos veces.
async function downloadTo(url, dest) {
  const res = await get(url);
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.on('data', (chunk) => hash.update(chunk));
    res.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.on('error', reject);
  });
  return hash.digest('hex');
}

function versionOf(binPath) {
  return new Promise((resolve) => {
    execFile(binPath, ['--version'], { timeout: 30000 }, (err, stdout) => {
      resolve(err ? null : (stdout || '').trim());
    });
  });
}

function managedPath(userDataDir) {
  return path.join(userDataDir, 'bin', 'yt-dlp');
}

// Qué binario usar en este arranque. La copia descargada manda; si no existe o no es
// ejecutable, se cae a la que viene dentro del .app.
function resolveYtdlp(bundledPath, userDataDir) {
  const managed = managedPath(userDataDir);
  try {
    fs.accessSync(managed, fs.constants.X_OK);
    return managed;
  } catch {
    return bundledPath;
  }
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

// Comprueba y, si toca, descarga. Pensado para llamarse sin await desde el arranque: nunca
// lanza, solo informa por `log`. La versión nueva entra en vigor en el siguiente arranque,
// que es más seguro que cambiar el binario con descargas en curso.
async function maybeUpdate({ userDataDir, currentBinPath, log = () => {}, force = false }) {
  const statePath = path.join(userDataDir, 'ytdlp-update.json');
  const state = readState(statePath);

  if (!force && state.lastCheck && Date.now() - state.lastCheck < CHECK_INTERVAL_MS) {
    return { skipped: 'comprobado hace menos de 24 h' };
  }

  try {
    const release = JSON.parse(await getText(RELEASE_API));
    const latest = release.tag_name;
    const current = await versionOf(currentBinPath);

    // Se escribe la marca de tiempo aunque no haya nada que hacer, para no repetir la
    // consulta en cada arranque.
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ ...state, lastCheck: Date.now(), latest, current }));

    if (!latest || latest === current) {
      log(`yt-dlp al día (${current || 'versión desconocida'})`);
      return { upToDate: true, version: current };
    }

    log(`yt-dlp ${current} → ${latest}, descargando…`);

    const asset = (release.assets || []).find((a) => a.name === ASSET_NAME);
    const sums = (release.assets || []).find((a) => a.name === SUMS_NAME);
    if (!asset || !sums) throw new Error(`La release ${latest} no trae ${ASSET_NAME}`);

    const expected = (await getText(sums.browser_download_url))
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(([, name]) => name === ASSET_NAME)?.[0];
    if (!expected) throw new Error(`Sin sha256 publicado para ${ASSET_NAME}`);

    const binDir = path.join(userDataDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const tmp = path.join(binDir, 'yt-dlp.part');

    const actual = await downloadTo(asset.browser_download_url, tmp);
    if (actual !== expected) {
      fs.unlinkSync(tmp);
      throw new Error(`sha256 no coincide (esperado ${expected.slice(0, 12)}…, obtenido ${actual.slice(0, 12)}…)`);
    }

    fs.chmodSync(tmp, 0o755);

    // Antes de promoverlo: que arranque de verdad. Un binario corrupto o bloqueado por
    // Gatekeeper dejaría la app peor de lo que estaba.
    const check = await versionOf(tmp);
    if (!check) {
      fs.unlinkSync(tmp);
      throw new Error('El binario descargado no se ejecuta');
    }

    fs.renameSync(tmp, managedPath(userDataDir));
    fs.writeFileSync(statePath, JSON.stringify({ lastCheck: Date.now(), latest, current: check }));
    log(`yt-dlp actualizado a ${check}; se usará en el próximo arranque`);
    return { updated: true, version: check };
  } catch (e) {
    // Sin red, GitHub caído o release rara: seguimos con el binario que ya teníamos.
    log(`No se pudo actualizar yt-dlp: ${e.message}`);
    return { error: e.message };
  }
}

module.exports = { resolveYtdlp, maybeUpdate, managedPath };
