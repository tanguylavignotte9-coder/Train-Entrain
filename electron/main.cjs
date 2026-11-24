// Processus principal Electron : fenêtre du jeu et sauvegardes locales versionnées.
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const saveDir = () => path.join(app.getPath('userData'), 'saves');
const safe = slot => String(slot).replace(/[^a-zA-Z0-9_-]/g, '');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 720, minWidth: 960, minHeight: 540, backgroundColor: '#0c0a08', title: 'Train Entrain', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
    if (input.type === 'keyDown' && input.key === 'F12' && process.env.TRAIN_DEBUG) win.webContents.toggleDevTools();
  });
}

ipcMain.handle('save:write', async (_e, slot, data) => {
  fs.mkdirSync(saveDir(), { recursive: true });
  const file = path.join(saveDir(), `${safe(slot)}.json`);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.renameSync(tmp, file);
});
ipcMain.handle('save:read', async (_e, slot) => {
  const file = path.join(saveDir(), `${safe(slot)}.json`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
});
ipcMain.handle('save:list', async () => {
  if (!fs.existsSync(saveDir())) return [];
  return fs.readdirSync(saveDir()).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
});
ipcMain.handle('save:remove', async (_e, slot) => {
  const file = path.join(saveDir(), `${safe(slot)}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
