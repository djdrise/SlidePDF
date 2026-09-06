'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('deck', {
  /** Отправить команду в main-процесс. */
  cmd: (type, payload) => ipcRenderer.send('cmd', { type, payload }),

  /** Текущее состояние (при старте окна). */
  getState: () => ipcRenderer.invoke('state:get'),

  /** Байты документа по id вкладки: каждое окно рендерит PDF само. */
  docBytes: (id) => ipcRenderer.invoke('doc:bytes', id),

  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('state', h);
    return () => ipcRenderer.off('state', h);
  },

  /** Путь к файлу из drag&drop: File.path в Electron больше не доступен. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
});
