const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('trainAPI', {
  save: (slot, data) => ipcRenderer.invoke('save:write', slot, data),
  load: slot => ipcRenderer.invoke('save:read', slot),
  list: () => ipcRenderer.invoke('save:list'),
  remove: slot => ipcRenderer.invoke('save:remove', slot),
});
