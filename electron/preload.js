// preload — contextBridge로 안전하게 IPC 노출 (renderer는 window.eapi만 사용)

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eapi', {
  // 디렉토리/모델
  pickModelDir:        ()            => ipcRenderer.invoke('pick-model-dir'),
  getDefaultModelsDir: ()            => ipcRenderer.invoke('get-default-models-dir'),
  scanModels:          (dir)         => ipcRenderer.invoke('scan-models', dir),

  // 병합 실행/취소
  startMerge:          (payload)     => ipcRenderer.invoke('start-merge', payload),
  cancelMerge:         ()            => ipcRenderer.send('cancel-merge'),

  // 스트림 이벤트
  onLog:   (cb) => ipcRenderer.on('fusion:log',   (_e, line, cls)   => cb(line, cls)),
  onVram:  (cb) => ipcRenderer.on('fusion:vram', (_e, usedMB)      => cb(usedMB)),
  onGpuName: (cb) => ipcRenderer.on('fusion:gpu', (_e, name)         => cb && cb(name)),
});
