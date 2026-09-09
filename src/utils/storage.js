/**
 * Storage & Configuration Utility
 * Quản lý cấu hình thư mục lưu trữ, tùy chọn tải và FileSystemHandle (nếu dùng thư mục tùy chọn trên ổ đĩa).
 */

export const DEFAULT_SETTINGS = {
  customFolder: 'Udemy Courses', // Thư mục con trong thư mục Downloads
  promptSaveAs: false,           // Bật/tắt hộp thoại hỏi vị trí lưu mỗi lần tải
  downloadMode: 'browser',       // 'browser' (thông qua Downloads API) hoặc 'filesystem' (ghi thẳng vào thư mục ổ đĩa đã chọn)
  autoHighestQuality: true,      // Tự động chọn chất lượng cao nhất
  displayMode: 'sidebar',        // 'sidebar' (thanh bên Chrome bên phải) hoặc 'window' (cửa sổ nổi độc lập)
  autoRecordDrm: false,          // Tự động ghi Engine 2 khi gặp bài DRM trong Auto-Batch
  drmSpeed: '1.0',               // Tốc độ phát khi ghi bài DRM ('1.0', '1.5', '2.0')
  drmMuteSpeaker: true           // Tắt tiếng ra loa ngoài máy tính khi ghi tự động
};

/**
 * Lấy cấu hình hiện tại từ chrome.storage.local
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      resolve({ ...DEFAULT_SETTINGS, ...items });
    });
  });
}

/**
 * Lưu cấu hình vào chrome.storage.local
 * @param {Partial<typeof DEFAULT_SETTINGS>} newSettings 
 * @returns {Promise<void>}
 */
export async function saveSettings(newSettings) {
  return new Promise((resolve) => {
    chrome.storage.local.set(newSettings, () => {
      resolve();
    });
  });
}

// ============================================================================
// IndexedDB Helper để lưu trữ FileSystemDirectoryHandle (File System Access API)
// Chrome không cho phép lưu Handle vào chrome.storage, nên ta dùng IndexedDB
// ============================================================================
const DB_NAME = 'UdemyDownloaderDB';
const DB_VERSION = 1;
const STORE_NAME = 'handles';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Lưu FileSystemDirectoryHandle vào IndexedDB
 * @param {FileSystemDirectoryHandle} dirHandle 
 */
export async function saveDirectoryHandle(dirHandle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(dirHandle, 'selectedDirectory');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Lấy FileSystemDirectoryHandle đã lưu từ IndexedDB
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function getDirectoryHandle() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get('selectedDirectory');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn('Không thể đọc IndexedDB:', err);
    return null;
  }
}

/**
 * Xóa FileSystemDirectoryHandle đã lưu
 */
export async function clearDirectoryHandle() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete('selectedDirectory');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (err) {
    console.warn('Lỗi khi xóa directory handle:', err);
  }
}
