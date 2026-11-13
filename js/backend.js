/* Clean Republic CRM — слой данных.
 * Даёт приложению один и тот же интерфейс (db / assets / downloads) поверх:
 *   • Firebase (Auth + Firestore) — рабочий режим;
 *   • памяти браузера — демо-режим (?demo), ничего не сохраняется.
 * Фото хранятся в Firestore (коллекция photos, сжатый JPEG в base64),
 * поэтому хватает бесплатного тарифа Spark — Cloud Storage не нужен.
 */
import { firebaseConfig } from '../firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2';
const MAX_PHOTO_CHARS = 900_000; // лимит документа Firestore — 1 МБ

export const isDemo = new URLSearchParams(location.search).has('demo');
export const isConfigured = !!(firebaseConfig && firebaseConfig.apiKey && !/^ВСТАВЬТЕ|^PASTE/i.test(firebaseConfig.apiKey));

/* ---------- общие помощники ---------- */
const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
async function shrink(blob) {
  let url = await blobToDataUrl(blob);
  if (url.length <= MAX_PHOTO_CHARS) return url;
  const bmp = await createImageBitmap(blob);
  for (const [side, q] of [[1280, .75], [1024, .7], [800, .65], [640, .6]]) {
    const s = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    url = c.toDataURL('image/jpeg', q);
    if (url.length <= MAX_PHOTO_CHARS) return url;
  }
  throw Object.assign(new Error('фото слишком большое'), { code: 'too-large' });
}
/** Превью ~300px (~15–30 КБ) для списков, чтобы не качать полные фото */
async function thumb(blob) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, 300 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', .72);
}
const THUMB = '-t'; // превью хранится рядом: photos/<id>-t
const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
const downloads = {
  async save({ filename, data }) {
    const file = new File([data], filename, { type: data.type || 'application/pdf' });
    if (isMobile() && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return; }
      catch (e) {
        if (e && e.name === 'AbortError') throw Object.assign(e, { code: 'declined' });
        // iOS забывает нажатие, пока PDF собирается: просим нажать ещё раз
        if (e && e.name === 'NotAllowedError') throw Object.assign(new Error('нужно нажать ещё раз'), { code: 'needs-tap',
          share: () => navigator.share({ files: [file], title: filename }) });
      }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  }
};

/* ---------- Firebase ---------- */
async function firebaseSession(ui) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${FB}/firebase-app.js`), import(`${FB}/firebase-auth.js`), import(`${FB}/firebase-firestore.js`)]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app); auth.languageCode = 'ru';
  const fs = F.getFirestore(app);

  const snapOf = s => ({ id: s.id, exists: s.exists(), data: () => s.data() });
  const wrapRef = r => ({
    id: r.id,
    get: async () => snapOf(await F.getDoc(r)),
    set: d => F.setDoc(r, d),
    update: d => F.updateDoc(r, d),
    delete: () => F.deleteDoc(r),
    onSnapshot: (cb, err) => F.onSnapshot(r, { includeMetadataChanges: true }, s => cb(snapOf(s)), err),
  });
  const col = (path, cons = []) => ({
    orderBy: (f, dir = 'asc') => col(path, [...cons, F.orderBy(f, dir)]),
    limit: n => col(path, [...cons, F.limit(n)]),
    doc: id => wrapRef(id ? F.doc(fs, path, id) : F.doc(F.collection(fs, path))),
    onSnapshot: (cb, err) => F.onSnapshot(F.query(F.collection(fs, path), ...cons), { includeMetadataChanges: true },
      s => cb({ docs: s.docs.map(snapOf), metadata: { fromCache: s.metadata.fromCache } }), err),
  });
  const db = {
    doc: path => wrapRef(F.doc(fs, path)),
    collection: path => col(path),
    nextNumber: () => F.runTransaction(fs, async tx => {
      const r = F.doc(fs, 'meta/counter'); const s = await tx.get(r);
      const n = (s.exists() ? +s.data().n || 0 : 0) + 1; tx.set(r, { n }); return n;
    }),
  };

  const cache = new Map();
  const assets = {
    async upload(blob) {
      const [data, small] = await Promise.all([shrink(blob), thumb(blob).catch(() => null)]);
      const r = F.doc(F.collection(fs, 'photos')); const meta = { createdAt: Date.now(), by: auth.currentUser?.uid || '' };
      const batch = F.writeBatch(fs); batch.set(r, { data, ...meta });
      if (small) batch.set(F.doc(fs, 'photos', r.id + THUMB), { data: small, ...meta });
      await batch.commit();
      cache.set(r.id, Promise.resolve(data)); if (small) cache.set(r.id + THUMB, Promise.resolve(small));
      return { id: r.id };
    },
    /** small=true — превью; если превью нет (старые фото), берётся полное */
    get(id, small) {
      const key = small ? id + THUMB : id;
      if (!cache.has(key)) cache.set(key, F.getDoc(F.doc(fs, 'photos', key)).then(s => s.exists() ? s.data().data : null)
        .then(u => u || (small ? assets.get(id) : null))
        .catch(e => { cache.delete(key); throw e; }));
      return cache.get(key);
    },
  };

  const signIn = async () => {
    const p = new A.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
    try { await A.signInWithPopup(auth, p); }
    catch (e) {
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') return A.signInWithRedirect(auth, p);
      if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') ui.error('Не удалось войти: ' + (e.code || e.message));
    }
  };
  const signOut = () => A.signOut(auth);

  return new Promise(resolve => {
    let started = false;
    A.onAuthStateChanged(auth, async user => {
      if (started) { location.reload(); return; }       // вышли или сменили аккаунт
      if (!user) return ui.needLogin(signIn);
      const email = (user.email || '').toLowerCase();
      let staff = null, reason = 'not-in-staff';
      try { const s = await F.getDoc(F.doc(fs, 'staff', email)); staff = s.exists() ? s.data() : null; }
      catch (e) { reason = e.code || 'error'; console.error(e); }
      if (!staff) return ui.noAccess(email, signOut, reason);
      started = true;
      resolve({ db, assets, downloads, signOut, demo: false,
        user: { uid: user.uid, email, name: staff.name || user.displayName || email, role: staff.role === 'admin' ? 'admin' : 'staff' } });
    });
  });
}

/* ---------- Демо: всё в памяти ---------- */
function demoSession() {
  const store = new Map(); const subs = new Set();
  const clone = v => v === undefined ? v : JSON.parse(JSON.stringify(v));
  const rid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  const notify = () => queueMicrotask(() => subs.forEach(f => f()));
  const snap = path => ({ id: path.split('/').pop(), exists: store.has(path), data: () => clone(store.get(path)) });
  const ref = path => ({
    id: path.split('/').pop(),
    get: async () => snap(path),
    set: async d => { store.set(path, clone(d)); notify(); },
    update: async d => { if (!store.has(path)) throw Object.assign(new Error('not found'), { code: 'not-found' }); store.set(path, { ...store.get(path), ...clone(d) }); notify(); },
    delete: async () => { store.delete(path); notify(); },
    onSnapshot: cb => { const f = () => cb(snap(path)); subs.add(f); f(); return () => subs.delete(f); },
  });
  const col = (path, o = {}) => ({
    orderBy: (f, dir = 'asc') => col(path, { ...o, f, dir }),
    limit: n => col(path, { ...o, n }),
    doc: id => ref(path + '/' + (id || rid())),
    onSnapshot: cb => {
      const depth = path.split('/').length + 1;
      const f = () => {
        let docs = [...store.keys()].filter(k => k.startsWith(path + '/') && k.split('/').length === depth).map(snap);
        if (o.f) docs.sort((a, b) => { const x = a.data()[o.f], y = b.data()[o.f]; return (x > y ? 1 : x < y ? -1 : 0) * (o.dir === 'desc' ? -1 : 1); });
        if (o.n) docs = docs.slice(0, o.n);
        cb({ docs, metadata: { fromCache: false } });
      };
      subs.add(f); f(); return () => subs.delete(f);
    },
  });
  let counter = 0; const photos = new Map();
  return Promise.resolve({
    demo: true, downloads, signOut: async () => location.reload(),
    user: { uid: 'demo', email: 'demo@example.com', name: 'Демо', role: 'admin' },
    db: { doc: ref, collection: col, nextNumber: async () => ++counter },
    assets: {
      async upload(blob) { const id = rid(); photos.set(id, await shrink(blob)); photos.set(id + THUMB, await thumb(blob)); return { id }; },
      async get(id, small) { return (small && photos.get(id + THUMB)) || photos.get(id) || null; },
    },
  });
}

/** Подключение. ui: { needLogin(signIn), noAccess(email, signOut), notConfigured(), error(msg) } */
export function connect(ui) {
  if (isDemo) return demoSession();
  if (!isConfigured) { ui.notConfigured(); return new Promise(() => {}); }
  return firebaseSession(ui);
}
