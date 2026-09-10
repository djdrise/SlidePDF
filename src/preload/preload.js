'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('deck', {
  /** Отправить команду в main-процесс. */
  cmd: (type, payload) => ipcRenderer.send('cmd', { type, payload }),

  /** Текущее состояние (при старте окна). */
  getState: () => ipcRenderer.invoke('state:get'),

  /** Размер документа по id вкладки: сами байты окно потом берёт кусками. */
  docSource: (id) => ipcRenderer.invoke('doc:source', id),

  /** Кусок документа [begin, end) — по нему pdf.js читает ровно нужное. */
  docRange: (id, begin, end) => ipcRenderer.invoke('doc:range', { id, begin, end }),

  /** Миниатюра из кэша на диске: data:URL или null, если её там нет. */
  thumbGet: (id, page, width) => ipcRenderer.invoke('thumb:get', { id, page, width }),

  /** Положить отрисованную миниатюру в кэш на диске. */
  thumbPut: (id, page, width, dataUrl) =>
    ipcRenderer.invoke('thumb:put', { id, page, width, dataUrl }),

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
