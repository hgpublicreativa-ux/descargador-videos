const { app, BrowserWindow, Menu, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');
const { resolveYtdlp, maybeUpdate } = require('./updater');

const PORT = 51739;
const HOST = '127.0.0.1';

function resolveBinary(name) {
  // Empaquetada: electron-builder fusiona con lipo los binarios arch-specific de
  // resources/bin/${arch}/ en un único binario universal en Resources/bin/<name>.
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'bin', name);
    if (fs.existsSync(p)) return p;
  }
  // Desarrollo: usa los binarios descargados en resources/bin/<arch>/ del repo
  // (yt-dlp vive en resources/bin/yt-dlp_macos/ porque ya es universal).
  const devArchDir = path.join(__dirname, 'resources', 'bin', process.arch, name);
  const devFlat = path.join(__dirname, 'resources', 'bin', name);
  if (fs.existsSync(devArchDir)) return devArchDir;
  if (fs.existsSync(devFlat)) return devFlat;
  return name; // último recurso: confiar en el PATH del sistema
}

// Navegadores de los que yt-dlp puede leer la sesión iniciada del usuario. Solo se ofrecen
// los que están instalados: pasarle a yt-dlp uno que no existe es un error duro. Safari va el
// último porque leer sus cookies exige Acceso a Disco Completo y casi siempre falla.
const BROWSER_APPS = [
  ['chrome', '/Applications/Google Chrome.app'],
  ['brave', '/Applications/Brave Browser.app'],
  ['edge', '/Applications/Microsoft Edge.app'],
  ['vivaldi', '/Applications/Vivaldi.app'],
  ['firefox', '/Applications/Firefox.app'],
  ['safari', '/Applications/Safari.app'],
];

function detectBrowsers() {
  return BROWSER_APPS.filter(([, appPath]) => fs.existsSync(appPath)).map(([name]) => name);
}

function waitForServer(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume();
      resolve();
    }).on('error', () => {
      if (attempt > 40) return reject(new Error('El servidor local no respondió a tiempo'));
      setTimeout(() => waitForServer(url, attempt + 1).then(resolve, reject), 150);
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 700,
    minWidth: 420,
    minHeight: 560,
    title: 'Descargador de Videos',
    icon: path.join(__dirname, 'assets', 'icon-1024.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadURL(`http://${HOST}:${PORT}`);

  // Los enlaces externos (si los hubiera) se abren en el navegador del sistema, no dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Menú mínimo: sin esto, atajos como Cmd+V (pegar el link) no funcionan de forma
// fiable dentro del BrowserWindow en macOS.
function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Deshacer' },
        { role: 'redo', label: 'Rehacer' },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' },
        { role: 'selectAll', label: 'Seleccionar todo' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  process.env.HOST = HOST;
  process.env.PORT = String(PORT);
  // yt-dlp va en su versión "carpeta" (yt-dlp_macos/yt-dlp_macos + _internal/). La de un
  // solo archivo se descomprime en una carpeta temporal nueva en cada ejecución y macOS la
  // vuelve a revisar entera cada vez: ~30 s de espera antes de cada descarga. La de carpeta
  // solo se revisa la primera vez y luego arranca en menos de un segundo.
  const bundledYtdlp = resolveBinary(path.join('yt-dlp_macos', 'yt-dlp_macos'));
  const userDataDir = app.getPath('userData');
  // Si ya hay una copia descargada más nueva en userData, esa manda sobre la empaquetada.
  process.env.YTDLP_PATH = resolveYtdlp(bundledYtdlp, userDataDir);
  process.env.FFMPEG_PATH = resolveBinary('ffmpeg');
  process.env.FFPROBE_PATH = resolveBinary('ffprobe');
  // yt-dlp necesita un runtime JS para resolver los retos de YouTube. La app empaquetada
  // no hereda el PATH del shell (Finder solo da /usr/bin:/bin:/usr/sbin:/sbin), asi que un
  // node instalado en /usr/local/bin o /opt/homebrew/bin nunca se encuentra. Electron ya
  // lleva node dentro: su propio binario, arrancado con ELECTRON_RUN_AS_NODE=1, sirve de
  // runtime sin depender de nada instalado en el Mac del usuario.
  process.env.JS_RUNTIME_PATH = process.execPath;
  // YouTube e Instagram piden sesión iniciada cada vez más a menudo. En escritorio no hay
  // variable de entorno con cookies como en Railway, pero sí está el navegador del propio
  // usuario: server.js lo usa solo como reintento cuando la descarga falla por falta de
  // sesión, para no pedir permiso al Llavero en cada descarga que iba a funcionar igual.
  process.env.COOKIES_FROM_BROWSER = detectBrowsers().join(',');

  for (const bin of [process.env.YTDLP_PATH, process.env.FFMPEG_PATH, process.env.FFPROBE_PATH]) {
    if (fs.existsSync(bin)) {
      try { fs.chmodSync(bin, 0o755); } catch (e) { /* ya tiene permisos o es del sistema */ }
    }
  }

  require('./server.js');
  buildMenu();

  // Guarda directo en Descargas sin preguntar nada: sin diálogo de "Guardar como",
  // sin banner de confirmación. Si ya existe un archivo con ese nombre, agrega (1), (2)...
  session.defaultSession.on('will-download', (event, item) => {
    const downloadsDir = app.getPath('downloads');
    const { name, ext } = path.parse(item.getFilename());
    let savePath = path.join(downloadsDir, item.getFilename());
    let counter = 1;
    while (fs.existsSync(savePath)) {
      savePath = path.join(downloadsDir, `${name} (${counter})${ext}`);
      counter++;
    }
    item.setSavePath(savePath);
  });

  try {
    await waitForServer(`http://${HOST}:${PORT}`);
  } catch (e) {
    console.error(e);
  }
  createWindow();

  // Sin await a propósito: la ventana ya está abierta y la descarga (38 MB) no debe
  // retrasar el arranque. Lo que se baje entra en vigor en el siguiente arranque.
  // La primera ejecución de un yt-dlp nuevo tarda (macOS lo revisa una sola vez). Se lanza
  // ya en segundo plano para que esa espera ocurra mientras el usuario pega el link y no
  // en su primera descarga.
  execFile(process.env.YTDLP_PATH, ['--version'], { timeout: 180000 }, () => {});

  maybeUpdate({
    userDataDir,
    currentBinPath: process.env.YTDLP_PATH,
    log: (msg) => console.log(`[yt-dlp] ${msg}`),
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
