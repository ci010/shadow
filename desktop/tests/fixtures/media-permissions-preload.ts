import { contextBridge, ipcRenderer } from 'electron'
import { createMediaCaptureApi } from '../../src/media-capture-preload.js'

const mediaCapture = createMediaCaptureApi(
  ipcRenderer,
  () => navigator.userActivation.isActive,
)
contextBridge.exposeInMainWorld('mediaCapture', mediaCapture)
contextBridge.exposeInMainWorld('shadowDesktop', Object.freeze({ mediaCapture }))
